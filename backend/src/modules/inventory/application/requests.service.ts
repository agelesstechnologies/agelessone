import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ApprovePartRequest, CancelPartRequest, CreatePartRequest, LocationType, PartRequest, PartRequestList, PartRequestsQuery, RejectPartRequest,
  RequestItem, RequestItemsQuery, TicketParts,
} from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { addDays, todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { partRequests } from '../schema';
import { RequestsRepository, RequestRow, RequestVisibility, TicketFacts } from '../infrastructure/requests.repository';
import { placeKey, StockItem, StockLocation, StockRepository } from '../infrastructure/stock.repository';
import { fitsDecimals } from '../domain/quantities';
import { allocateFefo, approvalRoles, fullyApproved, needsHeadApproval } from '../domain/requests';
import { documentNumber, TICKET_TAKES_PARTS } from '../domain/stock-rules';
import { fromScaled, toScaled, valueAt } from '../domain/valuation';
import { INVENTORY } from '../domain/permissions';
import { CompanyAccess } from './company-access.service';
import { isResentCreate, maybePersonRef, personRef } from './support';

/** Store roles, Accounts, CEO: see a company's requests with values. */
const STORE_SEE = [INVENTORY.view, INVENTORY.requestsApprove];
type Reason = 'cancelled' | 'expired' | 'ticket_closed';

/** What the caller is to the requests: whose companies' requests they see as the store, whose they approve, which departments they head. */
interface Caller { personId: number; seeCompanies: number[]; approveCompanies: number[]; headed: number[]; allDepartments: boolean; departmentView: boolean }

/**
 * Part requests (Froid's "Parts required"). A Parts requester assigned to a ticket whose type uses parts (policy
 * inventory.parts.ticket_types), or a person with a cross-company grant on that ticket, asks for parts. The store
 * in-charge approves (and the ticket's department head too when the estimate is above policy
 * inventory.requests.head_approval_above_paise); once fully approved the stock is reserved until the request is issued,
 * cancelled, expires (inventory:daily) or its ticket closes. Nobody approves their own request. Requesters never see values.
 */
@Injectable()
export class RequestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(RequestsRepository) private readonly repo: RequestsRepository,
    @Inject(StockRepository) private readonly stock: StockRepository,
    @Inject(CompanyAccess) private readonly access: CompanyAccess,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /** What a requester may ask for on a ticket: active stocked items of its company, in stock or not; no quantities, no values. */
  async items(ctx: RequestContext, q: RequestItemsQuery): Promise<RequestItem[]> {
    const t = await this.ticketFor(ctx, q.ticket);
    const caller = await this.caller(ctx);
    if (!(await this.basis(this.db, ctx, t)) && !seesValues(caller, t)) throw cannotRequest('You cannot request parts for this ticket');
    return (await this.repo.requestableItems(this.db, t.legalEntityId, q.search, q.limit)).map((r) => ({
      publicId: r.publicId, code: r.code, name: r.name, unit: { publicId: r.unitPublicId, code: r.unitCode, name: r.unitName, decimals: r.unitDecimals },
      inStock: toScaled(r.free, 4) > 0n,
    }));
  }

  /** A new request for a ticket. The same publicId again answers the stored request (created: false). */
  async create(ctx: RequestContext, req: CreatePartRequest): Promise<{ request: PartRequest; created: boolean }> {
    if (await this.access.alreadyStored(ctx, partRequests, req.publicId)) return { request: await this.get(ctx, req.publicId as string), created: false };
    const t = await this.ticketFor(ctx, req.ticketPublicId);
    if (!TICKET_TAKES_PARTS.includes(t.status)) throw new AppError('INVENTORY_TICKET_CLOSED', 409, `Ticket ${t.number} is ${t.status}: it takes no more parts`);
    const basis = await this.basis(this.db, ctx, t);
    if (!basis) {
      throw cannotRequest('You can request parts only for tickets you are assigned to whose type uses parts (Parts requester role), or with a grant for that ticket');
    }
    const items = await this.stock.items(this.db, ctx.tenantId, req.lines.map((l) => l.itemPublicId));
    const limit = await this.core.getPolicy(ctx.tenantId, 'inventory.requests.head_approval_above_paise', t.legalEntityId, todayIst());
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        const valuations = await this.valuations(tx, [...items.values()].map((i) => i.id));
        const lines = req.lines.map((l, i) => {
          const item = items.get(l.itemPublicId);
          if (!item || item.legalEntityId !== t.legalEntityId || item.status !== 'active' || !item.isStocked) {
            throw new AppError('INVENTORY_UNKNOWN_ITEM', 400, `Line ${i + 1}: that item cannot be requested for ${t.company} (unknown, inactive or not stocked)`);
          }
          if (!fitsDecimals(l.quantity, item.baseUnitDecimals)) {
            throw new AppError('INVENTORY_QUANTITY_DECIMALS', 400, `Line ${i + 1}: use ${item.baseUnitDecimals === 0 ? 'whole numbers' : `at most ${item.baseUnitDecimals} decimals`} for ${item.baseUnitCode}`);
          }
          const quantity = toScaled(l.quantity, 4);
          return { lineNo: i + 1, itemId: item.id, quantity, estimatedValue: valueAt(quantity, valuations.get(item.id) ?? 0n) };
        });
        const estimate = lines.reduce((s, l) => s + l.estimatedValue, 0n);
        const number = documentNumber('request', await this.stock.nextNumber(tx, ctx.tenantId, t.legalEntityId, 'request'));
        const id = await this.repo.insertRequest(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: t.legalEntityId, number, ticketId: t.id,
          requestedBy: ctx.personId, grantId: basis.grantId, note: req.note ?? null, estimatedValueMinor: estimate, needsHeadApproval: needsHeadApproval(estimate, limit) });
        await this.repo.insertLines(tx, ctx.tenantId, t.legalEntityId, id, lines);
        await this.audit(tx, ctx, 'inventory.request.created', publicId, t.legalEntityId, `Requested parts ${number} for ticket ${t.number} (${lines.length} item${lines.length === 1 ? '' : 's'})`,
          { number, ticket: t.number, crossCompany: basis.grantId !== null });
        const store = await this.access.workingIn(await this.core.peopleWithRoles(tx, ctx.tenantId, ['store_incharge']), t.legalEntityId);
        await this.core.notify(tx, { tenantId: ctx.tenantId, legalEntityId: t.legalEntityId, alertCode: 'inventory.request_submitted',
          title: `Part request ${number} for ticket ${t.number}`, body: `${lines.length} item${lines.length === 1 ? '' : 's'} waiting for the store.`,
          link: 'inv-requests', dedupeKey: `inventory.request_submitted:${publicId}`, recipients: { personIds: store }, except: [ctx.personId] });
        if (needsHeadApproval(estimate, limit) && t.headPersonId) {
          await this.core.notify(tx, { tenantId: ctx.tenantId, legalEntityId: t.legalEntityId, alertCode: 'inventory.request_head_approval',
            title: `Part request ${number} needs your approval`, body: `It is above the value limit, for ticket ${t.number} in your department.`,
            link: 'inv-requests', dedupeKey: `inventory.request_head_approval:${publicId}`, recipients: { personIds: [t.headPersonId] }, except: [ctx.personId] });
        }
      });
    } catch (err) {
      if (isResentCreate(err)) return { request: await this.get(ctx, publicId), created: false };
      throw err;
    }
    return { request: await this.get(ctx, publicId), created: true };
  }

  async get(ctx: RequestContext, publicId: string): Promise<PartRequest> {
    const r = await this.visible(this.db, ctx, publicId);
    const [request] = await this.build(this.db, ctx, await this.caller(ctx), [r.id]);
    return request;
  }

  async list(ctx: RequestContext, q: PartRequestsQuery): Promise<PartRequestList> {
    const caller = await this.caller(ctx);
    let companyIds: number[] | undefined;
    if (q.company) companyIds = [(await this.access.companyId(ctx, q.company)) ?? -1];
    let ticketId: number | undefined;
    if (q.ticket) ticketId = (await this.repo.ticket(this.db, ctx.tenantId, q.ticket))?.id ?? -1;
    const { ids, total } = await this.repo.listIds(ctx.tenantId, visibility(caller), { companyIds, status: q.status, ticketId, mine: q.mine }, q.page, q.pageSize);
    return { items: await this.build(this.db, ctx, caller, ids), page: q.page, pageSize: q.pageSize, total };
  }

  /**
   * Approves as the store in-charge (choosing where to reserve from) and/or as the ticket's department head. When every
   * approval the request needs is in, its stock is reserved (409 INVENTORY_NOT_ENOUGH_AVAILABLE when there is not enough free).
   */
  async approve(ctx: RequestContext, publicId: string, body: ApprovePartRequest): Promise<PartRequest> {
    const found = await this.visible(this.db, ctx, publicId);
    const caller = await this.caller(ctx);
    await this.db.transaction(async (tx) => {
      const r = await this.repo.lockRequestById(tx, found.id);
      if (r.status !== 'pending') throw new AppError('INVENTORY_REQUEST_NOT_PENDING', 409, `${r.number} is ${r.status}`);
      if (r.requestedBy === ctx.personId) throw new AppError('INVENTORY_OWN_REQUEST', 403, 'Nobody approves their own request');
      const t = await this.repo.ticketById(tx, r.ticketId) as TicketFacts;
      const roles = approvalRoles({ isRequester: false, canStore: caller.approveCompanies.includes(r.legalEntityId), canHead: canHead(caller, t) },
        { needsHead: r.needsHeadApproval, storeApproved: r.storeApprovedBy !== null, headApproved: r.headApprovedBy !== null });
      if (!roles.asStore && !roles.asHead) throw new AppError('INVENTORY_NOT_YOUR_APPROVAL', 403, `There is nothing for you to approve on ${r.number}`);
      const lines = await this.repo.lines(tx, [r.id]);
      if (body.locations?.length) {
        if (!roles.asStore) throw new AppError('INVENTORY_LOCATIONS_FOR_STORE', 400, 'Only the store in-charge chooses where to reserve from');
        const locs = await this.stock.locations(tx, ctx.tenantId, body.locations.map((l) => l.locationPublicId));
        for (const choice of body.locations) {
          const line = lines.find((l) => l.lineNo === choice.lineNo);
          const loc = locs.get(choice.locationPublicId);
          if (!line) throw new AppError('INVENTORY_UNKNOWN_LINE', 400, `${r.number} has no line ${choice.lineNo}`);
          if (!loc || loc.legalEntityId !== r.legalEntityId) throw new AppError('INVENTORY_UNKNOWN_LOCATION', 400, `That location does not belong to ${t.company}`);
          if (loc.status !== 'active' || !USABLE.includes(loc.type)) throw new AppError('INVENTORY_LOCATION_USE', 400, `Stock is reserved in an active store, rack, bin, work area or testing space, not ${loc.code}`);
          line.locationId = loc.id;
          await this.repo.setLineLocation(tx, line.id, loc.id);
        }
      }
      const now = new Date();
      const patch: Partial<typeof partRequests.$inferInsert> = {};
      if (roles.asStore) Object.assign(patch, { storeApprovedBy: ctx.personId, storeApprovedAt: now });
      if (roles.asHead) Object.assign(patch, { headApprovedBy: ctx.personId, headApprovedAt: now });
      const approved = fullyApproved({ needsHead: r.needsHeadApproval, storeApproved: r.storeApprovedBy !== null || roles.asStore, headApproved: r.headApprovedBy !== null || roles.asHead });
      if (approved) {
        const today = todayIst();
        const until = body.reserveUntil ?? addDays(today, await this.core.getPolicy(ctx.tenantId, 'inventory.requests.reserve_days', r.legalEntityId, today));
        if (until < today) throw new AppError('INVENTORY_RESERVE_DATE', 400, 'The reservation must run until today or later');
        await this.reserve(tx, ctx, r, lines);
        Object.assign(patch, { status: 'approved', reserveUntil: until });
      }
      await this.repo.updateRequest(tx, r.id, patch);
      const as = [roles.asStore ? 'store in-charge' : null, roles.asHead ? 'department head' : null].filter(Boolean).join(' and ');
      await this.audit(tx, ctx, 'inventory.request.approved', r.publicId, r.legalEntityId, `Approved ${r.number} as ${as}${approved ? '; stock reserved' : ''}`,
        { number: r.number, asStore: roles.asStore, asHead: roles.asHead, reserved: approved });
      if (approved) {
        await this.core.notify(tx, { tenantId: ctx.tenantId, legalEntityId: r.legalEntityId, alertCode: 'inventory.request_decided',
          title: `Part request ${r.number} was approved`, body: 'The stock is reserved for you.', link: 'inv-requests',
          dedupeKey: `inventory.request_decided:${r.publicId}`, recipients: { personIds: [r.requestedBy] }, except: [ctx.personId] });
      }
    });
    return this.get(ctx, publicId);
  }

  async reject(ctx: RequestContext, publicId: string, body: RejectPartRequest): Promise<PartRequest> {
    const found = await this.visible(this.db, ctx, publicId);
    const caller = await this.caller(ctx);
    await this.db.transaction(async (tx) => {
      const r = await this.repo.lockRequestById(tx, found.id);
      if (r.status !== 'pending') throw new AppError('INVENTORY_REQUEST_NOT_PENDING', 409, `${r.number} is ${r.status}`);
      if (r.requestedBy === ctx.personId) throw new AppError('INVENTORY_OWN_REQUEST', 403, 'Nobody decides their own request');
      const t = await this.repo.ticketById(tx, r.ticketId) as TicketFacts;
      if (!caller.approveCompanies.includes(r.legalEntityId) && !(r.needsHeadApproval && canHead(caller, t))) {
        throw new AppError('INVENTORY_NOT_YOUR_APPROVAL', 403, `You do not decide ${r.number}`);
      }
      await this.repo.updateRequest(tx, r.id, { status: 'rejected', decidedBy: ctx.personId, decidedAt: new Date(), decisionReason: body.reason });
      await this.audit(tx, ctx, 'inventory.request.rejected', r.publicId, r.legalEntityId, `Rejected ${r.number}`, { number: r.number, reason: body.reason });
      await this.core.notify(tx, { tenantId: ctx.tenantId, legalEntityId: r.legalEntityId, alertCode: 'inventory.request_decided',
        title: `Part request ${r.number} was rejected`, body: `Reason: ${body.reason}`, link: 'inv-requests',
        dedupeKey: `inventory.request_decided:${r.publicId}`, recipients: { personIds: [r.requestedBy] }, except: [ctx.personId] });
    });
    return this.get(ctx, publicId);
  }

  /** The requester or the store in-charge cancels a pending or approved request; any reserved stock is released. */
  async cancel(ctx: RequestContext, publicId: string, body: CancelPartRequest): Promise<PartRequest> {
    const found = await this.visible(this.db, ctx, publicId);
    const caller = await this.caller(ctx);
    await this.db.transaction(async (tx) => {
      const r = await this.repo.lockRequestById(tx, found.id);
      if (!['pending', 'approved'].includes(r.status)) throw new AppError('INVENTORY_REQUEST_NOT_OPEN', 409, `${r.number} is ${r.status}`);
      if (r.requestedBy !== ctx.personId && !caller.approveCompanies.includes(r.legalEntityId)) {
        throw new AppError('INVENTORY_NOT_YOURS', 403, 'Only the requester or the store in-charge cancels a request');
      }
      await this.release(tx, ctx.tenantId, r, 'cancelled');
      await this.repo.updateRequest(tx, r.id, { status: 'cancelled', decidedBy: ctx.personId, decidedAt: new Date(), decisionReason: body.reason ?? null });
      await this.audit(tx, ctx, 'inventory.request.cancelled', r.publicId, r.legalEntityId, `Cancelled ${r.number}`, { number: r.number, reason: body.reason ?? null });
    });
    return this.get(ctx, publicId);
  }

  /** A ticket's requests and the parts issued and returned on it; values only for the store, Accounts, CEO and its department head. */
  async ticketParts(ctx: RequestContext, ticketPublicId: string): Promise<TicketParts> {
    const t = await this.ticketFor(ctx, ticketPublicId);
    const caller = await this.caller(ctx);
    const basis = await this.basis(this.db, ctx, t);
    const values = seesValues(caller, t);
    const ids = await this.repo.idsOfTicket(this.db, t.id);
    const requests = await this.build(this.db, ctx, caller, ids);
    const own = requests.some((r) => r.requestedBy.publicId === ctx.personPublicId);
    if (!basis && !values && !own) throw new AppError('INVENTORY_TICKET_NOT_VISIBLE', 404, 'Unknown ticket');
    const { docs, lines } = await this.repo.ticketDocuments(this.db, t.id);
    return {
      ticket: { publicId: t.publicId, number: t.number, title: t.title, company: t.company },
      canRequest: basis !== null && TICKET_TAKES_PARTS.includes(t.status), showsValues: values,
      requests,
      documents: docs.map((d) => ({
        publicId: d.publicId, number: d.number, type: d.type as 'issue' | 'return', status: d.status, documentDate: d.documentDate,
        lines: lines.filter((l) => l.documentId === d.id).map((l) => ({
          lineNo: l.lineNo, item: { publicId: l.itemPublicId, code: l.itemCode, name: l.itemName },
          unit: { publicId: l.unitPublicId, code: l.unitCode, name: l.unitName, decimals: l.unitDecimals }, quantity: Number(l.quantity),
          batchNo: l.batchNo, serialNo: l.serialNo, valueMinor: values ? Number(l.value) : null,
        })),
      })),
    };
  }

  /** When a ticket is completed or cancelled (called by tickets in its own transaction): open requests close, their stock is freed. */
  async releaseForTicket(tx: Tx, tenantId: number, ticketId: number): Promise<void> {
    for (const id of await this.repo.openRequestsOfTicket(tx, ticketId)) {
      const r = await this.repo.lockRequestById(tx, id);
      if (!['pending', 'approved'].includes(r.status)) continue;
      await this.release(tx, tenantId, r, 'ticket_closed');
      await this.repo.updateRequest(tx, r.id, { status: 'closed' });
      await this.core.audit(tx, { tenantId, actorPersonId: null, action: 'inventory.request.closed', entity: 'inventory_request', entityPublicId: r.publicId,
        legalEntityId: r.legalEntityId, summary: `Closed ${r.number}: its ticket was completed or cancelled; reserved stock released`, details: { number: r.number } });
    }
  }

  /** The nightly part of inventory:daily: reservations past their date expire; requests of closed tickets close. */
  async releaseDue(): Promise<{ expired: number; closed: number }> {
    const due = await this.repo.toRelease(this.db, todayIst());
    let expired = 0;
    let closed = 0;
    for (const d of due) {
      await this.db.transaction(async (tx) => {
        const r = await this.repo.lockRequestById(tx, d.id);
        if (!['pending', 'approved'].includes(r.status)) return;
        if (d.why === 'expired' && (r.status !== 'approved' || (r.reserveUntil as string) >= todayIst())) return;
        await this.release(tx, d.tenantId, r, d.why);
        await this.repo.updateRequest(tx, r.id, { status: d.why === 'expired' ? 'expired' : 'closed' });
        await this.core.audit(tx, { tenantId: d.tenantId, actorPersonId: null, action: `inventory.request.${d.why === 'expired' ? 'expired' : 'closed'}`,
          entity: 'inventory_request', entityPublicId: r.publicId, legalEntityId: r.legalEntityId,
          summary: d.why === 'expired' ? `${r.number} expired on ${r.reserveUntil}; reserved stock released` : `Closed ${r.number}: its ticket is closed; reserved stock released`,
          details: { number: r.number } });
        if (d.why === 'expired') expired++; else closed++;
      });
    }
    return { expired, closed };
  }

  // ---- reservations ----

  /** Reserves every line of a fully approved request (the request row is locked; balances locked in the usual order). */
  private async reserve(tx: Tx, ctx: RequestContext, r: RequestRow, lines: Awaited<ReturnType<RequestsRepository['lines']>>): Promise<void> {
    const items = await this.stock.itemsById(tx, lines.map((l) => l.itemId));
    const usable = await this.stock.usableLocations(tx, r.legalEntityId);
    const plan: { requestLineId: number; itemId: number; locationId: number; batchId: number | null; qty: bigint }[] = [];
    for (const line of [...lines].sort((a, b) => a.itemId - b.itemId)) {
      const item = items.get(line.itemId) as StockItem;
      const qty = line.quantity - line.issuedQty;
      const free = await this.stock.availableByLocation(tx, r.legalEntityId, item.id);
      const candidates = line.locationId !== null ? usable.filter((l) => l.id === line.locationId)
        : [...usable].sort((a, b) => rank(a, b, item, free));
      const location = candidates.find((l) => (free.get(l.id) ?? 0n) >= qty);
      if (!location) {
        const total = usable.reduce((s, l) => s + ((free.get(l.id) ?? 0n) > 0n ? free.get(l.id) as bigint : 0n), 0n);
        const where = line.locationId !== null ? ` in ${candidates[0]?.code ?? 'that location'}` : ' in any one location';
        throw new AppError('INVENTORY_NOT_ENOUGH_AVAILABLE', 409,
          `Not enough free ${item.code} to reserve${where}: ${trim(fromScaled(qty, 4))} needed, ${trim(fromScaled(total, 4))} free in the company`);
      }
      if (line.locationId === null) await this.repo.setLineLocation(tx, line.id, location.id);
      const parts = item.tracking === 'batch' ? allocateFefo(await this.stock.batchStock(tx, r.legalEntityId, item.id, location.id), qty) : [{ batchId: null, qty }];
      if (!parts) throw new AppError('INVENTORY_NOT_ENOUGH_AVAILABLE', 409, `Not enough free ${item.code} in ${location.code} to reserve`);
      for (const p of parts) plan.push({ requestLineId: line.id, itemId: item.id, locationId: location.id, batchId: p.batchId, qty: p.qty });
    }
    const balances = await this.stock.lockBalances(tx, ctx.tenantId, r.legalEntityId, plan);
    for (const p of plan) {
      const b = balances.get(placeKey(p)) as { id: number; onHand: bigint; reserved: bigint };
      if (b.onHand - b.reserved < p.qty) throw new AppError('INVENTORY_NOT_ENOUGH_AVAILABLE', 409, 'Someone took that stock at the same moment; approve again');
      b.reserved += p.qty;
    }
    for (const b of balances.values()) await this.stock.saveBalance(tx, b.id, b);
    await this.repo.insertReservations(tx, ctx.tenantId, r.legalEntityId, plan);
  }

  /** Frees what a request still holds (its row is locked by the caller). */
  private async release(tx: Tx, tenantId: number, r: RequestRow, reason: Reason): Promise<void> {
    const lines = await this.repo.lines(tx, [r.id]);
    const held = await this.repo.openReservations(tx, lines.map((l) => l.id));
    if (held.length === 0) return;
    const balances = await this.stock.lockBalances(tx, tenantId, r.legalEntityId, held);
    for (const h of held) (balances.get(placeKey(h)) as { reserved: bigint }).reserved -= h.quantity;
    for (const b of balances.values()) await this.stock.saveBalance(tx, b.id, b);
    for (const h of held) await this.repo.setReservation(tx, h.id, 0n, reason);
  }

  // ---- who and what ----

  /**
   * Why the caller may request on this ticket: an open grant for it (cross-company), or the Parts requester role with a
   * current job in its company, assigned to it, on a ticket type that uses parts. null: they may not.
   */
  private async basis(conn: Conn, ctx: RequestContext, t: TicketFacts): Promise<{ grantId: number | null } | null> {
    const grantId = await this.repo.activeGrant(conn, ctx.personId, t.id, todayIst());
    if (grantId !== null) return { grantId };
    if (!ctx.permissions[INVENTORY.request] || !(await this.access.mayUse(ctx, [INVENTORY.request], t.legalEntityId))) return null;
    if (!(await this.repo.isAssignee(conn, t.id, ctx.personId))) return null;
    const types = await this.core.getPolicy(ctx.tenantId, 'inventory.parts.ticket_types', t.legalEntityId, todayIst());
    return types.includes(t.typeCode) ? { grantId: null } : null;
  }

  private async caller(ctx: RequestContext): Promise<Caller> {
    const view = ctx.permissions[INVENTORY.departmentView];
    return {
      personId: ctx.personId,
      seeCompanies: (await this.access.reachable(ctx, STORE_SEE)).map((c) => c.id),
      approveCompanies: (await this.access.reachable(ctx, [INVENTORY.requestsApprove])).map((c) => c.id),
      headed: view ? await this.repo.departmentsHeadedBy(this.db, ctx.tenantId, ctx.personId) : [],
      allDepartments: view === 'all',
      departmentView: view !== undefined,
    };
  }

  private async ticketFor(ctx: RequestContext, publicId: string): Promise<TicketFacts> {
    const t = await this.repo.ticket(this.db, ctx.tenantId, publicId);
    if (!t) throw new AppError('INVENTORY_UNKNOWN_TICKET', 404, 'Unknown ticket');
    return t;
  }

  /** A request the caller may see: their own, the store's for its companies, the head's for their departments, or one on a ticket they may request on. */
  private async visible(conn: Conn, ctx: RequestContext, publicId: string): Promise<RequestRow> {
    const r = await this.repo.request(conn, ctx.tenantId, publicId);
    const notFound = new AppError('INVENTORY_REQUEST_NOT_FOUND', 404, 'Unknown part request');
    if (!r) throw notFound;
    if (r.requestedBy === ctx.personId) return r;
    const t = await this.repo.ticketById(conn, r.ticketId) as TicketFacts;
    if (seesValues(await this.caller(ctx), t) || await this.basis(conn, ctx, t)) return r;
    throw notFound;
  }

  private async valuations(conn: Conn, itemIds: number[]): Promise<Map<number, bigint>> {
    const avg = new Map<number, bigint>();
    if (itemIds.length === 0) return avg;
    const rows = await this.stock.averages(conn, itemIds);
    for (const r of rows) avg.set(r.itemId, r.avg);
    return avg;
  }

  private async build(conn: Conn, ctx: RequestContext, caller: Caller, ids: number[]): Promise<PartRequest[]> {
    const { heads, lines, reservations } = await this.repo.details(conn, ids);
    const byId = new Map(heads.map((h) => [h.id, h]));
    return ids.flatMap((id) => {
      const h = byId.get(id);
      if (!h) return [];
      const t = { legalEntityId: h.legalEntityId, headPersonId: h.headPersonId };
      const values = seesValues(caller, t);
      const isRequester = h.requestedBy === caller.personId;
      const roles = approvalRoles({ isRequester, canStore: caller.approveCompanies.includes(h.legalEntityId), canHead: canHead(caller, t) },
        { needsHead: h.needsHeadApproval, storeApproved: h.storeApprovedBy !== null, headApproved: h.headApprovedBy !== null });
      return [{
        publicId: h.publicId, company: h.company, number: h.number, status: h.status,
        ticket: { publicId: h.ticketPublicId, number: h.ticketNumber, title: h.ticketTitle },
        requestedBy: personRef(h.requesterPublicId ?? '', h.requesterName ?? ''), crossCompany: h.grantId !== null, note: h.note,
        needsHeadApproval: h.needsHeadApproval,
        storeApprovedBy: maybePersonRef(h.storeApproverPublicId, h.storeApproverName), storeApprovedAt: h.storeApprovedAt?.toISOString() ?? null,
        headApprovedBy: maybePersonRef(h.headApproverPublicId, h.headApproverName), headApprovedAt: h.headApprovedAt?.toISOString() ?? null,
        decidedBy: maybePersonRef(h.deciderPublicId, h.deciderName), decisionReason: h.decisionReason, reserveUntil: h.reserveUntil,
        estimatedValueMinor: values ? Number(h.estimatedValue) : null, currency: h.currency,
        lines: lines.filter((l) => l.requestId === id).map((l) => {
          const held = reservations.filter((x) => x.requestLineId === l.id);
          return {
            lineNo: l.lineNo, item: { publicId: l.itemPublicId, code: l.itemCode, name: l.itemName },
            unit: { publicId: l.unitPublicId, code: l.unitCode, name: l.unitName, decimals: l.unitDecimals },
            quantity: Number(l.quantity), issued: Number(l.issuedQty), reserved: held.reduce((s, x) => s + Number(x.quantity), 0),
            location: l.locationPublicId === null ? null : { publicId: l.locationPublicId, type: l.locationType as LocationType, code: l.locationCode ?? '', name: l.locationName ?? '' },
            reservations: held.map((x) => ({ location: { publicId: x.locationPublicId, type: x.locationType, code: x.locationCode, name: x.locationName },
              batchNo: x.batchNo, expiryDate: x.expiryDate, quantity: Number(x.quantity) })),
            estimatedValueMinor: values ? Number(l.estimatedValue) : null,
          };
        }),
        canApprove: h.status === 'pending' && (roles.asStore || roles.asHead),
        canCancel: ['pending', 'approved'].includes(h.status) && (isRequester || caller.approveCompanies.includes(h.legalEntityId)),
        createdAt: h.createdAt.toISOString(),
      }];
    });
  }

  private audit(tx: Tx, ctx: RequestContext, action: string, publicId: string, legalEntityId: number, summary: string, details: Record<string, unknown>) {
    return this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action, entity: 'inventory_request', entityPublicId: publicId, legalEntityId, summary, details });
  }
}

