import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, count, desc, eq, gte, inArray, isNull, or, sql, SQL } from 'drizzle-orm';
import type { LocationType, PartRequestStatus } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { departments, employments } from '../../hrms/people/schema';
import { ticketAssignees, tickets, ticketTypes } from '../../tickets/schema';
import { crossCompanyGrants, items, locations, partRequestLines, partRequests, stockBalances, stockBatches, stockDocumentLines, stockDocuments, stockReservations, units } from '../schema';
import { toScaled, fromScaled } from '../domain/valuation';

/** A ticket as part requests need it: company, status, department head and type code. */
export interface TicketFacts {
  id: number; publicId: string; number: string; title: string; legalEntityId: number; company: string; status: string;
  departmentId: number; headPersonId: number | null; typeCode: string;
}
export interface RequestRow {
  id: number; publicId: string; legalEntityId: number; number: string; ticketId: number; requestedBy: number; grantId: number | null;
  status: PartRequestStatus; needsHeadApproval: boolean; storeApprovedBy: number | null; headApprovedBy: number | null; reserveUntil: string | null;
}
export interface RequestLineRow { id: number; lineNo: number; itemId: number; quantity: bigint; locationId: number | null; issuedQty: bigint }
export interface ReservationRow { id: number; requestLineId: number; itemId: number; locationId: number; batchId: number | null; quantity: bigint; expiryDate: string | null }
export interface RequestVisibility { personId: number; storeCompanyIds: number[]; headedDepartmentIds: number[]; allDepartments: boolean }

const requester = aliasedTable(persons, 'requester');
const storeApprover = aliasedTable(persons, 'store_approver');
const headApprover = aliasedTable(persons, 'head_approver');
const decider = aliasedTable(persons, 'decider');
const grantee = aliasedTable(persons, 'grantee');
const granter = aliasedTable(persons, 'granter');
const ender = aliasedTable(persons, 'ender');

