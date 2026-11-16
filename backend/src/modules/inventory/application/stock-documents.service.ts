import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CreateIssueRequest, CreateReceiptRequest, CreateReturnRequest, CreateTransferRequest, ReverseDocumentRequest, StockDocument,
  StockDocumentStatus, StockDocumentType, StockEvent, StockEventType,
} from '@ageless/shared';
import { DB, Db, Tx } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { detectDocumentType, discardUpload, saveUpload } from '../../../platform/storage';
import { todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { stockDocuments } from '../schema';
import { Company } from '../infrastructure/inventory.repository';
import { LocationsRepository } from '../infrastructure/locations.repository';
import { NewLine, NewMove, StockItem, StockLocation, StockRepository } from '../infrastructure/stock.repository';
import { fitsDecimals, toBaseQuantity } from '../domain/quantities';
import { documentDateProblem, documentNumber, itemStockProblem, LocationUse, locationUseProblem, returnLocationTypes, TICKET_TAKES_PARTS } from '../domain/stock-rules';
import { fromScaled, lineValue, toScaled, unitCostOf, valueAt } from '../domain/valuation';
import { INVENTORY } from '../domain/permissions';
import { ClosedMonths } from './closed-months';
import { CompanyAccess } from './company-access.service';
import { Labels, PlannedMove, StockPosting } from './stock-posting.service';
import { StockQueriesService } from './stock-queries.service';
import { isResentCreate } from './support';

/** A line before posting: its value is known (receipts, returns, reversals) or taken from its first move (issues, transfers). */
type DraftLine = Omit<NewLine, 'value' | 'unitCost'> & { value?: bigint; unitCost?: bigint };
export interface ChallanUpload { buffer: Buffer; size: number }
export const MAX_CHALLAN_BYTES = 5 * 1024 * 1024;

interface Writing {
  publicId: string; company: Company; type: StockDocumentType; status: StockDocumentStatus; documentDate: string;
  header: Partial<typeof stockDocuments.$inferInsert>; lines: DraftLine[]; planned: PlannedMove[]; reprice: Set<number>; labels: Labels;
  event: { type: StockEventType; ticketPublicId: string | null; phase: 'dispatched' | 'received' | null; reason: string | null; reversalOf: string | null };
  publicIds: { items: Map<number, string>; locations: Map<number, string> };
}

/**
 * Posting stock documents: receipts, issues, returns, transfers (sent, then received) and reversals. Every document
 * belongs to one company and uses only that company's items, locations and tickets (the database refuses anything else).
 * Posting writes the moves and updates balances and the moving average in the same transaction, publishes the stock
 * event and writes the audit log. Posting needs inventory.stock.post; with scope own only for the locations the poster
 * looks after. A document is never changed: a mistake is reversed.
 */
@Injectable()
export class StockDocumentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(StockRepository) private readonly repo: StockRepository,
    @Inject(StockPosting) private readonly posting: StockPosting,
    @Inject(LocationsRepository) private readonly locationsRepo: LocationsRepository,
    @Inject(CompanyAccess) private readonly access: CompanyAccess,
    @Inject(ClosedMonths) private readonly closed: ClosedMonths,
    @Inject(StockQueriesService) private readonly queries: StockQueriesService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /** Goods arriving from a supplier: stock in at the cost given; the item's average is recalculated. */
  async receipt(ctx: RequestContext, req: CreateReceiptRequest): Promise<{ document: StockDocument; created: boolean }> {
    const company = await this.access.require(ctx, [INVENTORY.stockPost], req.company);
    const documentDate = await this.date(ctx, company, req.documentDate);
    return this.create(ctx, req.publicId, async (tx, publicId) => {
      const items = await this.items(tx, ctx, company, req.lines.map((l) => l.itemPublicId), true);
      const given = await this.locations(tx, ctx, company, req.lines.flatMap((l) => (l.locationPublicId ? [l.locationPublicId] : [])));
      const defaults = await this.repo.locationsById(tx, [...items.values()].flatMap((i) => (i.defaultLocationId === null ? [] : [i.defaultLocationId])));
      const conversions = await this.repo.conversions(tx, [...items.values()].map((i) => i.id));
      const lines: DraftLine[] = [];
      const planned: PlannedMove[] = [];
      req.lines.forEach((l, i) => {
        const item = items.get(l.itemPublicId) as StockItem;
        const location = l.locationPublicId ? given.get(l.locationPublicId) as StockLocation
          : item.defaultLocationId === null ? undefined : defaults.get(item.defaultLocationId);
        if (!location) throw new AppError('INVENTORY_LOCATION_NEEDED', 400, `Line ${i + 1}: give the location for ${item.code} (it has no default location)`);
        requireActive(location, i);
        requireUse(location, 'receive', i);
        let factor = 1;
        let enteredUnitId: number | null = null;
        let decimals = item.baseUnitDecimals;
        if (l.unitPublicId && l.unitPublicId !== item.baseUnitPublicId) {
          const c = conversions.find((x) => x.itemId === item.id && x.unitPublicId === l.unitPublicId);
          if (!c) throw new AppError('INVENTORY_NO_CONVERSION', 400, `Line ${i + 1}: ${item.code} has no conversion for that unit`);
          factor = c.factor;
          enteredUnitId = c.unitId;
          decimals = c.unitDecimals;
        }
        requireDecimals(l.quantity, decimals, i);
        const base = toScaled(factor === 1 ? l.quantity : toBaseQuantity(l.quantity, factor, item.baseUnitDecimals), 4);
        if (base <= 0n) throw new AppError('INVENTORY_QUANTITY_DECIMALS', 400, `Line ${i + 1}: that is less than one ${item.baseUnitCode} of ${item.code}`);
        const entered = toScaled(l.quantity, 4);
        const value = lineValue(entered, BigInt(l.unitCostMinor));
        lines.push({ lineNo: i + 1, itemId: item.id, locationId: location.id, quantity: base, enteredQuantity: enteredUnitId === null ? null : entered,
          enteredUnitId, value, unitCost: unitCostOf(value, base) });
        planned.push({ lineNo: i + 1, itemId: item.id, locationId: location.id, qty: base, value: { kind: 'exact', value } });
      });
      const locs = new Map([...given.values(), ...defaults.values()].map((l) => [l.id, l]));
      await this.requireReach(tx, ctx, company, planned.map((p) => p.locationId));
      await this.write(tx, ctx, {
        publicId, company, type: 'receipt', status: 'posted', documentDate, lines, planned, reprice: new Set(planned.map((p) => p.itemId)),
        header: { supplierName: req.supplierName, challanNo: req.challanNo ?? null, reason: req.reason, note: req.note ?? null },
        labels: labels(items.values(), locs.values()), publicIds: publicIds(items.values(), locs.values()),
        event: { type: 'stock.received', ticketPublicId: null, phase: null, reason: null, reversalOf: null },
      });
    });
  }

  /** Parts handed out for a ticket of the same company, at the item's average cost at that moment (recorded on the line). */
  async issue(ctx: RequestContext, req: CreateIssueRequest): Promise<{ document: StockDocument; created: boolean }> {
    const company = await this.access.require(ctx, [INVENTORY.stockPost], req.company);
    const documentDate = await this.date(ctx, company, req.documentDate);
    return this.create(ctx, req.publicId, async (tx, publicId) => {
      const ticket = await this.repo.ticket(tx, ctx.tenantId, req.ticketPublicId);
      if (!ticket || ticket.legalEntityId !== company.id) throw new AppError('INVENTORY_UNKNOWN_TICKET', 400, `That ticket does not belong to ${company.code}`);
      if (!TICKET_TAKES_PARTS.includes(ticket.status)) throw new AppError('INVENTORY_TICKET_CLOSED', 409, `Ticket ${ticket.number} is ${ticket.status}: it takes no more parts`);
      const items = await this.items(tx, ctx, company, req.lines.map((l) => l.itemPublicId), false);
      const locs = await this.locations(tx, ctx, company, req.lines.map((l) => l.locationPublicId));
      const lines: DraftLine[] = [];
      const planned: PlannedMove[] = [];
      req.lines.forEach((l, i) => {
        const item = items.get(l.itemPublicId) as StockItem;
        const location = locs.get(l.locationPublicId) as StockLocation;
        requireActive(location, i);
        requireUse(location, 'issue', i);
        requireDecimals(l.quantity, item.baseUnitDecimals, i);
        const qty = toScaled(l.quantity, 4);
        lines.push({ lineNo: i + 1, itemId: item.id, locationId: location.id, quantity: qty });
        planned.push({ lineNo: i + 1, itemId: item.id, locationId: location.id, qty: -qty, value: { kind: 'average' } });
      });
      await this.requireReach(tx, ctx, company, planned.map((p) => p.locationId));
      await this.write(tx, ctx, {
        publicId, company, type: 'issue', status: 'posted', documentDate, lines, planned, reprice: new Set(), header: { ticketId: ticket.id, note: req.note ?? null },
        labels: labels(items.values(), locs.values()), publicIds: publicIds(items.values(), locs.values()),
        event: { type: 'stock.issued', ticketPublicId: req.ticketPublicId, phase: null, reason: null, reversalOf: null },
      });
    });
  }

  /**
   * Parts coming back from an issue, at the cost they were issued at, to a location that fits their condition. Never more
   * than was issued less what came back already.
   */
  async return(ctx: RequestContext, req: CreateReturnRequest): Promise<{ document: StockDocument; created: boolean }> {
    const found = await this.repo.document(this.db, ctx.tenantId, req.issuePublicId);
    if (!found || !(await this.access.mayUse(ctx, [INVENTORY.stockPost], found.legalEntityId))) throw notFound();
    if (found.type !== 'issue') throw new AppError('INVENTORY_NOT_AN_ISSUE', 400, `${found.number} is not an issue: only issued parts come back`);
    const company = await this.access.requireById(ctx, [INVENTORY.stockPost], found.legalEntityId);
    const documentDate = await this.date(ctx, company, req.documentDate);
    return this.create(ctx, req.publicId, async (tx, publicId) => {
      const issue = await this.repo.document(tx, ctx.tenantId, req.issuePublicId, true);   // one return of this issue at a time
      if (!issue || issue.status !== 'posted') throw new AppError('INVENTORY_DOCUMENT_REVERSED', 409, `${found.number} was reversed: nothing comes back from it`);
      const issued = await this.repo.lines(tx, issue.id);
      const returned = await this.repo.returnedSoFar(tx, issued.map((l) => l.id));
      const items = await this.repo.itemsById(tx, issued.map((l) => l.itemId));
      const given = await this.locations(tx, ctx, company, req.lines.flatMap((l) => (l.locationPublicId ? [l.locationPublicId] : [])));
      const usedLocs = new Map<number, StockLocation>();
      const lines: DraftLine[] = [];
      const planned: PlannedMove[] = [];
      for (const [i, l] of req.lines.entries()) {
        const line = issued.find((x) => x.lineNo === l.lineNo);
        if (!line) throw new AppError('INVENTORY_UNKNOWN_LINE', 400, `Line ${i + 1}: ${issue.number} has no line ${l.lineNo}`);
        const item = items.get(line.itemId) as StockItem;
        const problem = itemStockProblem(item);
        if (problem) throw new AppError('INVENTORY_ITEM_NOT_STOCKABLE', 400, `Line ${i + 1}: ${problem}`);
        requireDecimals(l.quantity, item.baseUnitDecimals, i);
        const qty = toScaled(l.quantity, 4);
        const back = returned.get(line.id) ?? { qty: 0n, value: 0n };
        const remaining = line.quantity - back.qty;
        if (qty > remaining) {
          throw new AppError('INVENTORY_RETURN_TOO_MUCH', 409, `Line ${i + 1}: only ${trim(fromScaled(remaining, 4))} ${item.baseUnitCode} of ${item.code} from line ${l.lineNo} can still come back`);
        }
        const location = l.locationPublicId ? given.get(l.locationPublicId) as StockLocation : await this.returnLocation(tx, company, line.locationId, l.condition, i);
        requireActive(location, i);
        requireUse(location, l.condition, i);
        usedLocs.set(location.id, location);
        const value = qty === remaining ? line.value - back.value : valueAt(qty, line.unitCost);
        returned.set(line.id, { qty: back.qty + qty, value: back.value + value });
        lines.push({ lineNo: i + 1, itemId: item.id, locationId: location.id, quantity: qty, value, unitCost: line.unitCost, condition: l.condition, originalLineId: line.id });
        planned.push({ lineNo: i + 1, itemId: item.id, locationId: location.id, qty, value: { kind: 'exact', value } });
      }
      await this.requireReach(tx, ctx, company, planned.map((p) => p.locationId));
      await this.write(tx, ctx, {
        publicId, company, type: 'return', status: 'posted', documentDate, lines, planned, reprice: new Set(planned.map((p) => p.itemId)),
        header: { originalDocumentId: issue.id, note: req.note ?? null },
        labels: labels(items.values(), usedLocs.values()), publicIds: publicIds(items.values(), usedLocs.values()),
        event: { type: 'stock.returned', ticketPublicId: await this.repo.ticketPublicId(tx, issue.ticketId), phase: null, reason: null, reversalOf: null },
      });
    });
  }

  /** Stock moving between two locations of the company: it leaves now and waits in transit until received. */
  async transfer(ctx: RequestContext, req: CreateTransferRequest): Promise<{ document: StockDocument; created: boolean }> {
    const company = await this.access.require(ctx, [INVENTORY.stockPost], req.company);
    const documentDate = await this.date(ctx, company, req.documentDate);
    return this.create(ctx, req.publicId, async (tx, publicId) => {
      const items = await this.items(tx, ctx, company, req.lines.map((l) => l.itemPublicId), false);
      const locs = await this.locations(tx, ctx, company, req.lines.flatMap((l) => [l.fromLocationPublicId, l.toLocationPublicId]));
      let transit: StockLocation | undefined;
      if (req.transitLocationPublicId) transit = (await this.locations(tx, ctx, company, [req.transitLocationPublicId])).get(req.transitLocationPublicId);
      else {
        const all = await this.repo.activeLocationsOfType(tx, company.id, 'transit');
        if (all.length !== 1) throw new AppError('INVENTORY_TRANSIT_NEEDED', 400, `Choose the transit location (${company.code} has ${all.length === 0 ? 'none' : 'several'})`);
        transit = all[0];
      }
      const t = transit as StockLocation;
      requireActive(t, -1);
      requireUse(t, 'transit', -1);
      const lines: DraftLine[] = [];
      const planned: PlannedMove[] = [];
      req.lines.forEach((l, i) => {
        const item = items.get(l.itemPublicId) as StockItem;
        const from = locs.get(l.fromLocationPublicId) as StockLocation;
        const to = locs.get(l.toLocationPublicId) as StockLocation;
        for (const [loc, use] of [[from, 'transfer_from'], [to, 'transfer_to']] as const) { requireActive(loc, i); requireUse(loc, use, i); }
        requireDecimals(l.quantity, item.baseUnitDecimals, i);
        const qty = toScaled(l.quantity, 4);
        lines.push({ lineNo: i + 1, itemId: item.id, locationId: from.id, toLocationId: to.id, quantity: qty });
        planned.push({ lineNo: i + 1, itemId: item.id, locationId: from.id, qty: -qty, value: { kind: 'average' } });
        planned.push({ lineNo: i + 1, itemId: item.id, locationId: t.id, qty, value: { kind: 'mirror', of: planned.length - 1 } });
      });
      await this.requireReach(tx, ctx, company, req.lines.map((l) => (locs.get(l.fromLocationPublicId) as StockLocation).id));
      const allLocs = [...locs.values(), t];
      await this.write(tx, ctx, {
        publicId, company, type: 'transfer', status: 'in_transit', documentDate, lines, planned, reprice: new Set(),
        header: { transitLocationId: t.id, note: req.note ?? null },
        labels: labels(items.values(), allLocs), publicIds: publicIds(items.values(), allLocs),
        event: { type: 'stock.transferred', ticketPublicId: null, phase: 'dispatched', reason: null, reversalOf: null },
      });
    });
  }

  /** The receiving side confirms a transfer: the stock leaves transit for its destinations, with the value it left with. */
  async receive(ctx: RequestContext, publicId: string): Promise<StockDocument> {
    const found = await this.repo.document(this.db, ctx.tenantId, publicId);
    if (!found || !(await this.access.mayUse(ctx, [INVENTORY.stockPost], found.legalEntityId))) throw notFound();
    if (found.type !== 'transfer') throw new AppError('INVENTORY_NOT_A_TRANSFER', 400, `${found.number} is not a transfer`);
    const company = await this.access.requireById(ctx, [INVENTORY.stockPost], found.legalEntityId);
    await this.db.transaction(async (tx) => {
      const doc = await this.repo.document(tx, ctx.tenantId, publicId, true);
      if (!doc || doc.status !== 'in_transit') {
        throw new AppError('INVENTORY_NOT_IN_TRANSIT', 409, `${found.number} is ${doc?.status === 'reversed' ? 'reversed' : 'already received'}`);
      }
      const lines = await this.repo.lines(tx, doc.id);
      const moves = await this.repo.moves(tx, doc.id);
      const planned: PlannedMove[] = [];
      for (const line of lines) {
        const sent = moves.find((m) => m.documentLineId === line.id && m.locationId === doc.transitLocationId && m.qty > 0n);
        if (!sent) throw new Error(`transfer ${doc.number} line ${line.lineNo} has no transit move`);
        planned.push({ lineNo: line.lineNo, itemId: line.itemId, locationId: sent.locationId, qty: -sent.qty, value: { kind: 'exact', value: -sent.value } });
        planned.push({ lineNo: line.lineNo, itemId: line.itemId, locationId: line.toLocationId as number, qty: sent.qty, value: { kind: 'exact', value: sent.value } });
      }
      await this.requireReach(tx, ctx, company, lines.map((l) => l.toLocationId as number));
      const items = await this.repo.itemsById(tx, lines.map((l) => l.itemId));
      const locs = await this.repo.locationsById(tx, planned.map((p) => p.locationId));
      const names = labels(items.values(), locs.values());
      const resolved = await this.posting.apply(tx, ctx.tenantId, company.id, planned, new Set(), names);
      await this.repo.insertMoves(tx, ctx.tenantId, company.id, doc.id, new Map(lines.map((l) => [l.lineNo, l.id])), resolved);
      await this.repo.setStatus(tx, doc.id, 'posted', { by: ctx.personId, at: new Date() });
      await this.publish(tx, ctx, company, { publicId, number: doc.number, type: 'transfer', documentDate: doc.documentDate }, resolved,
        publicIds(items.values(), locs.values()), names, { type: 'stock.transferred', ticketPublicId: null, phase: 'received', reason: null, reversalOf: null });
      await this.audit(tx, ctx, 'inventory.transfer.received', publicId, company.id, `Received transfer ${doc.number} of ${company.code}`, { number: doc.number });
    });
    return this.queries.get(ctx, publicId);
  }

  /**
   * Undoes a posted document with a reversal document: every move of it, opposite, so quantity and value come back. An
   * issue with returns needs those reversed first; refused when the stock has moved on since (it would go below zero, or
   * leave value without stock).
   */
  async reverse(ctx: RequestContext, publicId: string, req: ReverseDocumentRequest): Promise<{ document: StockDocument; created: boolean }> {
    const found = await this.repo.document(this.db, ctx.tenantId, publicId);
    if (!found || !(await this.access.mayUse(ctx, [INVENTORY.stockPost], found.legalEntityId))) throw notFound();
    const company = await this.access.requireById(ctx, [INVENTORY.stockPost], found.legalEntityId);
    const documentDate = await this.date(ctx, company, undefined);
    return this.create(ctx, req.publicId, async (tx, reversalId) => {
      const doc = await this.repo.document(tx, ctx.tenantId, publicId, true);
      if (!doc) throw notFound();
      if (doc.type === 'reversal') throw new AppError('INVENTORY_CANNOT_REVERSE_REVERSAL', 400, `${doc.number} is a reversal; it cannot be reversed`);
      if (doc.status === 'reversed') throw new AppError('INVENTORY_ALREADY_REVERSED', 409, `${doc.number} is already reversed`);
      if (doc.type === 'issue' && await this.repo.hasActiveReturns(tx, doc.id)) {
        throw new AppError('INVENTORY_REVERSE_RETURNS_FIRST', 409, `Parts of ${doc.number} were returned: reverse those returns first`);
      }
      const original = await this.repo.lines(tx, doc.id);
      const moves = await this.repo.moves(tx, doc.id);
      const lineNoOf = new Map(original.map((l) => [l.id, l.lineNo]));
      const planned: PlannedMove[] = moves.map((m) => ({ lineNo: lineNoOf.get(m.documentLineId) as number, itemId: m.itemId, locationId: m.locationId,
        qty: -m.qty, value: { kind: 'exact', value: -m.value }, reversalOf: m.id }));
      const items = await this.repo.itemsById(tx, moves.map((m) => m.itemId));
      const locs = await this.repo.locationsById(tx, moves.map((m) => m.locationId));
      await this.requireReach(tx, ctx, company, [...locs.values()].filter((l) => l.type !== 'transit').map((l) => l.id));
      const netValue = new Map<number, bigint>();
      for (const m of moves) netValue.set(m.itemId, (netValue.get(m.itemId) ?? 0n) - m.value);
      const lines: DraftLine[] = original.map((l) => ({ lineNo: l.lineNo, itemId: l.itemId, locationId: l.locationId, toLocationId: l.toLocationId,
        quantity: l.quantity, enteredQuantity: l.enteredQuantity === null ? null : toScaled(l.enteredQuantity, 4), enteredUnitId: l.enteredUnitId,
        value: l.value, unitCost: l.unitCost, condition: l.condition, originalLineId: l.id }));
      await this.write(tx, ctx, {
        publicId: reversalId, company, type: 'reversal', status: 'posted', documentDate, lines, planned,
        reprice: new Set([...netValue].filter(([, v]) => v !== 0n).map(([itemId]) => itemId)),
        header: { originalDocumentId: doc.id, reason: req.reason },
        labels: labels(items.values(), locs.values()), publicIds: publicIds(items.values(), locs.values()),
        event: { type: 'stock.adjusted', ticketPublicId: await this.repo.ticketPublicId(tx, doc.ticketId), phase: null, reason: 'reversal', reversalOf: publicId },
      });
      await this.repo.setStatus(tx, doc.id, 'reversed');
    });
  }

  /** The delivery challan of a receipt (JPEG, PNG or PDF, told by its bytes), attached once. */
  async attachChallan(ctx: RequestContext, publicId: string, file: ChallanUpload | undefined): Promise<StockDocument> {
    const found = await this.repo.document(this.db, ctx.tenantId, publicId);
    if (!found || !(await this.access.mayUse(ctx, [INVENTORY.stockPost], found.legalEntityId))) throw notFound();
    if (found.type !== 'receipt') throw new AppError('INVENTORY_NOT_A_RECEIPT', 400, `${found.number} is not a receipt: only receipts have a challan`);
    const company = await this.access.requireById(ctx, [INVENTORY.stockPost], found.legalEntityId);
    if (!file) throw new AppError('INVENTORY_FILE_REQUIRED', 400, 'Attach the challan (form field "file")');
    const type = detectDocumentType(file.buffer);
    if (!type) throw new AppError('INVENTORY_FILE_TYPE', 400, 'The challan must be a JPEG, PNG or PDF file');
    const path = await saveUpload('inventory-challans', type, file.buffer);
    try {
      await this.db.transaction(async (tx) => {
        const doc = await this.repo.document(tx, ctx.tenantId, publicId, true);
        if (!doc) throw notFound();
        if (doc.challanPath) throw new AppError('INVENTORY_CHALLAN_EXISTS', 409, `${doc.number} already has its challan`);
        await this.requireReach(tx, ctx, company, (await this.repo.lines(tx, doc.id)).map((l) => l.locationId));
        await this.repo.setChallan(tx, doc.id, path, type);
        await this.audit(tx, ctx, 'inventory.receipt.challan_attached', publicId, company.id, `Attached the challan of ${doc.number} (${company.code})`, { number: doc.number });
      });
    } catch (err) {
      await discardUpload(path);
      throw err;
    }
    return this.queries.get(ctx, publicId);
  }

  // ---- helpers ----

  /** A create sent again with the same publicId answers the stored document (created: false). */
  private async create(ctx: RequestContext, publicId: string | undefined, build: (tx: Tx, publicId: string) => Promise<void>) {
    if (await this.access.alreadyStored(ctx, stockDocuments, publicId)) return { document: await this.queries.get(ctx, publicId as string), created: false };
    const id = publicId ?? randomUUID();
    try {
      await this.db.transaction((tx) => build(tx, id));
    } catch (err) {
      if (isResentCreate(err)) return { document: await this.queries.get(ctx, id), created: false };
      throw err;
    }
    return { document: await this.queries.get(ctx, id), created: true };
  }

  /** Posts the moves, then stores the document, its lines and moves, the event and the audit entry. */
  private async write(tx: Tx, ctx: RequestContext, w: Writing): Promise<void> {
    const moves = await this.posting.apply(tx, ctx.tenantId, w.company.id, w.planned, w.reprice, w.labels);
    const lines: NewLine[] = w.lines.map((l) => {
      if (l.value !== undefined && l.unitCost !== undefined) return { ...l, value: l.value, unitCost: l.unitCost };
      const first = moves.find((m) => m.lineNo === l.lineNo) as NewMove;
      return { ...l, value: first.value < 0n ? -first.value : first.value, unitCost: first.unitCost };
    });
    const number = documentNumber(w.type, await this.repo.nextNumber(tx, ctx.tenantId, w.company.id, w.type));
    const id = await this.repo.insertDocument(tx, { tenantId: ctx.tenantId, publicId: w.publicId, legalEntityId: w.company.id, type: w.type, number,
      status: w.status, documentDate: w.documentDate, createdBy: ctx.personId, ...w.header });
    const lineIds = await this.repo.insertLines(tx, ctx.tenantId, w.company.id, id, lines);
    await this.repo.insertMoves(tx, ctx.tenantId, w.company.id, id, lineIds, moves);
    await this.publish(tx, ctx, w.company, { publicId: w.publicId, number, type: w.type, documentDate: w.documentDate }, moves, w.publicIds, w.labels, w.event);
    const total = lines.reduce((s, l) => s + l.value, 0n);
    await this.audit(tx, ctx, `inventory.${w.type}.posted`, w.publicId, w.company.id,
      `Posted ${w.type} ${number} of ${w.company.code}: ${lines.length} line${lines.length === 1 ? '' : 's'}, value ${fromScaled(total, 2)}`,
      { number, type: w.type, lines: lines.length, totalValueMinor: Number(total) });
  }

  private async publish(tx: Tx, ctx: RequestContext, company: Company, doc: { publicId: string; number: string; type: StockDocumentType; documentDate: string },
    moves: NewMove[], ids: Writing['publicIds'], names: Labels, e: Writing['event']): Promise<void> {
    const lines = moves.map((m) => ({
      itemPublicId: ids.items.get(m.itemId) as string, itemCode: names.items.get(m.itemId) ?? '', locationPublicId: ids.locations.get(m.locationId) as string,
      quantity: Number(fromScaled(m.qty, 4)), unitCostMinor: Number(fromScaled(m.unitCost, 6)), valueMinor: Number(m.value), currency: 'INR',
    }));
    const event: StockEvent = {
      eventId: randomUUID(), eventType: e.type, eventVersion: 1, tenantId: ctx.tenantId, aggregatePublicId: doc.publicId, causedBy: ctx.personPublicId,
      occurredAt: new Date().toISOString(),
      payload: { company: company.code, documentPublicId: doc.publicId, documentNumber: doc.number, documentType: doc.type, documentDate: doc.documentDate,
        ticketPublicId: e.ticketPublicId, projectId: null, phase: e.phase, reason: e.reason, reversalOf: e.reversalOf, lines,
        totalValueMinor: lines.reduce((s, l) => s + l.valueMinor, 0), currency: 'INR' },
    };
    await this.core.publish(tx, event);
  }

  /** The document date: given or today (IST); never in the future, never in a month Accounts has closed. */
  private async date(ctx: RequestContext, company: Company, given: string | undefined): Promise<string> {
    const today = todayIst();
    const date = given ?? today;
    const problem = documentDateProblem(date, today, await this.closed.isClosed(ctx.tenantId, company.id, date));
    if (problem) throw new AppError(date > today ? 'INVENTORY_DATE_IN_FUTURE' : 'INVENTORY_MONTH_CLOSED', 400, problem);
    return date;
  }

  /** Items of the document's company that can move in stock (receipts: active ones only). */
  private async items(tx: Tx, ctx: RequestContext, company: Company, publicIds: string[], receiving: boolean): Promise<Map<string, StockItem>> {
    const found = await this.repo.items(tx, ctx.tenantId, publicIds);
    publicIds.forEach((id, i) => {
      const item = found.get(id);
      if (!item || item.legalEntityId !== company.id) throw new AppError('INVENTORY_UNKNOWN_ITEM', 400, `Line ${i + 1}: that item does not belong to ${company.code}`);
      const problem = itemStockProblem(item);
      if (problem) throw new AppError('INVENTORY_ITEM_NOT_STOCKABLE', 400, `Line ${i + 1}: ${problem}`);
      if (receiving && item.status !== 'active') throw new AppError('INVENTORY_ITEM_INACTIVE', 400, `Line ${i + 1}: ${item.code} is inactive and takes no receipts`);
    });
    return found;
  }

  /** Locations of the document's company. */
  private async locations(tx: Tx, ctx: RequestContext, company: Company, publicIds: string[]): Promise<Map<string, StockLocation>> {
    const found = await this.repo.locations(tx, ctx.tenantId, publicIds);
    for (const id of publicIds) {
      const loc = found.get(id);
      if (!loc || loc.legalEntityId !== company.id) throw new AppError('INVENTORY_UNKNOWN_LOCATION', 400, `That location does not belong to ${company.code}`);
    }
    return found;
  }

  /** The default location for a returned part: usable goes back where it came from; repair and scrap to the only one of that type. */
  private async returnLocation(tx: Tx, company: Company, issuedFrom: number, condition: 'usable' | 'repair' | 'scrap', i: number): Promise<StockLocation> {
    if (condition === 'usable') {
      const back = (await this.repo.locationsById(tx, [issuedFrom])).get(issuedFrom) as StockLocation;
      if (back.status === 'active') return back;
    } else {
      const [type] = returnLocationTypes(condition);
      const all = await this.repo.activeLocationsOfType(tx, company.id, type);
      if (all.length === 1) return all[0];
    }
    throw new AppError('INVENTORY_RETURN_LOCATION_NEEDED', 400, `Line ${i + 1}: choose where the ${condition} part goes`);
  }

  /** Posting needs reach over every location the document moves stock in or out of (scope own: the ones the poster looks after). */
  private async requireReach(tx: Tx, ctx: RequestContext, company: Company, locationIds: number[]): Promise<void> {
    const all = await this.locationsRepo.list(tx, ctx.tenantId, [company.id]);
    const reach = await this.access.reachableLocations(ctx, [INVENTORY.stockPost], all);
    const outside = [...new Set(locationIds)].filter((id) => !reach.has(id));
    if (outside.length) {
      const codes = all.filter((l) => outside.includes(l.id)).map((l) => l.code).join(', ');
      throw new AppError('INVENTORY_NOT_YOUR_LOCATION', 403, `You post only for the locations you look after (${codes} is not one)`);
    }
  }

  private audit(tx: Tx, ctx: RequestContext, action: string, publicId: string, legalEntityId: number, summary: string, details: Record<string, unknown>) {
    return this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action, entity: 'inventory_document', entityPublicId: publicId, legalEntityId, summary, details });
  }
}

