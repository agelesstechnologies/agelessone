import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, notExists, sql } from 'drizzle-orm';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { departments, employments } from '../../hrms/people/schema';
import { monthLocks } from '../../hrms/attendance/schema';
import { salaries } from '../../payroll/schema';
import { tickets, ticketTimeAdjustments, ticketTimeAllocations } from '../../tickets/schema';
import {
  icAgreements, icBilledMonths, icCredits, icPassedCosts, icStatementLineEvents, icStatementLines, icStatementLineTickets, icStatements, icTicketBilling,
} from '../schema';

const provider = aliasedTable(legalEntities, 'provider');
const receiver = aliasedTable(legalEntities, 'receiver');
/** A statement line that carries a credit (to tell open credits from used ones). */
const usedBy = aliasedTable(icStatementLines, 'used_by');
const monthKey = (t: { year: typeof icStatements.year | typeof icBilledMonths.year; month: typeof icStatements.month | typeof icBilledMonths.month }) =>
  sql<number>`(${t.year} * 100 + ${t.month})`;
const key = (ym: string) => Number(ym.slice(0, 4)) * 100 + Number(ym.slice(5, 7));

export type StatementRow = Awaited<ReturnType<StatementsRepository['statements']>>[number];
export type LineRow = Awaited<ReturnType<StatementsRepository['lines']>>[number];
/** Billable ticket time: allocated minutes plus the heads' adjustments, per ticket, job and work date. */
export interface TimeRow { ticketId: number; employmentId: number; workDate: string; minutes: number; providerId: number; receiverId: number }

/**
 * Statements, their lines and credits (writes only intercompany.*). Reads the billable tickets' time (tickets), the
 * attendance month locks (hrms), jobs and departments (hrms) and salaries (payroll) through their schema.ts.
 */
