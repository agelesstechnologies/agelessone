import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { ItemTracking, LocationType, ReturnCondition, StockDocumentStatus, StockDocumentType } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { tickets } from '../../tickets/schema';
import { documentSeries, items, itemUomConversions, locations, stockBalances, stockDocumentLines, stockDocuments, stockMoves, stockValuations, units } from '../schema';
import { toScaled, fromScaled, Valuation } from '../domain/valuation';

export interface StockItem {
  id: number; publicId: string; legalEntityId: number; code: string; name: string; isStocked: boolean; tracking: ItemTracking; status: string;
  baseUnitId: number; baseUnitPublicId: string; baseUnitCode: string; baseUnitDecimals: number; defaultLocationId: number | null;
}
export interface StockLocation { id: number; publicId: string; legalEntityId: number; type: LocationType; status: string; code: string; name: string }
export interface Conversion { itemId: number; unitId: number; unitPublicId: string; unitCode: string; unitDecimals: number; factor: number }
export interface DocumentRow {
  id: number; publicId: string; tenantId: number; legalEntityId: number; type: StockDocumentType; number: string; status: StockDocumentStatus;
  documentDate: string; ticketId: number | null; originalDocumentId: number | null; transitLocationId: number | null; challanPath: string | null;
  challanType: string | null;
}
export interface LineRow {
  id: number; lineNo: number; itemId: number; locationId: number; toLocationId: number | null; quantity: bigint; enteredQuantity: string | null;
  enteredUnitId: number | null; unitCost: bigint; value: bigint; condition: ReturnCondition | null; originalLineId: number | null;
}
export interface MoveRow { id: number; documentLineId: number; itemId: number; locationId: number; qty: bigint; value: bigint; unitCost: bigint }
export interface NewLine {
  lineNo: number; itemId: number; locationId: number; toLocationId?: number | null; quantity: bigint; enteredQuantity?: bigint | null;
  enteredUnitId?: number | null; unitCost: bigint; value: bigint; condition?: ReturnCondition | null; originalLineId?: number | null;
}
export interface NewMove { lineNo: number; itemId: number; locationId: number; qty: bigint; value: bigint; unitCost: bigint; reversalOf?: number | null }

const key = (itemId: number, locationId: number) => `${itemId}:${locationId}`;