const USABLE: LocationType[] = ['store', 'rack', 'bin', 'work_area', 'testing'];
const trim = (s: string) => s.replace(/\.?0+$/, '') || '0';
const cannotRequest = (message: string) => new AppError('INVENTORY_CANNOT_REQUEST', 403, message);

/** The store (view or approve in the company), Accounts and CEO, and the ticket's department head see values. */
function seesValues(c: Caller, t: { legalEntityId: number; headPersonId: number | null }): boolean {
  return c.seeCompanies.includes(t.legalEntityId) || canHead(c, t);
}

/** The ticket's department head (with the department view), or the department view with scope all. */
function canHead(c: Caller, t: { headPersonId: number | null }): boolean {
  return c.allDepartments || (c.departmentView && t.headPersonId === c.personId);
}

function visibility(c: Caller): RequestVisibility {
  return { personId: c.personId, storeCompanyIds: c.seeCompanies, headedDepartmentIds: c.departmentView ? c.headed : [], allDepartments: c.allDepartments };
}

/** Where to reserve from when the store in-charge did not choose: the item's default location first, then the most free. */
function rank(a: StockLocation, b: StockLocation, item: StockItem, free: Map<number, bigint>): number {
  if (a.id === item.defaultLocationId) return -1;
  if (b.id === item.defaultLocationId) return 1;
  const fa = free.get(a.id) ?? 0n;
  const fb = free.get(b.id) ?? 0n;
  return fa === fb ? a.id - b.id : fa > fb ? -1 : 1;
}
