import { Inject, Injectable } from '@nestjs/common';
import {
  LocationType, StockDocument, StockDocumentList, StockDocumentSummary, StockDocumentsQuery, StockList, StockQuery,
} from '@ageless/shared';
import { Conn, DB, Db } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CONTENT_TYPES, DocumentType, readUpload } from '../../../platform/storage';
import { LocationsRepository } from '../infrastructure/locations.repository';
import { StockQueriesRepository } from '../infrastructure/stock-queries.repository';
import { StockRepository } from '../infrastructure/stock.repository';
import { toScaled, valueAt } from '../domain/valuation';
import { INVENTORY } from '../domain/permissions';
import { Company } from '../infrastructure/inventory.repository';
import { CompanyAccess } from './company-access.service';
import { maybePersonRef, personRef } from './support';

/** Who reads stock and documents: store roles, Accounts, CEO / Management (inventory.view), and posters. */
export const STOCK_READ = [INVENTORY.view, INVENTORY.stockPost] as [string, ...string[]];

/**
 * Reading stock: documents and stock on hand, values included. Companies are kept apart; with scope own a person sees
 * only the stock and documents of the locations they look after. Another company's document answers 404.
 */
@Injectable()
export class StockQueriesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(StockQueriesRepository) private readonly repo: StockQueriesRepository,
    @Inject(StockRepository) private readonly stock: StockRepository,
    @Inject(LocationsRepository) private readonly locations: LocationsRepository,
    @Inject(CompanyAccess) private readonly access: CompanyAccess,
  ) {}

  async list(ctx: RequestContext, q: StockDocumentsQuery): Promise<StockDocumentList> {
    const companies = await this.access.forList(ctx, STOCK_READ, q.company);
    let ticketId: number | undefined;
    if (q.ticket) {
      const t = await this.stock.ticket(this.db, ctx.tenantId, q.ticket);
      if (!t) return { items: [], page: q.page, pageSize: q.pageSize, total: 0 };
      ticketId = t.id;
    }
    const onlyLocations = await this.onlyLocations(ctx, companies);
    const { rows, total } = await this.repo.list(ctx.tenantId, { companyIds: companies.map((c) => c.id), type: q.type, status: q.status, ticketId,
      from: q.from, to: q.to, onlyLocations }, q.page, q.pageSize);
    return { items: rows.map(toSummary), page: q.page, pageSize: q.pageSize, total };
  }

  async get(ctx: RequestContext, publicId: string, conn: Conn = this.db): Promise<StockDocument> {
    const doc = await this.visible(conn, ctx, publicId);
    const { head, extra, lines } = await this.repo.detail(conn, doc.id);
    return {
      ...toSummary(head),
      challanNo: extra.challanNo, hasChallan: extra.hasChallan, reason: extra.reason, note: extra.note,
      transitLocation: extra.transitPublicId === null ? null
        : { publicId: extra.transitPublicId, type: extra.transitType as LocationType, code: extra.transitCode ?? '', name: extra.transitName ?? '' },
      receivedBy: maybePersonRef(extra.receivedByPublicId, extra.receivedByName), receivedAt: extra.receivedAt?.toISOString() ?? null,
      lines: lines.map((l) => ({
        lineNo: l.lineNo, item: { publicId: l.itemPublicId, code: l.itemCode, name: l.itemName }, quantity: Number(l.quantity),
        unit: { publicId: l.unitPublicId as string, code: l.unitCode ?? '', name: l.unitName ?? '', decimals: l.unitDecimals ?? 0 },
        enteredQuantity: l.enteredQuantity === null ? null : Number(l.enteredQuantity),
        enteredUnit: l.enteredUnitPublicId === null ? null
          : { publicId: l.enteredUnitPublicId, code: l.enteredUnitCode ?? '', name: l.enteredUnitName ?? '', decimals: l.enteredUnitDecimals ?? 0 },
        location: { publicId: l.locationPublicId as string, type: l.locationType, code: l.locationCode ?? '', name: l.locationName ?? '' },
        toLocation: l.toLocationPublicId === null ? null
          : { publicId: l.toLocationPublicId, type: l.toLocationType as LocationType, code: l.toLocationCode ?? '', name: l.toLocationName ?? '' },
        condition: l.condition, returnOfLineNo: l.returnOfLineNo, unitCostMinor: Number(l.unitCost), valueMinor: Number(l.value), currency: l.currency,
      })),
    };
  }

  async stockOnHand(ctx: RequestContext, q: StockQuery): Promise<StockList> {
    const companies = await this.access.forList(ctx, STOCK_READ, q.company);
    const empty = { items: [], page: q.page, pageSize: q.pageSize, total: 0 };
    let itemId: number | undefined;
    let locationId: number | undefined;
    if (q.item) {
      const item = (await this.stock.items(this.db, ctx.tenantId, [q.item])).get(q.item);
      if (!item || !companies.some((c) => c.id === item.legalEntityId)) return empty;
      itemId = item.id;
    }
    if (q.location) {
      const loc = (await this.stock.locations(this.db, ctx.tenantId, [q.location])).get(q.location);
      if (!loc || !companies.some((c) => c.id === loc.legalEntityId)) return empty;
      locationId = loc.id;
    }
    const onlyLocations = await this.onlyLocations(ctx, companies);
    const { rows, total } = await this.repo.stock(ctx.tenantId, { companyIds: companies.map((c) => c.id), itemId, locationId, onlyLocations,
      includeEmpty: q.includeEmpty }, q.page, q.pageSize);
    return {
      items: rows.map((r) => {
        const onHand = toScaled(r.onHand, 4);
        const reserved = toScaled(r.reserved, 4);
        return {
          company: r.company, item: { publicId: r.itemPublicId, code: r.itemCode, name: r.itemName },
          unit: { publicId: r.unitPublicId, code: r.unitCode, name: r.unitName, decimals: r.unitDecimals },
          location: { publicId: r.locationPublicId, type: r.locationType, code: r.locationCode, name: r.locationName },
          onHand: Number(r.onHand), reserved: Number(r.reserved), available: Number(onHand - reserved) / 10_000,
          avgCostMinor: Number(r.avg), valueMinor: Number(valueAt(onHand, toScaled(r.avg, 6))), currency: r.currency,
        };
      }),
      page: q.page, pageSize: q.pageSize, total,
    };
  }

  /** The receipt's delivery challan file. */
  async challan(ctx: RequestContext, publicId: string): Promise<{ type: string; name: string; data: Buffer }> {
    const doc = await this.visible(this.db, ctx, publicId);
    const c = await this.repo.challan(this.db, doc.id);
    if (!c.path || !c.type) throw new AppError('INVENTORY_NO_CHALLAN', 404, `${c.number} has no challan attached`);
    return { type: CONTENT_TYPES[c.type as DocumentType], name: `${c.number}-challan.${c.type}`, data: await readUpload(c.path) };
  }

  /**
   * A document the caller may read: of a company they reach, and with scope own one touching a location they look after.
   * Anything else is unknown (404).
   */
  async visible(conn: Conn, ctx: RequestContext, publicId: string) {
    const doc = await this.stock.document(conn, ctx.tenantId, publicId);
    const notFound = new AppError('INVENTORY_DOCUMENT_NOT_FOUND', 404, 'Unknown stock document');
    if (!doc || !(await this.access.mayUse(ctx, STOCK_READ, doc.legalEntityId))) throw notFound;
    if (!(await this.access.reachesEveryLocation(ctx, STOCK_READ, doc.legalEntityId))) {
      const reach = await this.access.reachableLocations(ctx, STOCK_READ, await this.locations.list(conn, ctx.tenantId, [doc.legalEntityId]));
      if (!(await this.repo.documentLocations(conn, doc.id)).some((id) => reach.has(id))) throw notFound;
    }
    return doc;
  }

  /** With scope own in some company: the location ids the caller may see; undefined when they see every location they reach. */
  private async onlyLocations(ctx: RequestContext, companies: Company[]): Promise<number[] | undefined> {
    const own: number[] = [];
    for (const c of companies) if (!(await this.access.reachesEveryLocation(ctx, STOCK_READ, c.id))) own.push(c.id);
    if (own.length === 0) return undefined;
    const all = await this.locations.list(this.db, ctx.tenantId, companies.map((c) => c.id));
    const reach = await this.access.reachableLocations(ctx, STOCK_READ, all);
    return all.filter((l) => reach.has(l.id)).map((l) => l.id);
  }
}

type SummaryRow = Awaited<ReturnType<StockQueriesRepository['list']>>['rows'][number];

function toSummary(r: SummaryRow): StockDocumentSummary {
  return {
    publicId: r.publicId, company: r.company, type: r.type, number: r.number, status: r.status, documentDate: r.documentDate,
    supplierName: r.supplierName,
    ticket: r.ticketPublicId === null ? null : { publicId: r.ticketPublicId, number: r.ticketNumber ?? '', title: r.ticketTitle ?? '' },
    original: r.originalPublicId === null ? null : { publicId: r.originalPublicId, number: r.originalNumber ?? '', type: r.originalType as StockDocumentSummary['type'] },
    reversal: r.reversalPublicId === null ? null : { publicId: r.reversalPublicId, number: r.reversalNumber ?? '', type: 'reversal' },
    lineCount: r.lineCount, totalValueMinor: Number(r.totalValue), currency: r.currency,
    createdBy: personRef(r.createdByPublicId, r.createdByName), createdAt: r.createdAt.toISOString(),
  };
}