@Injectable()
export class StatementsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The provider's attendance month is locked (an open month lock). */
  async isMonthLocked(conn: Conn, legalEntityId: number, year: number, month: number): Promise<boolean> {
    const [row] = await conn.select({ id: monthLocks.id }).from(monthLocks)
      .where(and(eq(monthLocks.legalEntityId, legalEntityId), eq(monthLocks.year, year), eq(monthLocks.month, month), isNull(monthLocks.unlockedAt)));
    return row !== undefined;
  }

  // ---- what a statement is built from ----

  /** Billable tickets (provider → receiver) with their link and service type. */
  async billableTickets(conn: Conn, tenantId: number, f: { providerId?: number; receiverId?: number; ticketIds?: number[] }) {
    if (f.ticketIds && f.ticketIds.length === 0) return [];
    return conn.select({ ticketId: icTicketBilling.ticketId, publicId: tickets.publicId, number: tickets.number, title: tickets.title,
      serviceType: icTicketBilling.serviceType, linkKind: icTicketBilling.linkKind, linkPublicId: icTicketBilling.linkPublicId,
      providerId: icTicketBilling.legalEntityId, receiverId: icTicketBilling.billableToLegalEntityId })
      .from(icTicketBilling).innerJoin(tickets, eq(tickets.id, icTicketBilling.ticketId))
      .where(and(eq(icTicketBilling.tenantId, tenantId), eq(icTicketBilling.billable, true),
        f.providerId !== undefined ? eq(icTicketBilling.legalEntityId, f.providerId) : undefined,
        f.receiverId !== undefined ? eq(icTicketBilling.billableToLegalEntityId, f.receiverId) : undefined,
        f.ticketIds ? inArray(icTicketBilling.ticketId, f.ticketIds) : undefined));
  }

  /** The billable tickets' time between two dates (both included): allocations plus adjustments; only what adds up above 0. */
  async billableTime(conn: Conn, tenantId: number, from: string, to: string, f: { providerId?: number; receiverId?: number } = {}): Promise<TimeRow[]> {
    const where = (t: typeof ticketTimeAllocations | typeof ticketTimeAdjustments) => and(eq(icTicketBilling.tenantId, tenantId), eq(icTicketBilling.billable, true),
      f.providerId !== undefined ? eq(icTicketBilling.legalEntityId, f.providerId) : undefined,
      f.receiverId !== undefined ? eq(icTicketBilling.billableToLegalEntityId, f.receiverId) : undefined,
      gte(t.workDate, from), lte(t.workDate, to));
    const read = (t: typeof ticketTimeAllocations | typeof ticketTimeAdjustments) => conn.select({ ticketId: t.ticketId, employmentId: t.employmentId,
      workDate: t.workDate, minutes: sql<number>`sum(${t.minutes})::int`, providerId: icTicketBilling.legalEntityId, receiverId: icTicketBilling.billableToLegalEntityId })
      .from(t).innerJoin(icTicketBilling, eq(icTicketBilling.ticketId, t.ticketId)).where(where(t))
      .groupBy(t.ticketId, t.employmentId, t.workDate, icTicketBilling.legalEntityId, icTicketBilling.billableToLegalEntityId);
    const sum = new Map<string, TimeRow>();
    for (const r of [...await read(ticketTimeAllocations), ...await read(ticketTimeAdjustments)]) {
      const k = `${r.ticketId}|${r.employmentId}|${r.workDate}`;
      const s = sum.get(k);
      if (s) s.minutes += Number(r.minutes);
      else sum.set(k, { ...r, minutes: Number(r.minutes) });
    }
    return [...sum.values()].filter((r) => r.minutes > 0).sort((a, b) => a.workDate.localeCompare(b.workDate) || a.ticketId - b.ticketId || a.employmentId - b.employmentId);
  }

  /** Every salary row of these jobs (payroll). */
  async salaries(conn: Conn, employmentIds: number[]) {
    if (employmentIds.length === 0) return [];
    return conn.select({ employmentId: salaries.employmentId, monthlyMinor: salaries.monthlyAmountPaise, effectiveFrom: salaries.effectiveFrom })
      .from(salaries).where(inArray(salaries.employmentId, [...new Set(employmentIds)]));
  }

  /** Costs of the agreement in a month that count (their bill is attached). */
  async countedCosts(conn: Conn, agreementId: number, from: string, to: string) {
    return conn.select({ id: icPassedCosts.id, publicId: icPassedCosts.publicId, projectPublicId: icPassedCosts.projectPublicId, description: icPassedCosts.description,
      amountMinor: icPassedCosts.amountMinor, incurredOn: icPassedCosts.incurredOn })
      .from(icPassedCosts)
      .where(and(eq(icPassedCosts.agreementId, agreementId), gte(icPassedCosts.incurredOn, from), lte(icPassedCosts.incurredOn, to), isNotNull(icPassedCosts.billPath)))
      .orderBy(asc(icPassedCosts.incurredOn), asc(icPassedCosts.id));
  }

  /** Credits of the agreement not yet on a statement (call after a draft's own lines are cleared). */
  async openCredits(conn: Conn, agreementId: number) {
    return conn.select({ id: icCredits.id, amountMinor: icCredits.amountMinor, reason: icCredits.reason, lineDescription: icStatementLines.description,
      statementYear: icStatements.year, statementMonth: icStatements.month })
      .from(icCredits)
      .innerJoin(icStatementLines, eq(icStatementLines.id, icCredits.lineId))
      .innerJoin(icStatements, eq(icStatements.id, icStatementLines.statementId))
      .where(and(eq(icCredits.agreementId, agreementId),
        notExists(conn.select({ one: sql`1` }).from(usedBy).where(eq(usedBy.creditId, icCredits.id)))))
      .orderBy(asc(icCredits.id));
  }

  // ---- statements ----

  async findStatement(conn: Conn, agreementId: number, year: number, month: number) {
    const [row] = await conn.select({ id: icStatements.id, publicId: icStatements.publicId }).from(icStatements)
      .where(and(eq(icStatements.agreementId, agreementId), eq(icStatements.year, year), eq(icStatements.month, month)));
    return row;
  }

  async insertStatement(tx: Tx, v: typeof icStatements.$inferInsert): Promise<{ id: number; publicId: string }> {
    const [row] = await tx.insert(icStatements).values(v).returning({ id: icStatements.id, publicId: icStatements.publicId });
    return row;
  }

  /** Statements with their agreement and companies, newest month first. */
  async statements(conn: Conn, tenantId: number, f: { publicId?: string; id?: number; agreementId?: number; status?: string; year?: number;
    from?: string; to?: string; notDraft?: boolean; statuses?: string[]; ids?: number[] }) {
    if (f.ids && f.ids.length === 0) return [];
    return conn.select({
      id: icStatements.id, publicId: icStatements.publicId, agreementId: icStatements.agreementId, agreementPublicId: icAgreements.publicId,
      legalEntityId: icStatements.legalEntityId, receiverLegalEntityId: icAgreements.receiverLegalEntityId, provider: provider.code, receiver: receiver.code,
      year: icStatements.year, month: icStatements.month, status: icStatements.status, currency: icStatements.currency, round: icStatements.round,
      preparedBy: icStatements.preparedBy, preparedAt: icStatements.preparedAt, approvedBy: icStatements.approvedBy, approvedAt: icStatements.approvedAt,
      approvedAs: icStatements.approvedAs, firstSentAt: icStatements.firstSentAt, sentAt: icStatements.sentAt, reviewDueOn: icStatements.reviewDueOn,
      acceptedAt: icStatements.acceptedAt, acceptedAs: icStatements.acceptedAs, acceptedBy: icStatements.acceptedBy,
      invoiceNumber: icStatements.invoiceNumber, invoicedOn: icStatements.invoicedOn, invoicedBy: icStatements.invoicedBy,
      paidOn: icStatements.paidOn, paymentRef: icStatements.paymentRef, closedBy: icStatements.closedBy, closedAt: icStatements.closedAt,
    }).from(icStatements)
      .innerJoin(icAgreements, eq(icAgreements.id, icStatements.agreementId))
      .innerJoin(provider, eq(provider.id, icStatements.legalEntityId))
      .innerJoin(receiver, eq(receiver.id, icAgreements.receiverLegalEntityId))
      .where(and(eq(icStatements.tenantId, tenantId),
        f.publicId ? eq(icStatements.publicId, f.publicId) : undefined,
        f.id !== undefined ? eq(icStatements.id, f.id) : undefined,
        f.ids ? inArray(icStatements.id, f.ids) : undefined,
        f.agreementId !== undefined ? eq(icStatements.agreementId, f.agreementId) : undefined,
        f.status ? eq(icStatements.status, f.status) : undefined,
        f.statuses ? inArray(icStatements.status, f.statuses) : undefined,
        f.notDraft ? ne(icStatements.status, 'draft') : undefined,
        f.year !== undefined ? eq(icStatements.year, f.year) : undefined,
        f.from ? gte(monthKey(icStatements), key(f.from)) : undefined,
        f.to ? lte(monthKey(icStatements), key(f.to)) : undefined))
      .orderBy(desc(icStatements.year), desc(icStatements.month), asc(provider.code), asc(receiver.code));
  }

  async lockStatement(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: icStatements.id }).from(icStatements)
      .where(and(eq(icStatements.tenantId, tenantId), eq(icStatements.publicId, publicId))).for('update');
    if (!row) return undefined;
    return (await this.statements(tx, tenantId, { id: row.id }))[0];
  }

  async lockStatementById(tx: Tx, tenantId: number, id: number) {
    await tx.select({ id: icStatements.id }).from(icStatements).where(eq(icStatements.id, id)).for('update');
    return (await this.statements(tx, tenantId, { id }))[0];
  }

  async updateStatement(tx: Tx, id: number, patch: Partial<typeof icStatements.$inferInsert>): Promise<void> {
    await tx.update(icStatements).set(patch).where(eq(icStatements.id, id));
  }

  /** Statements sent and not answered whose review window ended before `today` (every tenant), for the daily job. */
  async reviewOverdue(conn: Conn, today: string) {
    return conn.select({ id: icStatements.id, tenantId: icStatements.tenantId }).from(icStatements)
      .where(and(eq(icStatements.status, 'sent'), lt(icStatements.reviewDueOn, today))).orderBy(asc(icStatements.id));
  }

  // ---- lines ----

  async lines(conn: Conn, statementIds: number[], f: { disputedOnly?: boolean } = {}) {
    if (statementIds.length === 0) return [];
    return conn.select({
      id: icStatementLines.id, publicId: icStatementLines.publicId, statementId: icStatementLines.statementId, kind: icStatementLines.kind,
      description: icStatementLines.description, projectKind: icStatementLines.projectKind, projectPublicId: icStatementLines.projectPublicId,
      serviceType: icStatementLines.serviceType, employmentId: icStatementLines.employmentId, employmentPublicId: employments.publicId,
      personPublicId: persons.publicId, personName: persons.displayName, grade: icStatementLines.grade, minutes: icStatementLines.minutes,
      rateMinor: icStatementLines.rateMinor, costPerHourMinor: icStatementLines.costPerHourMinor, costMinor: icStatementLines.costMinor,
      amountMinor: icStatementLines.amountMinor, originalAmountMinor: icStatementLines.originalAmountMinor, passedCostId: icStatementLines.passedCostId,
      passedCostPublicId: icPassedCosts.publicId, creditId: icStatementLines.creditId, status: icStatementLines.status,
      disputeReason: icStatementLines.disputeReason, disputedBy: icStatementLines.disputedBy, disputedAt: icStatementLines.disputedAt,
      resolution: icStatementLines.resolution, resolutionReason: icStatementLines.resolutionReason, resolvedBy: icStatementLines.resolvedBy,
      resolvedAt: icStatementLines.resolvedAt,
    }).from(icStatementLines)
      .leftJoin(employments, eq(employments.id, icStatementLines.employmentId))
      .leftJoin(persons, eq(persons.id, employments.personId))
      .leftJoin(icPassedCosts, eq(icPassedCosts.id, icStatementLines.passedCostId))
      .where(and(inArray(icStatementLines.statementId, statementIds), f.disputedOnly ? isNotNull(icStatementLines.disputedAt) : undefined))
      .orderBy(asc(icStatementLines.id));
  }

  async lineTickets(conn: Conn, lineIds: number[]) {
    if (lineIds.length === 0) return [];
    return conn.select({ lineId: icStatementLineTickets.lineId, ticketId: icStatementLineTickets.ticketId, publicId: tickets.publicId, number: tickets.number,
      title: tickets.title, minutes: icStatementLineTickets.minutes })
      .from(icStatementLineTickets).innerJoin(tickets, eq(tickets.id, icStatementLineTickets.ticketId))
      .where(inArray(icStatementLineTickets.lineId, lineIds)).orderBy(asc(tickets.number));
  }

  /** What has been credited on each line after invoicing. */
  async creditedByLine(conn: Conn, lineIds: number[]): Promise<Map<number, number>> {
    if (lineIds.length === 0) return new Map();
    const rows = await conn.select({ lineId: icCredits.lineId, total: sql<number>`sum(${icCredits.amountMinor})::bigint` }).from(icCredits)
      .where(inArray(icCredits.lineId, lineIds)).groupBy(icCredits.lineId);
    return new Map(rows.map((r) => [r.lineId, Number(r.total)]));
  }

  /** For credit lines: the corrected line and its statement. */
  async creditSources(conn: Conn, creditIds: number[]) {
    if (creditIds.length === 0) return new Map<number, { statementPublicId: string; linePublicId: string; reason: string }>();
    const rows = await conn.select({ id: icCredits.id, reason: icCredits.reason, linePublicId: icStatementLines.publicId, statementPublicId: icStatements.publicId })
      .from(icCredits).innerJoin(icStatementLines, eq(icStatementLines.id, icCredits.lineId))
      .innerJoin(icStatements, eq(icStatements.id, icStatementLines.statementId)).where(inArray(icCredits.id, creditIds));
    return new Map(rows.map((r) => [r.id, { statementPublicId: r.statementPublicId, linePublicId: r.linePublicId, reason: r.reason }]));
  }

  /** The heads of the departments whose tickets have time on the statement (who may approve it). */
  async departmentHeads(conn: Conn, statementId: number): Promise<number[]> {
    const rows = await conn.selectDistinct({ head: departments.headPersonId }).from(icStatementLineTickets)
      .innerJoin(icStatementLines, eq(icStatementLines.id, icStatementLineTickets.lineId))
      .innerJoin(tickets, eq(tickets.id, icStatementLineTickets.ticketId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .where(and(eq(icStatementLines.statementId, statementId), isNotNull(departments.headPersonId)));
    return rows.map((r) => r.head!);
  }

  /** A draft is rebuilt from scratch: its lines (and their tickets) go. */
  async clearDraftLines(tx: Tx, statementId: number): Promise<void> {
    const ids = tx.select({ id: icStatementLines.id }).from(icStatementLines).where(eq(icStatementLines.statementId, statementId));
    await tx.delete(icStatementLineTickets).where(inArray(icStatementLineTickets.lineId, ids));
    await tx.delete(icStatementLines).where(eq(icStatementLines.statementId, statementId));
  }

  async insertLine(tx: Tx, v: typeof icStatementLines.$inferInsert, ticketMinutes: Map<number, number> = new Map()): Promise<void> {
    const [line] = await tx.insert(icStatementLines).values(v).returning({ id: icStatementLines.id });
    if (ticketMinutes.size === 0) return;
    await tx.insert(icStatementLineTickets).values([...ticketMinutes].map(([ticketId, minutes]) =>
      ({ tenantId: v.tenantId, lineId: line.id, ticketId, legalEntityId: v.legalEntityId, minutes })));
  }

  async findLine(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: icStatementLines.id, statementId: icStatementLines.statementId }).from(icStatementLines)
      .where(and(eq(icStatementLines.tenantId, tenantId), eq(icStatementLines.publicId, publicId)));
    return row;
  }

  async updateLine(tx: Tx, id: number, patch: Partial<typeof icStatementLines.$inferInsert>): Promise<void> {
    await tx.update(icStatementLines).set(patch).where(eq(icStatementLines.id, id));
  }

  /** Every line of the statement in one state moves to another. */
  async moveLines(tx: Tx, statementId: number, from: string, to: string): Promise<void> {
    await tx.update(icStatementLines).set({ status: to }).where(and(eq(icStatementLines.statementId, statementId), eq(icStatementLines.status, from)));
  }

  async insertLineEvent(tx: Tx, v: typeof icStatementLineEvents.$inferInsert): Promise<void> {
    await tx.insert(icStatementLineEvents).values(v);
  }

  /** The dispute threads of these lines, oldest first. */
  async lineEvents(conn: Conn, lineIds: number[]) {
    if (lineIds.length === 0) return [];
    return conn.select({ lineId: icStatementLineEvents.lineId, round: icStatementLineEvents.round, kind: icStatementLineEvents.kind, reason: icStatementLineEvents.reason,
      amountBeforeMinor: icStatementLineEvents.amountBeforeMinor, amountAfterMinor: icStatementLineEvents.amountAfterMinor,
      byPersonId: icStatementLineEvents.byPersonId, at: icStatementLineEvents.at })
      .from(icStatementLineEvents).where(inArray(icStatementLineEvents.lineId, lineIds)).orderBy(asc(icStatementLineEvents.id));
  }

  /** The person heads a department with ticket time on some statement. */
  async headsStatementDepartment(conn: Conn, tenantId: number, personId: number): Promise<boolean> {
    const [row] = await conn.select({ one: sql`1` }).from(icStatementLineTickets)
      .innerJoin(tickets, eq(tickets.id, icStatementLineTickets.ticketId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .where(and(eq(icStatementLineTickets.tenantId, tenantId), eq(departments.headPersonId, personId))).limit(1);
    return row !== undefined;
  }

  async insertCredit(tx: Tx, v: typeof icCredits.$inferInsert): Promise<string> {
    const [row] = await tx.insert(icCredits).values(v).returning({ publicId: icCredits.publicId });
    return row.publicId;
  }

  // ---- reports ----

  /**
   * Which provider|receiver|YYYY-MM are billed: a statement approved by the provider bills its month, and a month may also
   * have been marked billed by hand (billed outside statements).
   */
  async billedPairMonths(conn: Conn, tenantId: number, from: string, to: string): Promise<Set<string>> {
    const rows = await conn.select({ providerId: icBilledMonths.legalEntityId, receiverId: icAgreements.receiverLegalEntityId, year: icBilledMonths.year, month: icBilledMonths.month })
      .from(icBilledMonths).innerJoin(icAgreements, eq(icAgreements.id, icBilledMonths.agreementId))
      .where(and(eq(icBilledMonths.tenantId, tenantId), gte(monthKey(icBilledMonths), key(from)), lte(monthKey(icBilledMonths), key(to))));
    return new Set(rows.map((r) => `${r.providerId}|${r.receiverId}|${r.year}-${String(r.month).padStart(2, '0')}`));
  }

  async companies(conn: Conn, tenantId: number): Promise<Map<number, string>> {
    const rows = await conn.select({ id: legalEntities.id, code: legalEntities.code }).from(legalEntities).where(eq(legalEntities.tenantId, tenantId));
    return new Map(rows.map((r) => [r.id, r.code]));
  }
}