const notFound = () => new AppError('INVENTORY_DOCUMENT_NOT_FOUND', 404, 'Unknown stock document');
const trim = (s: string) => s.replace(/\.?0+$/, '');

function requireActive(loc: StockLocation, i: number): void {
  if (loc.status !== 'active') throw new AppError('INVENTORY_LOCATION_INACTIVE', 400, `${i >= 0 ? `Line ${i + 1}: ` : ''}the location ${loc.code} is inactive`);
}

function requireUse(loc: StockLocation, use: LocationUse, i: number): void {
  const problem = locationUseProblem(use, loc.type);
  if (problem) throw new AppError('INVENTORY_LOCATION_USE', 400, `${i >= 0 ? `Line ${i + 1}: ` : ''}${problem} (${loc.code})`);
}

function requireDecimals(quantity: number, decimals: number, i: number): void {
  if (!fitsDecimals(quantity, decimals)) {
    throw new AppError('INVENTORY_QUANTITY_DECIMALS', 400, `Line ${i + 1}: use ${decimals === 0 ? 'whole numbers' : `at most ${decimals} decimals`} for this unit`);
  }
}

function labels(items: Iterable<StockItem>, locs: Iterable<StockLocation>): Labels {
  return { items: new Map([...items].map((i) => [i.id, i.code])), locations: new Map([...locs].map((l) => [l.id, l.code])) };
}

function publicIds(items: Iterable<StockItem>, locs: Iterable<StockLocation>): Writing['publicIds'] {
  return { items: new Map([...items].map((i) => [i.id, i.publicId])), locations: new Map([...locs].map((l) => [l.id, l.publicId])) };
}