/** Writes inventory.part_requests, part_request_lines, stock_reservations and cross_company_grants; reads tickets, departments and people. */
@Injectable()
export class RequestsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- tickets and who may request ----

  async ticket(conn: Conn, tenantId: number, publicId: string): Promise<TicketFacts | undefined> {
    const [row] = await this.ticketQuery(conn).where(and(eq(tickets.tenantId, tenantId), eq(tickets.publicId, publicId)));
    return row;
  }

  async ticketById(conn: Conn, id: number): Promise<TicketFacts | undefined> {
    const [row] = await this.ticketQuery(conn).where(eq(tickets.id, id));
    return row;
  }

  private ticketQuery(conn: Conn) {
    return conn.select({
      id: tickets.id, publicId: tickets.publicId, number: tickets.number, title: tickets.title, legalEntityId: tickets.legalEntityId, company: legalEntities.code,
      status: tickets.status, departmentId: tickets.departmentId, headPersonId: departments.headPersonId, typeCode: ticketTypes.code,
    }).from(tickets)
      .innerJoin(legalEntities, eq(legalEntities.id, tickets.legalEntityId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, tickets.typeId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId));
  }

  /** Whether the person is assigned to the ticket now (on any of their jobs). */
  async isAssignee(conn: Conn, ticketId: number, personId: number): Promise<boolean> {
    const [row] = await conn.select({ id: ticketAssignees.id }).from(ticketAssignees).innerJoin(employments, eq(employments.id, ticketAssignees.employmentId))
      .where(and(eq(ticketAssignees.ticketId, ticketId), isNull(ticketAssignees.endedAt), eq(employments.personId, personId))).limit(1);
    return row !== undefined;
  }

  /** The person's open grant on the ticket that runs until at least `today`, if any. */
  async activeGrant(conn: Conn, personId: number, ticketId: number, today: string): Promise<number | null> {
    const [row] = await conn.select({ id: crossCompanyGrants.id }).from(crossCompanyGrants)
      .where(and(eq(crossCompanyGrants.personId, personId), eq(crossCompanyGrants.ticketId, ticketId), isNull(crossCompanyGrants.endedAt),
        gte(crossCompanyGrants.validUntil, today)));
    return row?.id ?? null;
  }

  async departmentsHeadedBy(conn: Conn, tenantId: number, personId: number): Promise<number[]> {
    const rows = await conn.select({ id: departments.id }).from(departments).where(and(eq(departments.tenantId, tenantId), eq(departments.headPersonId, personId)));
    return rows.map((r) => r.id);
  }

  // ---- requests ----

  async insertRequest(tx: Tx, v: typeof partRequests.$inferInsert): Promise<number> {
    const [row] = await tx.insert(partRequests).values(v).returning({ id: partRequests.id });
    return row.id;
  }

  async insertLines(tx: Tx, tenantId: number, legalEntityId: number, requestId: number, lines: { lineNo: number; itemId: number; quantity: bigint; estimatedValue: bigint }[]): Promise<void> {
    await tx.insert(partRequestLines).values(lines.map((l) => ({ tenantId, legalEntityId, requestId, lineNo: l.lineNo, itemId: l.itemId, quantity: fromScaled(l.quantity, 4),
      estimatedValueMinor: l.estimatedValue })));
  }

  async request(conn: Conn, tenantId: number, publicId: string, lock = false): Promise<RequestRow | undefined> {
    const q = conn.select({
      id: partRequests.id, publicId: partRequests.publicId, legalEntityId: partRequests.legalEntityId, number: partRequests.number, ticketId: partRequests.ticketId,
      requestedBy: partRequests.requestedBy, grantId: partRequests.grantId, status: sql<PartRequestStatus>`${partRequests.status}`,
      needsHeadApproval: partRequests.needsHeadApproval, storeApprovedBy: partRequests.storeApprovedBy, headApprovedBy: partRequests.headApprovedBy,
      reserveUntil: partRequests.reserveUntil,
    }).from(partRequests).where(and(eq(partRequests.tenantId, tenantId), eq(partRequests.publicId, publicId)));
    const [row] = lock ? await q.for('update') : await q;
    return row;
  }

  async lockRequestById(tx: Tx, id: number): Promise<RequestRow> {
    const [row] = await tx.select({
      id: partRequests.id, publicId: partRequests.publicId, legalEntityId: partRequests.legalEntityId, number: partRequests.number, ticketId: partRequests.ticketId,
      requestedBy: partRequests.requestedBy, grantId: partRequests.grantId, status: sql<PartRequestStatus>`${partRequests.status}`,
      needsHeadApproval: partRequests.needsHeadApproval, storeApprovedBy: partRequests.storeApprovedBy, headApprovedBy: partRequests.headApprovedBy,
      reserveUntil: partRequests.reserveUntil,
    }).from(partRequests).where(eq(partRequests.id, id)).for('update');
    return row;
  }

  async updateRequest(tx: Tx, id: number, patch: Partial<typeof partRequests.$inferInsert>): Promise<void> {
    await tx.update(partRequests).set(patch).where(eq(partRequests.id, id));
  }

  async lines(conn: Conn, requestIds: number[]): Promise<(RequestLineRow & { requestId: number })[]> {
    if (requestIds.length === 0) return [];
    const rows = await conn.select({ id: partRequestLines.id, requestId: partRequestLines.requestId, lineNo: partRequestLines.lineNo, itemId: partRequestLines.itemId,
      quantity: partRequestLines.quantity, locationId: partRequestLines.locationId, issuedQty: partRequestLines.issuedQty })
      .from(partRequestLines).where(inArray(partRequestLines.requestId, requestIds)).orderBy(asc(partRequestLines.requestId), asc(partRequestLines.lineNo));
    return rows.map((r) => ({ ...r, quantity: toScaled(r.quantity, 4), issuedQty: toScaled(r.issuedQty, 4) }));
  }

  async setLineLocation(tx: Tx, lineId: number, locationId: number): Promise<void> {
    await tx.update(partRequestLines).set({ locationId }).where(eq(partRequestLines.id, lineId));
  }

  async setIssued(tx: Tx, lineId: number, issued: bigint): Promise<void> {
    await tx.update(partRequestLines).set({ issuedQty: fromScaled(issued, 4) }).where(eq(partRequestLines.id, lineId));
  }

  // ---- reservations ----

  /** Open reservations of these request lines, earliest batch expiry first. */
  async openReservations(conn: Conn, lineIds: number[]): Promise<ReservationRow[]> {
    if (lineIds.length === 0) return [];
    const rows = await conn.select({ id: stockReservations.id, requestLineId: stockReservations.requestLineId, itemId: stockReservations.itemId,
      locationId: stockReservations.locationId, batchId: stockReservations.batchId, quantity: stockReservations.quantity, expiryDate: stockBatches.expiryDate })
      .from(stockReservations).leftJoin(stockBatches, eq(stockBatches.id, stockReservations.batchId))
      .where(and(inArray(stockReservations.requestLineId, lineIds), isNull(stockReservations.releasedAt)))
      .orderBy(asc(stockReservations.requestLineId), sql`${stockBatches.expiryDate} NULLS LAST`, asc(stockReservations.id));
    return rows.map((r) => ({ ...r, quantity: toScaled(r.quantity, 4) }));
  }

  async insertReservations(tx: Tx, tenantId: number, legalEntityId: number, rows: { requestLineId: number; itemId: number; locationId: number; batchId: number | null; qty: bigint }[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(stockReservations).values(rows.map((r) => ({ tenantId, legalEntityId, requestLineId: r.requestLineId, itemId: r.itemId, locationId: r.locationId,
      batchId: r.batchId, reservedQty: fromScaled(r.qty, 4), quantity: fromScaled(r.qty, 4) })));
  }

  /** Lowers what a reservation still holds; at zero it is released with the reason. */
  async setReservation(tx: Tx, id: number, quantity: bigint, releaseReason: string | null): Promise<void> {
    await tx.update(stockReservations).set({ quantity: fromScaled(quantity, 4), ...(releaseReason ? { releasedAt: new Date(), releaseReason } : {}) })
      .where(eq(stockReservations.id, id));
  }

  /** Approved requests whose reservation ran out before `today`, and open requests whose ticket is completed or cancelled. */
  async toRelease(conn: Conn, today: string): Promise<{ id: number; tenantId: number; why: 'expired' | 'ticket_closed' }[]> {
    const rows = await conn.select({ id: partRequests.id, tenantId: partRequests.tenantId, status: partRequests.status, reserveUntil: partRequests.reserveUntil,
      ticketStatus: tickets.status }).from(partRequests).innerJoin(tickets, eq(tickets.id, partRequests.ticketId))
      .where(and(inArray(partRequests.status, ['pending', 'approved']), or(inArray(tickets.status, ['completed', 'cancelled']),
        and(eq(partRequests.status, 'approved'), sql`${partRequests.reserveUntil} < ${today}`))));
    return rows.map((r) => ({ id: r.id, tenantId: r.tenantId, why: ['completed', 'cancelled'].includes(r.ticketStatus) ? 'ticket_closed' : 'expired' }));
  }

  async openRequestsOfTicket(conn: Conn, ticketId: number): Promise<number[]> {
    const rows = await conn.select({ id: partRequests.id }).from(partRequests).where(and(eq(partRequests.ticketId, ticketId), inArray(partRequests.status, ['pending', 'approved'])));
    return rows.map((r) => r.id);
  }

  // ---- reading for the API ----

  private visibleWhere(v: RequestVisibility): SQL {
    return or(
      eq(partRequests.requestedBy, v.personId),
      v.storeCompanyIds.length ? inArray(partRequests.legalEntityId, v.storeCompanyIds) : undefined,
      v.allDepartments ? sql`true` : undefined,
      v.headedDepartmentIds.length ? inArray(tickets.departmentId, v.headedDepartmentIds) : undefined,
    ) as SQL;
  }

  async listIds(tenantId: number, v: RequestVisibility, f: { companyIds?: number[]; status?: string; ticketId?: number; mine?: boolean }, page: number, pageSize: number) {
    const where = and(eq(partRequests.tenantId, tenantId), this.visibleWhere(v),
      f.companyIds ? inArray(partRequests.legalEntityId, f.companyIds) : undefined, f.status ? eq(partRequests.status, f.status) : undefined,
      f.ticketId !== undefined ? eq(partRequests.ticketId, f.ticketId) : undefined, f.mine ? eq(partRequests.requestedBy, v.personId) : undefined);
    const [rows, [{ total }]] = await Promise.all([
      this.db.select({ id: partRequests.id }).from(partRequests).innerJoin(tickets, eq(tickets.id, partRequests.ticketId)).where(where)
        .orderBy(desc(partRequests.createdAt), desc(partRequests.id)).limit(pageSize).offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(partRequests).innerJoin(tickets, eq(tickets.id, partRequests.ticketId)).where(where),
    ]);
    return { ids: rows.map((r) => r.id), total };
  }

  async idsOfTicket(conn: Conn, ticketId: number): Promise<number[]> {
    const rows = await conn.select({ id: partRequests.id }).from(partRequests).where(eq(partRequests.ticketId, ticketId)).orderBy(desc(partRequests.id));
    return rows.map((r) => r.id);
  }

  /** Requests with the names the API shows, in the order of `ids`. */
  async details(conn: Conn, ids: number[]) {
    if (ids.length === 0) return { heads: [], lines: [], reservations: [] };
    const heads = await conn.select({
      id: partRequests.id, publicId: partRequests.publicId, legalEntityId: partRequests.legalEntityId, company: legalEntities.code, number: partRequests.number,
      status: sql<PartRequestStatus>`${partRequests.status}`, ticketId: partRequests.ticketId, ticketPublicId: tickets.publicId, ticketNumber: tickets.number,
      ticketTitle: tickets.title, ticketStatus: tickets.status, departmentId: tickets.departmentId, headPersonId: departments.headPersonId,
      requestedBy: partRequests.requestedBy, requesterPublicId: requester.publicId, requesterName: requester.displayName, grantId: partRequests.grantId,
      note: partRequests.note, needsHeadApproval: partRequests.needsHeadApproval,
      storeApprovedBy: partRequests.storeApprovedBy, storeApproverPublicId: storeApprover.publicId, storeApproverName: storeApprover.displayName, storeApprovedAt: partRequests.storeApprovedAt,
      headApprovedBy: partRequests.headApprovedBy, headApproverPublicId: headApprover.publicId, headApproverName: headApprover.displayName, headApprovedAt: partRequests.headApprovedAt,
      deciderPublicId: decider.publicId, deciderName: decider.displayName, decisionReason: partRequests.decisionReason, reserveUntil: partRequests.reserveUntil,
      estimatedValue: partRequests.estimatedValueMinor, currency: partRequests.currency, createdAt: partRequests.createdAt,
    }).from(partRequests)
      .innerJoin(legalEntities, eq(legalEntities.id, partRequests.legalEntityId))
      .innerJoin(tickets, eq(tickets.id, partRequests.ticketId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      // every alias of persons left-joined: Drizzle types an inner + left pair of one table as never (the requester always exists)
      .leftJoin(requester, eq(requester.id, partRequests.requestedBy))
      .leftJoin(storeApprover, eq(storeApprover.id, partRequests.storeApprovedBy))
      .leftJoin(headApprover, eq(headApprover.id, partRequests.headApprovedBy))
      .leftJoin(decider, eq(decider.id, partRequests.decidedBy))
      .where(inArray(partRequests.id, ids));
    const lines = await conn.select({
      id: partRequestLines.id, requestId: partRequestLines.requestId, lineNo: partRequestLines.lineNo, quantity: partRequestLines.quantity, issuedQty: partRequestLines.issuedQty,
      estimatedValue: partRequestLines.estimatedValueMinor, itemId: items.id, itemPublicId: items.publicId, itemCode: items.code, itemName: items.name,
      unitPublicId: units.publicId, unitCode: units.code, unitName: units.name, unitDecimals: units.decimals,
      locationPublicId: locations.publicId, locationType: sql<LocationType | null>`${locations.type}`, locationCode: locations.code, locationName: locations.name,
    }).from(partRequestLines)
      .innerJoin(items, eq(items.id, partRequestLines.itemId))
      .innerJoin(units, eq(units.id, items.baseUnitId))
      .leftJoin(locations, eq(locations.id, partRequestLines.locationId))
      .where(inArray(partRequestLines.requestId, ids)).orderBy(asc(partRequestLines.lineNo));
    const reservations = await conn.select({
      requestLineId: stockReservations.requestLineId, quantity: stockReservations.quantity, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate,
      locationPublicId: locations.publicId, locationType: sql<LocationType>`${locations.type}`, locationCode: locations.code, locationName: locations.name,
    }).from(stockReservations)
      .innerJoin(partRequestLines, eq(partRequestLines.id, stockReservations.requestLineId))
      .innerJoin(locations, eq(locations.id, stockReservations.locationId))
      .leftJoin(stockBatches, eq(stockBatches.id, stockReservations.batchId))
      .where(and(inArray(partRequestLines.requestId, ids), isNull(stockReservations.releasedAt))).orderBy(asc(stockReservations.id));
    return { heads, lines, reservations };
  }

  // ---- what a requester may ask for, and a ticket's parts ----

  /** Active stocked items of a company (search: code or name), with what is free in it (on hand - reserved, all locations). */
  async requestableItems(conn: Conn, legalEntityId: number, search: string | undefined, limit: number) {
    const like = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
    return conn.select({ publicId: items.publicId, code: items.code, name: items.name, unitPublicId: units.publicId, unitCode: units.code, unitName: units.name,
      unitDecimals: units.decimals,
      free: sql<string>`(SELECT coalesce(sum(b.on_hand - b.reserved), 0) FROM ${stockBalances} b WHERE b.item_id = ${items.id})::text` })
      .from(items).innerJoin(units, eq(units.id, items.baseUnitId))
      .where(and(eq(items.legalEntityId, legalEntityId), eq(items.status, 'active'), eq(items.isStocked, true),
        like ? or(sql`${items.code} ILIKE ${like}`, sql`${items.name} ILIKE ${like}`) : undefined))
      .orderBy(asc(items.code)).limit(limit);
  }

  /** The issues of a ticket and the returns of those issues, with their lines. */
  async ticketDocuments(conn: Conn, ticketId: number) {
    const docs = await conn.select({ id: stockDocuments.id, publicId: stockDocuments.publicId, number: stockDocuments.number, type: stockDocuments.type,
      status: stockDocuments.status, documentDate: stockDocuments.documentDate }).from(stockDocuments)
      .where(or(eq(stockDocuments.ticketId, ticketId), and(eq(stockDocuments.type, 'return'),
        sql`${stockDocuments.originalDocumentId} IN (SELECT d.id FROM ${stockDocuments} d WHERE d.ticket_id = ${ticketId})`)))
      .orderBy(asc(stockDocuments.documentDate), asc(stockDocuments.id));
    const lines = docs.length === 0 ? [] : await conn.select({ documentId: stockDocumentLines.documentId, lineNo: stockDocumentLines.lineNo,
      itemPublicId: items.publicId, itemCode: items.code, itemName: items.name, unitPublicId: units.publicId, unitCode: units.code, unitName: units.name,
      unitDecimals: units.decimals, quantity: stockDocumentLines.quantity, batchNo: stockBatches.batchNo, serialNo: stockDocumentLines.serialNo,
      value: stockDocumentLines.valueMinor }).from(stockDocumentLines)
      .innerJoin(items, eq(items.id, stockDocumentLines.itemId)).innerJoin(units, eq(units.id, items.baseUnitId))
      .leftJoin(stockBatches, eq(stockBatches.id, stockDocumentLines.batchId))
      .where(inArray(stockDocumentLines.documentId, docs.map((d) => d.id))).orderBy(asc(stockDocumentLines.lineNo));
    return { docs, lines };
  }

  // ---- grants ----

  async insertGrant(tx: Tx, v: typeof crossCompanyGrants.$inferInsert): Promise<void> {
    await tx.insert(crossCompanyGrants).values(v);
  }

  async grant(conn: Conn, tenantId: number, publicId: string, lock = false) {
    const q = conn.select({ id: crossCompanyGrants.id, legalEntityId: crossCompanyGrants.legalEntityId, endedAt: crossCompanyGrants.endedAt, personId: crossCompanyGrants.personId })
      .from(crossCompanyGrants).where(and(eq(crossCompanyGrants.tenantId, tenantId), eq(crossCompanyGrants.publicId, publicId)));
    const [row] = lock ? await q.for('update') : await q;
    return row;
  }

  async endGrant(tx: Tx, id: number, by: number): Promise<void> {
    await tx.update(crossCompanyGrants).set({ endedBy: by, endedAt: new Date() }).where(eq(crossCompanyGrants.id, id));
  }

  /** Grants with names: of these companies, or of one person; `active` = open and not past valid_until. */
  async grants(conn: Conn, tenantId: number, f: { companyIds?: number[]; personId?: number; publicId?: string }) {
    return conn.select({
      publicId: crossCompanyGrants.publicId, company: legalEntities.code, personPublicId: grantee.publicId, personName: grantee.displayName,
      ticketPublicId: tickets.publicId, ticketNumber: tickets.number, ticketTitle: tickets.title, validUntil: crossCompanyGrants.validUntil,
      grantedByPublicId: granter.publicId, grantedByName: granter.displayName, createdAt: crossCompanyGrants.createdAt,
      endedByPublicId: ender.publicId, endedByName: ender.displayName, endedAt: crossCompanyGrants.endedAt,
    }).from(crossCompanyGrants)
      .innerJoin(legalEntities, eq(legalEntities.id, crossCompanyGrants.legalEntityId))
      .innerJoin(tickets, eq(tickets.id, crossCompanyGrants.ticketId))
      .leftJoin(grantee, eq(grantee.id, crossCompanyGrants.personId))
      .leftJoin(granter, eq(granter.id, crossCompanyGrants.grantedBy))
      .leftJoin(ender, eq(ender.id, crossCompanyGrants.endedBy))
      .where(and(eq(crossCompanyGrants.tenantId, tenantId), f.companyIds ? inArray(crossCompanyGrants.legalEntityId, f.companyIds) : undefined,
        f.personId !== undefined ? eq(crossCompanyGrants.personId, f.personId) : undefined, f.publicId ? eq(crossCompanyGrants.publicId, f.publicId) : undefined))
      .orderBy(desc(crossCompanyGrants.createdAt));
  }

  async personByPublicId(conn: Conn, tenantId: number, publicId: string): Promise<number | undefined> {
    const [row] = await conn.select({ id: persons.id }).from(persons).where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, publicId)));
    return row?.id;
  }

  /** The companies a person has a current job in. */
  async companiesOf(conn: Conn, personId: number): Promise<number[]> {
    const rows = await conn.selectDistinct({ id: employments.legalEntityId }).from(employments)
      .where(and(eq(employments.personId, personId), inArray(employments.status, ['active', 'notice'])));
    return rows.map((r) => r.id);
  }
}