/** Writes the stock tables (documents, lines, moves, balances, valuations, number series); reads items, locations and tickets. */
@Injectable()
export class StockRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- numbers ----

  /** The next number of a document type in a company; the series row stays locked until the transaction ends. */
  async nextNumber(tx: Tx, tenantId: number, legalEntityId: number, docType: StockDocumentType): Promise<number> {
    await tx.insert(documentSeries).values({ tenantId, legalEntityId, docType }).onConflictDoNothing();
    const [row] = await tx.select({ id: documentSeries.id, next: documentSeries.nextNumber }).from(documentSeries)
      .where(and(eq(documentSeries.legalEntityId, legalEntityId), eq(documentSeries.docType, docType))).for('update');
    await tx.update(documentSeries).set({ nextNumber: row.next + 1 }).where(eq(documentSeries.id, row.id));
    return row.next;
  }

  // ---- locks (always valuations by item, then balances by item and location: one order, so posts never deadlock) ----

  /** The valuations of these items, created empty when missing, locked until the transaction ends. */
  async lockValuations(tx: Tx, tenantId: number, legalEntityId: number, itemIds: number[]): Promise<Map<number, { id: number; v: Valuation }>> {
    const ids = [...new Set(itemIds)].sort((a, b) => a - b);
    if (ids.length === 0) return new Map();
    await tx.insert(stockValuations).values(ids.map((itemId) => ({ tenantId, legalEntityId, itemId }))).onConflictDoNothing();
    const rows = await tx.select({ id: stockValuations.id, itemId: stockValuations.itemId, onHand: stockValuations.onHand, value: stockValuations.valueMinor,
      avg: stockValuations.avgCostMinor }).from(stockValuations).where(inArray(stockValuations.itemId, ids)).orderBy(asc(stockValuations.itemId)).for('update');
    return new Map(rows.map((r) => [r.itemId, { id: r.id, v: { qty: toScaled(r.onHand, 4), value: r.value, avg: toScaled(r.avg, 6) } }]));
  }

  /** The balances of these item and location pairs (no batch), created at zero when missing, locked until the transaction ends. */
  async lockBalances(tx: Tx, tenantId: number, legalEntityId: number, pairs: { itemId: number; locationId: number }[]): Promise<Map<string, { id: number; onHand: bigint; reserved: bigint }>> {
    const unique = [...new Map(pairs.map((p) => [key(p.itemId, p.locationId), p])).values()]
      .sort((a, b) => a.itemId - b.itemId || a.locationId - b.locationId);
    if (unique.length === 0) return new Map();
    await tx.insert(stockBalances).values(unique.map((p) => ({ tenantId, legalEntityId, itemId: p.itemId, locationId: p.locationId }))).onConflictDoNothing();
    const rows = await tx.select({ id: stockBalances.id, itemId: stockBalances.itemId, locationId: stockBalances.locationId, onHand: stockBalances.onHand,
      reserved: stockBalances.reserved }).from(stockBalances)
      .where(and(eq(stockBalances.legalEntityId, legalEntityId), isNull(stockBalances.batchId),
        or(...unique.map((p) => and(eq(stockBalances.itemId, p.itemId), eq(stockBalances.locationId, p.locationId))))))
      .orderBy(asc(stockBalances.itemId), asc(stockBalances.locationId)).for('update');
    return new Map(rows.map((r) => [key(r.itemId, r.locationId), { id: r.id, onHand: toScaled(r.onHand, 4), reserved: toScaled(r.reserved, 4) }]));
  }

  async saveValuation(tx: Tx, id: number, v: Valuation): Promise<void> {
    await tx.update(stockValuations).set({ onHand: fromScaled(v.qty, 4), valueMinor: v.value, avgCostMinor: fromScaled(v.avg, 6), updatedAt: new Date() })
      .where(eq(stockValuations.id, id));
  }

  async saveBalance(tx: Tx, id: number, onHand: bigint): Promise<void> {
    await tx.update(stockBalances).set({ onHand: fromScaled(onHand, 4), updatedAt: new Date() }).where(eq(stockBalances.id, id));
  }

  // ---- writes ----

  async insertDocument(tx: Tx, v: typeof stockDocuments.$inferInsert): Promise<number> {
    const [row] = await tx.insert(stockDocuments).values(v).returning({ id: stockDocuments.id });
    return row.id;
  }

  /** Inserts lines and answers their ids by line number. */
  async insertLines(tx: Tx, tenantId: number, legalEntityId: number, documentId: number, lines: NewLine[]): Promise<Map<number, number>> {
    const rows = await tx.insert(stockDocumentLines).values(lines.map((l) => ({
      tenantId, legalEntityId, documentId, lineNo: l.lineNo, itemId: l.itemId, locationId: l.locationId, toLocationId: l.toLocationId ?? null,
      quantity: fromScaled(l.quantity, 4), enteredQuantity: l.enteredQuantity == null ? null : fromScaled(l.enteredQuantity, 4),
      enteredUnitId: l.enteredUnitId ?? null, unitCostMinor: fromScaled(l.unitCost, 6), valueMinor: l.value, condition: l.condition ?? null,
      originalLineId: l.originalLineId ?? null,
    }))).returning({ id: stockDocumentLines.id, lineNo: stockDocumentLines.lineNo });
    return new Map(rows.map((r) => [r.lineNo, r.id]));
  }

  async insertMoves(tx: Tx, tenantId: number, legalEntityId: number, documentId: number, lineIds: Map<number, number>, moves: NewMove[]): Promise<void> {
    if (moves.length === 0) return;
    await tx.insert(stockMoves).values(moves.map((m) => ({
      tenantId, legalEntityId, itemId: m.itemId, locationId: m.locationId, qtyDelta: fromScaled(m.qty, 4), unitCostMinor: fromScaled(m.unitCost, 6),
      valueDeltaMinor: m.value, documentId, documentLineId: lineIds.get(m.lineNo) as number, reversalOf: m.reversalOf ?? null,
    })));
  }

  async setStatus(tx: Tx, id: number, status: StockDocumentStatus, received?: { by: number; at: Date }): Promise<void> {
    await tx.update(stockDocuments).set({ status, ...(received ? { receivedBy: received.by, receivedAt: received.at } : {}) }).where(eq(stockDocuments.id, id));
  }

  async setChallan(tx: Tx, id: number, path: string, type: string): Promise<void> {
    await tx.update(stockDocuments).set({ challanPath: path, challanType: type }).where(eq(stockDocuments.id, id));
  }

  // ---- reads used while posting ----

  async items(conn: Conn, tenantId: number, publicIds: string[]): Promise<Map<string, StockItem>> {
    if (publicIds.length === 0) return new Map();
    const rows = await conn.select({
      id: items.id, publicId: items.publicId, legalEntityId: items.legalEntityId, code: items.code, name: items.name, isStocked: items.isStocked,
      tracking: sql<ItemTracking>`${items.tracking}`, status: items.status, baseUnitId: items.baseUnitId, baseUnitPublicId: units.publicId, baseUnitCode: units.code, baseUnitDecimals: units.decimals, defaultLocationId: items.defaultLocationId,
    }).from(items).innerJoin(units, eq(units.id, items.baseUnitId)).where(and(eq(items.tenantId, tenantId), inArray(items.publicId, [...new Set(publicIds)])));
    return new Map(rows.map((r) => [r.publicId, r]));
  }

  async itemsById(conn: Conn, ids: number[]): Promise<Map<number, StockItem>> {
    if (ids.length === 0) return new Map();
    const rows = await conn.select({
      id: items.id, publicId: items.publicId, legalEntityId: items.legalEntityId, code: items.code, name: items.name, isStocked: items.isStocked,
      tracking: sql<ItemTracking>`${items.tracking}`, status: items.status, baseUnitId: items.baseUnitId, baseUnitPublicId: units.publicId, baseUnitCode: units.code, baseUnitDecimals: units.decimals, defaultLocationId: items.defaultLocationId,
    }).from(items).innerJoin(units, eq(units.id, items.baseUnitId)).where(inArray(items.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Current conversions of these items. */
  conversions(conn: Conn, itemIds: number[]): Promise<Conversion[]> {
    if (itemIds.length === 0) return Promise.resolve([]);
    return conn.select({ itemId: itemUomConversions.itemId, unitId: itemUomConversions.unitId, unitPublicId: units.publicId, unitCode: units.code,
      unitDecimals: units.decimals, factor: itemUomConversions.factor }).from(itemUomConversions).innerJoin(units, eq(units.id, itemUomConversions.unitId))
      .where(and(inArray(itemUomConversions.itemId, itemIds), isNull(itemUomConversions.endedAt)));
  }

  async locations(conn: Conn, tenantId: number, publicIds: string[]): Promise<Map<string, StockLocation>> {
    if (publicIds.length === 0) return new Map();
    const rows = await this.selectLocations(conn).where(and(eq(locations.tenantId, tenantId), inArray(locations.publicId, [...new Set(publicIds)])));
    return new Map(rows.map((r) => [r.publicId, r]));
  }

  async locationsById(conn: Conn, ids: number[]): Promise<Map<number, StockLocation>> {
    if (ids.length === 0) return new Map();
    const rows = await this.selectLocations(conn).where(inArray(locations.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** The company's active locations of one type (to default a transit, quarantine or scrap location when there is only one). */
  activeLocationsOfType(conn: Conn, legalEntityId: number, type: LocationType): Promise<StockLocation[]> {
    return this.selectLocations(conn).where(and(eq(locations.legalEntityId, legalEntityId), eq(locations.type, type), eq(locations.status, 'active')));
  }

  private selectLocations(conn: Conn) {
    return conn.select({ id: locations.id, publicId: locations.publicId, legalEntityId: locations.legalEntityId, type: sql<LocationType>`${locations.type}`,
      status: locations.status, code: locations.code, name: locations.name }).from(locations);
  }

  async ticket(conn: Conn, tenantId: number, publicId: string): Promise<{ id: number; legalEntityId: number; status: string; number: string } | undefined> {
    const [row] = await conn.select({ id: tickets.id, legalEntityId: tickets.legalEntityId, status: tickets.status, number: tickets.number })
      .from(tickets).where(and(eq(tickets.tenantId, tenantId), eq(tickets.publicId, publicId)));
    return row;
  }

  async ticketPublicId(conn: Conn, id: number | null): Promise<string | null> {
    if (id === null) return null;
    const [row] = await conn.select({ publicId: tickets.publicId }).from(tickets).where(eq(tickets.id, id));
    return row?.publicId ?? null;
  }

  async document(conn: Conn, tenantId: number, publicId: string, lock = false): Promise<DocumentRow | undefined> {
    const where = and(eq(stockDocuments.tenantId, tenantId), eq(stockDocuments.publicId, publicId));
    const q = conn.select({
      id: stockDocuments.id, publicId: stockDocuments.publicId, tenantId: stockDocuments.tenantId, legalEntityId: stockDocuments.legalEntityId,
      type: sql<StockDocumentType>`${stockDocuments.type}`, number: stockDocuments.number, status: sql<StockDocumentStatus>`${stockDocuments.status}`,
      documentDate: stockDocuments.documentDate, ticketId: stockDocuments.ticketId, originalDocumentId: stockDocuments.originalDocumentId,
      transitLocationId: stockDocuments.transitLocationId, challanPath: stockDocuments.challanPath, challanType: stockDocuments.challanType,
    }).from(stockDocuments).where(where);
    const [row] = lock ? await q.for('update') : await q;
    return row;
  }

  async lines(conn: Conn, documentId: number): Promise<LineRow[]> {
    const rows = await conn.select({
      id: stockDocumentLines.id, lineNo: stockDocumentLines.lineNo, itemId: stockDocumentLines.itemId, locationId: stockDocumentLines.locationId,
      toLocationId: stockDocumentLines.toLocationId, quantity: stockDocumentLines.quantity, enteredQuantity: stockDocumentLines.enteredQuantity,
      enteredUnitId: stockDocumentLines.enteredUnitId, unitCost: stockDocumentLines.unitCostMinor, value: stockDocumentLines.valueMinor,
      condition: sql<ReturnCondition | null>`${stockDocumentLines.condition}`, originalLineId: stockDocumentLines.originalLineId,
    }).from(stockDocumentLines).where(eq(stockDocumentLines.documentId, documentId)).orderBy(asc(stockDocumentLines.lineNo));
    return rows.map((r) => ({ ...r, quantity: toScaled(r.quantity, 4), unitCost: toScaled(r.unitCost, 6) }));
  }

  async moves(conn: Conn, documentId: number): Promise<MoveRow[]> {
    const rows = await conn.select({ id: stockMoves.id, documentLineId: stockMoves.documentLineId, itemId: stockMoves.itemId, locationId: stockMoves.locationId,
      qty: stockMoves.qtyDelta, value: stockMoves.valueDeltaMinor, unitCost: stockMoves.unitCostMinor })
      .from(stockMoves).where(eq(stockMoves.documentId, documentId)).orderBy(asc(stockMoves.id));
    return rows.map((r) => ({ ...r, qty: toScaled(r.qty, 4), unitCost: toScaled(r.unitCost, 6) }));
  }

  /** What has come back so far against these issue lines (returns that are not reversed): quantity and value. */
  async returnedSoFar(conn: Conn, issueLineIds: number[]): Promise<Map<number, { qty: bigint; value: bigint }>> {
    if (issueLineIds.length === 0) return new Map();
    const rows = await conn.select({ lineId: stockDocumentLines.originalLineId, qty: sql<string>`sum(${stockDocumentLines.quantity})::text`,
      value: sql<string>`sum(${stockDocumentLines.valueMinor})::text` })
      .from(stockDocumentLines).innerJoin(stockDocuments, eq(stockDocuments.id, stockDocumentLines.documentId))
      .where(and(inArray(stockDocumentLines.originalLineId, issueLineIds), eq(stockDocuments.type, 'return'), ne(stockDocuments.status, 'reversed')))
      .groupBy(stockDocumentLines.originalLineId);
    return new Map(rows.map((r) => [r.lineId as number, { qty: toScaled(r.qty, 4), value: BigInt(r.value) }]));
  }

  /** Whether an issue has returns that are not reversed. */
  async hasActiveReturns(conn: Conn, issueId: number): Promise<boolean> {
    const [row] = await conn.select({ id: stockDocuments.id }).from(stockDocuments)
      .where(and(eq(stockDocuments.originalDocumentId, issueId), eq(stockDocuments.type, 'return'), ne(stockDocuments.status, 'reversed'))).limit(1);
    return row !== undefined;
  }

  async itemHasMoves(conn: Conn, itemId: number): Promise<boolean> {
    const [row] = await conn.select({ id: stockMoves.id }).from(stockMoves).where(eq(stockMoves.itemId, itemId)).limit(1);
    return row !== undefined;
  }

  async locationHasStock(conn: Conn, locationId: number): Promise<boolean> {
    const [row] = await conn.select({ id: stockBalances.id }).from(stockBalances).where(and(eq(stockBalances.locationId, locationId), sql`${stockBalances.onHand} > 0`)).limit(1);
    return row !== undefined;
  }
}
