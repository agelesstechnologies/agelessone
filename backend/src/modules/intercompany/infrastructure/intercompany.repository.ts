import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { departments, employments } from '../../hrms/people/schema';
import { tickets, ticketTimeAdjustments, ticketTimeAllocations } from '../../tickets/schema';
import { icAgreements, icBilledMonths, icPassedCosts, icRateCards, icTicketBilling } from '../schema';

const provider = aliasedTable(legalEntities, 'provider');
const receiver = aliasedTable(legalEntities, 'receiver');

export type AgreementRow = Awaited<ReturnType<IntercompanyRepository['agreements']>>[number];
export type JobRow = {
  id: number; publicId: string; legalEntityId: number; personId: number; personPublicId: string; displayName: string; status: string; designation: string | null;
};
export type PersonRow = { publicId: string; displayName: string };

/** Writes only intercompany.*; reads companies, people, jobs, departments and tickets (their time too). */
@Injectable()
export class IntercompanyRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findCompany(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: legalEntities.id, code: legalEntities.code, name: legalEntities.name }).from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code.toUpperCase())));
    return row;
  }

  async findJob(tenantId: number, publicId: string): Promise<JobRow | undefined> {
    return (await this.jobsWhere(this.db, and(eq(employments.tenantId, tenantId), eq(employments.publicId, publicId))))[0];
  }

  /** Jobs by internal id, with their person (for the heads and approvers of agreements). */
  async jobs(conn: Conn, ids: number[]): Promise<Map<number, JobRow>> {
    if (ids.length === 0) return new Map();
    return new Map((await this.jobsWhere(conn, inArray(employments.id, [...new Set(ids)]))).map((j) => [j.id, j]));
  }

  private jobsWhere(conn: Conn, where: ReturnType<typeof and>) {
    return conn.select({ id: employments.id, publicId: employments.publicId, legalEntityId: employments.legalEntityId, personId: employments.personId,
      personPublicId: persons.publicId, displayName: persons.displayName, status: employments.status, designation: employments.designation })
      .from(employments).innerJoin(persons, eq(persons.id, employments.personId)).where(where);
  }

  async persons(conn: Conn, ids: (number | null)[]): Promise<Map<number, PersonRow>> {
    const wanted = [...new Set(ids.filter((i): i is number => i !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await conn.select({ id: persons.id, publicId: persons.publicId, displayName: persons.displayName }).from(persons).where(inArray(persons.id, wanted));
    return new Map(rows.map((p) => [p.id, { publicId: p.publicId, displayName: p.displayName }]));
  }

  // ---- agreements ----

  async agreementTenant(publicId: string): Promise<number | undefined> {
    const [row] = await this.db.select({ tenantId: icAgreements.tenantId }).from(icAgreements).where(eq(icAgreements.publicId, publicId));
    return row?.tenantId;
  }

  /** Agreements with their companies, newest first. company: either side. */
  async agreements(conn: Conn, tenantId: number, f: { publicId?: string; id?: number; status?: string; company?: string }) {
    return conn.select({
      ...agreementColumns, provider: provider.code, providerName: provider.name, receiver: receiver.code, receiverName: receiver.name,
    }).from(icAgreements)
      .innerJoin(provider, eq(provider.id, icAgreements.legalEntityId))
      .innerJoin(receiver, eq(receiver.id, icAgreements.receiverLegalEntityId))
      .where(and(eq(icAgreements.tenantId, tenantId),
        f.publicId ? eq(icAgreements.publicId, f.publicId) : undefined,
        f.id !== undefined ? eq(icAgreements.id, f.id) : undefined,
        f.status ? eq(icAgreements.status, f.status) : undefined,
        f.company ? sql`(${provider.code} = ${f.company.toUpperCase()} OR ${receiver.code} = ${f.company.toUpperCase()})` : undefined))
      .orderBy(desc(icAgreements.startDate), desc(icAgreements.id));
  }

  /** The agreement row, locked for the rest of the transaction (every change of an agreement and its months goes through it). */
  async lockAgreement(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select(agreementColumns).from(icAgreements)
      .where(and(eq(icAgreements.tenantId, tenantId), eq(icAgreements.publicId, publicId))).for('update');
    return row;
  }

  async lockAgreementById(tx: Tx, id: number) {
    const [row] = await tx.select(agreementColumns).from(icAgreements).where(eq(icAgreements.id, id)).for('update');
    return row;
  }

  async insertAgreement(tx: Tx, v: typeof icAgreements.$inferInsert): Promise<void> {
    await tx.insert(icAgreements).values(v);
  }

  async updateAgreement(tx: Tx, id: number, patch: Partial<typeof icAgreements.$inferInsert>): Promise<void> {
    await tx.update(icAgreements).set(patch).where(eq(icAgreements.id, id));
  }

  // ---- rate cards and billed months ----

  async rateTenant(publicId: string) {
    const [row] = await this.db.select({ tenantId: icRateCards.tenantId, agreementId: icRateCards.agreementId }).from(icRateCards).where(eq(icRateCards.publicId, publicId));
    return row;
  }

  /** Every rate of an agreement, newest first. */
  async rateCards(conn: Conn, agreementId: number) {
    return conn.select({ id: icRateCards.id, publicId: icRateCards.publicId, serviceType: icRateCards.serviceType, grade: icRateCards.grade,
      rateMinor: icRateCards.rateMinor, currency: icRateCards.currency, effectiveFrom: icRateCards.effectiveFrom,
      createdBy: icRateCards.createdBy, createdAt: icRateCards.createdAt })
      .from(icRateCards).where(eq(icRateCards.agreementId, agreementId))
      .orderBy(desc(icRateCards.effectiveFrom), asc(icRateCards.serviceType), asc(icRateCards.grade));
  }

  async insertRateCard(tx: Tx, v: typeof icRateCards.$inferInsert): Promise<void> {
    await tx.insert(icRateCards).values(v);
  }

  async billedMonths(conn: Conn, agreementId: number) {
    return conn.select({ year: icBilledMonths.year, month: icBilledMonths.month, billedBy: icBilledMonths.billedBy, billedAt: icBilledMonths.billedAt })
      .from(icBilledMonths).where(eq(icBilledMonths.agreementId, agreementId)).orderBy(desc(icBilledMonths.year), desc(icBilledMonths.month));
  }

  async insertBilledMonth(tx: Tx, v: typeof icBilledMonths.$inferInsert): Promise<void> {
    await tx.insert(icBilledMonths).values(v);
  }

  // ---- passed-on costs ----

  async costOwner(publicId: string) {
    const [row] = await this.db.select({ tenantId: icPassedCosts.tenantId, agreementId: icPassedCosts.agreementId }).from(icPassedCosts).where(eq(icPassedCosts.publicId, publicId));
    return row;
  }

  async findCost(conn: Conn, tenantId: number, publicId: string) {
    const [row] = await conn.select({ id: icPassedCosts.id, agreementId: icPassedCosts.agreementId, incurredOn: icPassedCosts.incurredOn,
      billPath: icPassedCosts.billPath, billType: icPassedCosts.billType })
      .from(icPassedCosts).where(and(eq(icPassedCosts.tenantId, tenantId), eq(icPassedCosts.publicId, publicId)));
    return row;
  }

  /** An agreement's passed-on costs (between two dates, both included, when given), oldest first. */
  async passedCosts(conn: Conn, agreementId: number, f: { from?: string; to?: string; publicId?: string }) {
    return conn.select({ publicId: icPassedCosts.publicId, projectPublicId: icPassedCosts.projectPublicId, description: icPassedCosts.description,
      amountMinor: icPassedCosts.amountMinor, currency: icPassedCosts.currency, incurredOn: icPassedCosts.incurredOn,
      billType: icPassedCosts.billType, billUploadedBy: icPassedCosts.billUploadedBy, billUploadedAt: icPassedCosts.billUploadedAt,
      createdBy: icPassedCosts.createdBy, createdAt: icPassedCosts.createdAt })
      .from(icPassedCosts)
      .where(and(eq(icPassedCosts.agreementId, agreementId), f.from ? gte(icPassedCosts.incurredOn, f.from) : undefined,
        f.to ? lte(icPassedCosts.incurredOn, f.to) : undefined, f.publicId ? eq(icPassedCosts.publicId, f.publicId) : undefined))
      .orderBy(asc(icPassedCosts.incurredOn), asc(icPassedCosts.id));
  }

  async insertPassedCost(tx: Tx, v: typeof icPassedCosts.$inferInsert): Promise<void> {
    await tx.insert(icPassedCosts).values(v);
  }

  async setBill(tx: Tx, id: number, v: { billPath: string; billType: string; billUploadedBy: number }): Promise<void> {
    await tx.update(icPassedCosts).set({ ...v, billUploadedAt: new Date() }).where(eq(icPassedCosts.id, id));
  }

  // ---- tickets ----

  /** A ticket with its company and the head of its department (the provider's department head). */
  async findTicket(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: tickets.id, publicId: tickets.publicId, number: tickets.number, title: tickets.title,
      legalEntityId: tickets.legalEntityId, company: legalEntities.code, departmentHeadPersonId: departments.headPersonId })
      .from(tickets)
      .innerJoin(legalEntities, eq(legalEntities.id, tickets.legalEntityId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .where(and(eq(tickets.tenantId, tenantId), eq(tickets.publicId, publicId)));
    return row;
  }

  /** A ticket's billing row; lock: also locked for the rest of the transaction (only this row, not the company it names). */
  async ticketBilling(conn: Conn, ticketId: number, lock = false) {
    if (lock) await conn.select({ id: icTicketBilling.id }).from(icTicketBilling).where(eq(icTicketBilling.ticketId, ticketId)).for('update');
    const [row] = await conn.select({ id: icTicketBilling.id, billableToCompanyId: icTicketBilling.billableToLegalEntityId, billableTo: legalEntities.code,
      linkKind: icTicketBilling.linkKind, linkPublicId: icTicketBilling.linkPublicId, serviceType: icTicketBilling.serviceType, billable: icTicketBilling.billable,
      notBillableReason: icTicketBilling.notBillableReason, changedBy: icTicketBilling.changedBy, changedAt: icTicketBilling.changedAt })
      .from(icTicketBilling).innerJoin(legalEntities, eq(legalEntities.id, icTicketBilling.billableToLegalEntityId))
      .where(eq(icTicketBilling.ticketId, ticketId));
    return row;
  }

  async insertTicketBilling(tx: Tx, v: typeof icTicketBilling.$inferInsert): Promise<void> {
    await tx.insert(icTicketBilling).values(v);
  }

  async updateTicketBilling(tx: Tx, id: number, patch: Partial<typeof icTicketBilling.$inferInsert>): Promise<void> {
    await tx.update(icTicketBilling).set(patch).where(eq(icTicketBilling.id, id));
  }

  /**
   * The first billed month (of an agreement from the ticket's company to one of the receivers) in which the ticket has
   * time — calculated or adjusted. Its billing can no longer change.
   */
  async billedMonthWithTicketTime(conn: Conn, ticket: { id: number; legalEntityId: number }, receiverIds: number[]) {
    if (receiverIds.length === 0) return undefined;
    const workDates = sql`(SELECT work_date FROM ${ticketTimeAllocations} WHERE ${ticketTimeAllocations.ticketId} = ${ticket.id}
      UNION SELECT work_date FROM ${ticketTimeAdjustments} WHERE ${ticketTimeAdjustments.ticketId} = ${ticket.id})`;
    const [row] = await conn.select({ year: icBilledMonths.year, month: icBilledMonths.month }).from(icBilledMonths)
      .innerJoin(icAgreements, eq(icAgreements.id, icBilledMonths.agreementId))
      .where(and(eq(icAgreements.legalEntityId, ticket.legalEntityId), inArray(icAgreements.receiverLegalEntityId, receiverIds),
        sql`EXISTS (SELECT 1 FROM ${workDates} d(work_date) WHERE d.work_date >= make_date(${icBilledMonths.year}, ${icBilledMonths.month}, 1)
          AND d.work_date < (make_date(${icBilledMonths.year}, ${icBilledMonths.month}, 1) + interval '1 month')::date)`))
      .orderBy(asc(icBilledMonths.year), asc(icBilledMonths.month)).limit(1);
    return row;
  }
}

const agreementColumns = {
  id: icAgreements.id, publicId: icAgreements.publicId, tenantId: icAgreements.tenantId, legalEntityId: icAgreements.legalEntityId,
  receiverLegalEntityId: icAgreements.receiverLegalEntityId, services: icAgreements.services, pricingMethod: icAgreements.pricingMethod,
  costPlusPercent: icAgreements.costPlusPercent, passedCostHandling: icAgreements.passedCostHandling, passedCostPercent: icAgreements.passedCostPercent,
  reviewDays: icAgreements.reviewDays, paymentTermsDays: icAgreements.paymentTermsDays,
  providerHeadEmploymentId: icAgreements.providerHeadEmploymentId, providerApproverEmploymentId: icAgreements.providerApproverEmploymentId,
  receiverHeadEmploymentId: icAgreements.receiverHeadEmploymentId, receiverApproverEmploymentId: icAgreements.receiverApproverEmploymentId,
  startDate: icAgreements.startDate, endDate: icAgreements.endDate, status: icAgreements.status,
  createdBy: icAgreements.createdBy, createdAt: icAgreements.createdAt, updatedBy: icAgreements.updatedBy, updatedAt: icAgreements.updatedAt,
};
