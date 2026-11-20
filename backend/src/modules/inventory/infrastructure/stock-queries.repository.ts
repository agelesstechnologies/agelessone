import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, count, desc, eq, gte, inArray, lte, or, sql, SQL } from 'drizzle-orm';
import type { LocationType, ReturnCondition, StockDocumentStatus, StockDocumentType } from '@ageless/shared';
import { Conn, DB, Db } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { tickets } from '../../tickets/schema';
import { items, locations, partRequests, stockBalances, stockBatches, stockDocumentLines, stockDocuments, stockValuations, units } from '../schema';

const transit = aliasedTable(locations, 'transit_location');
const creator = aliasedTable(persons, 'creator');
const receiver = aliasedTable(persons, 'receiver');
const baseUnit = aliasedTable(units, 'base_unit');
const enteredUnit = aliasedTable(units, 'entered_unit');
const fromLocation = aliasedTable(locations, 'line_location');
const toLocation = aliasedTable(locations, 'line_to_location');

export interface DocumentFilter {
  companyIds: number[]; type?: StockDocumentType; status?: StockDocumentStatus; ticketId?: number; from?: string; to?: string;
  /** scope own: only documents with a line in these locations */
  onlyLocations?: number[];
}
export interface StockFilter { companyIds: number[]; itemId?: number; locationId?: number; onlyLocations?: number[]; includeEmpty?: boolean }

/** Reads stock documents, their lines and the stock on hand, with the names the API shows. Writes nothing. */
@Injectable()
export class StockQueriesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private summary(conn: Conn) {
    return conn.select({
      id: stockDocuments.id, publicId: stockDocuments.publicId, legalEntityId: stockDocuments.legalEntityId, company: legalEntities.code,
      type: sql<StockDocumentType>`${stockDocuments.type}`, number: stockDocuments.number, status: sql<StockDocumentStatus>`${stockDocuments.status}`,
      documentDate: stockDocuments.documentDate, supplierName: stockDocuments.supplierName,
      ticketPublicId: tickets.publicId, ticketNumber: tickets.number, ticketTitle: tickets.title,
      originalPublicId: sql<string | null>`(SELECT o.public_id::text FROM ${stockDocuments} o WHERE o.id = ${stockDocuments.originalDocumentId})`,
      originalNumber: sql<string | null>`(SELECT o.number FROM ${stockDocuments} o WHERE o.id = ${stockDocuments.originalDocumentId})`,
      originalType: sql<StockDocumentType | null>`(SELECT o.type FROM ${stockDocuments} o WHERE o.id = ${stockDocuments.originalDocumentId})`,
      reversalPublicId: sql<string | null>`(SELECT r.public_id::text FROM ${stockDocuments} r WHERE r.original_document_id = ${stockDocuments.id} AND r.type = 'reversal')`,
      requestPublicId: partRequests.publicId, requestNumber: partRequests.number,
      reversalNumber: sql<string | null>`(SELECT r.number FROM ${stockDocuments} r WHERE r.original_document_id = ${stockDocuments.id} AND r.type = 'reversal')`,
      lineCount: sql<number>`(SELECT count(*) FROM ${stockDocumentLines} l WHERE l.document_id = ${stockDocuments.id})::int`,
      totalValue: sql<string>`(SELECT coalesce(sum(l.value_minor), 0) FROM ${stockDocumentLines} l WHERE l.document_id = ${stockDocuments.id})::text`,
      currency: stockDocuments.currency, createdByPublicId: creator.publicId, createdByName: creator.displayName, createdAt: stockDocuments.createdAt,
    }).from(stockDocuments)
      .innerJoin(legalEntities, eq(legalEntities.id, stockDocuments.legalEntityId))
      .innerJoin(creator, eq(creator.id, stockDocuments.createdBy))
      .leftJoin(tickets, eq(tickets.id, stockDocuments.ticketId))
      .leftJoin(partRequests, eq(partRequests.id, stockDocuments.requestId));
  }

  private where(tenantId: number, f: DocumentFilter): SQL | undefined {
    return and(
      eq(stockDocuments.tenantId, tenantId), inArray(stockDocuments.legalEntityId, f.companyIds),
      f.type ? eq(stockDocuments.type, f.type) : undefined,
      f.status ? eq(stockDocuments.status, f.status) : undefined,
      f.ticketId !== undefined ? eq(stockDocuments.ticketId, f.ticketId) : undefined,
      f.from ? gte(stockDocuments.documentDate, f.from) : undefined,
      f.to ? lte(stockDocuments.documentDate, f.to) : undefined,
      f.onlyLocations ? (f.onlyLocations.length === 0 ? sql`false`
        : sql`EXISTS (SELECT 1 FROM ${stockDocumentLines} l WHERE l.document_id = ${stockDocuments.id}
            AND (l.location_id IN ${f.onlyLocations} OR l.to_location_id IN ${f.onlyLocations}))`) : undefined,
    );
  }

  async list(tenantId: number, f: DocumentFilter, page: number, pageSize: number) {
    if (f.companyIds.length === 0) return { rows: [], total: 0 };
    const where = this.where(tenantId, f);
    const [rows, [{ total }]] = await Promise.all([
      this.summary(this.db).where(where).orderBy(desc(stockDocuments.documentDate), desc(stockDocuments.id)).limit(pageSize).offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(stockDocuments).where(where),
    ]);
    return { rows, total };
  }

  async detail(conn: Conn, documentId: number) {
    const [head] = await this.summary(conn).where(eq(stockDocuments.id, documentId));
    const [extra] = await conn.select({
      challanNo: stockDocuments.challanNo, hasChallan: sql<boolean>`${stockDocuments.challanPath} IS NOT NULL`, reason: stockDocuments.reason, note: stockDocuments.note,
      transitPublicId: transit.publicId, transitType: sql<LocationType | null>`${transit.type}`, transitCode: transit.code, transitName: transit.name,
      receivedByPublicId: receiver.publicId, receivedByName: receiver.displayName, receivedAt: stockDocuments.receivedAt,
    }).from(stockDocuments).leftJoin(transit, eq(transit.id, stockDocuments.transitLocationId)).leftJoin(receiver, eq(receiver.id, stockDocuments.receivedBy))
      .where(eq(stockDocuments.id, documentId));
    const lines = await conn.select({
      lineNo: stockDocumentLines.lineNo, itemPublicId: items.publicId, itemCode: items.code, itemName: items.name,
      quantity: stockDocumentLines.quantity, unitPublicId: baseUnit.publicId, unitCode: baseUnit.code, unitName: baseUnit.name, unitDecimals: baseUnit.decimals,
      enteredQuantity: stockDocumentLines.enteredQuantity, enteredUnitPublicId: enteredUnit.publicId, enteredUnitCode: enteredUnit.code,
      enteredUnitName: enteredUnit.name, enteredUnitDecimals: enteredUnit.decimals,
      locationPublicId: fromLocation.publicId, locationType: sql<LocationType>`${fromLocation.type}`, locationCode: fromLocation.code, locationName: fromLocation.name,
      toLocationPublicId: toLocation.publicId, toLocationType: sql<LocationType | null>`${toLocation.type}`, toLocationCode: toLocation.code, toLocationName: toLocation.name,
      condition: sql<ReturnCondition | null>`${stockDocumentLines.condition}`,
      returnOfLineNo: sql<number | null>`(SELECT o.line_no FROM ${stockDocumentLines} o WHERE o.id = ${stockDocumentLines.originalLineId})`,
      requestLineNo: sql<number | null>`(SELECT r.line_no FROM inventory.part_request_lines r WHERE r.id = ${stockDocumentLines.requestLineId})`,
      batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, serialNo: stockDocumentLines.serialNo,
      unitCost: stockDocumentLines.unitCostMinor, value: stockDocumentLines.valueMinor, currency: stockDocumentLines.currency,
    }).from(stockDocumentLines)
      .innerJoin(items, eq(items.id, stockDocumentLines.itemId))
      // both aliases of a table left-joined: Drizzle types an inner + left pair of one table as never (rows always exist)
      .leftJoin(baseUnit, eq(baseUnit.id, items.baseUnitId))
      .leftJoin(enteredUnit, eq(enteredUnit.id, stockDocumentLines.enteredUnitId))
      .leftJoin(fromLocation, eq(fromLocation.id, stockDocumentLines.locationId))
      .leftJoin(toLocation, eq(toLocation.id, stockDocumentLines.toLocationId))
      .leftJoin(stockBatches, eq(stockBatches.id, stockDocumentLines.batchId))
      .where(eq(stockDocumentLines.documentId, documentId)).orderBy(asc(stockDocumentLines.lineNo));
    return { head, extra, lines };
  }

  /** The location ids a document's lines touch (for scope own). */
  async documentLocations(conn: Conn, documentId: number): Promise<number[]> {
    const rows = await conn.select({ from: stockDocumentLines.locationId, to: stockDocumentLines.toLocationId }).from(stockDocumentLines)
      .where(eq(stockDocumentLines.documentId, documentId));
    return [...new Set(rows.flatMap((r) => (r.to === null ? [r.from] : [r.from, r.to])))];
  }

  async challan(conn: Conn, documentId: number): Promise<{ path: string | null; type: string | null; number: string }> {
    const [row] = await conn.select({ path: stockDocuments.challanPath, type: stockDocuments.challanType, number: stockDocuments.number })
      .from(stockDocuments).where(eq(stockDocuments.id, documentId));
    return row;
  }

  private stockWhere(tenantId: number, f: StockFilter): SQL | undefined {
    return and(
      eq(stockBalances.tenantId, tenantId), inArray(stockBalances.legalEntityId, f.companyIds),
      f.itemId !== undefined ? eq(stockBalances.itemId, f.itemId) : undefined,
      f.locationId !== undefined ? eq(stockBalances.locationId, f.locationId) : undefined,
      f.onlyLocations ? (f.onlyLocations.length === 0 ? sql`false` : inArray(stockBalances.locationId, f.onlyLocations)) : undefined,
      f.includeEmpty ? undefined : or(sql`${stockBalances.onHand} > 0`, sql`${stockBalances.reserved} > 0`),
    );
  }

  /** Stock on hand rows, by company, item code and location code, with the item's company-wide average. */
  async stock(tenantId: number, f: StockFilter, page: number, pageSize: number) {
    if (f.companyIds.length === 0) return { rows: [], total: 0 };
    const where = this.stockWhere(tenantId, f);
    const [rows, [{ total }]] = await Promise.all([
      this.db.select({
        company: legalEntities.code, itemPublicId: items.publicId, itemCode: items.code, itemName: items.name,
        unitPublicId: baseUnit.publicId, unitCode: baseUnit.code, unitName: baseUnit.name, unitDecimals: baseUnit.decimals,
        locationPublicId: locations.publicId, locationType: sql<LocationType>`${locations.type}`, locationCode: locations.code, locationName: locations.name,
        batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate,
        onHand: stockBalances.onHand, reserved: stockBalances.reserved, avg: sql<string>`coalesce(${stockValuations.avgCostMinor}, 0)::text`,
        currency: sql<string>`coalesce(${stockValuations.currency}, 'INR')`,
      }).from(stockBalances)
        .innerJoin(legalEntities, eq(legalEntities.id, stockBalances.legalEntityId))
        .innerJoin(items, eq(items.id, stockBalances.itemId))
        .innerJoin(baseUnit, eq(baseUnit.id, items.baseUnitId))
        .innerJoin(locations, eq(locations.id, stockBalances.locationId))
        .leftJoin(stockValuations, eq(stockValuations.itemId, stockBalances.itemId))
        .leftJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
        .where(where).orderBy(asc(legalEntities.code), asc(items.code), asc(locations.code), sql`${stockBatches.expiryDate} NULLS LAST`).limit(pageSize).offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(stockBalances).where(where),
    ]);
    return { rows, total };
  }

  /** An item's batches with stock (in one location or all reached), earliest expiry first, no expiry last. */
  batches(conn: Conn, itemId: number, locationIds: number[] | undefined) {
    return conn.select({ batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, onHand: stockBalances.onHand, reserved: stockBalances.reserved,
      locationPublicId: locations.publicId, locationType: sql<LocationType>`${locations.type}`, locationCode: locations.code, locationName: locations.name })
      .from(stockBalances).innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId)).innerJoin(locations, eq(locations.id, stockBalances.locationId))
      .where(and(eq(stockBalances.itemId, itemId), sql`${stockBalances.onHand} > 0`,
        locationIds ? (locationIds.length ? inArray(stockBalances.locationId, locationIds) : sql`false`) : undefined))
      .orderBy(sql`${stockBatches.expiryDate} NULLS LAST`, asc(stockBatches.id), asc(locations.code));
  }
}
