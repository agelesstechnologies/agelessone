import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, gte, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { employments } from '../../hrms/people/schema';
import { monthLocks } from '../../hrms/attendance/schema';
import { bankAccounts, payrollAdjustments, payrollItems, payrollRuns, salaries } from '../schema';

const preparer = aliasedTable(persons, 'preparer');
const approver = aliasedTable(persons, 'approver');
const creator = aliasedTable(persons, 'creator');

/** A run with its people and totals, as listed. */
export interface RunRow {
  id: number; publicId: string; company: string; companyName: string; legalEntityId: number; year: number; month: number; status: string;
  currency: string; preparerPublicId: string; preparerName: string; preparedAt: Date; approverPublicId: string | null; approverName: string | null;
  approvedAt: Date | null; paidAt: Date | null; bankRef: string | null;
  people: number; salaryForMonthPaise: number; additionsPaise: number; deductionsPaise: number; netPaise: number;
}

export interface ItemValues {
  tenantId: number; runId: number; employmentId: number; legalEntityId: number; monthlySalaryPaise: number; daysInMonth: number;
  employedDays: number; absentDays: number; lopAmountPaise: number; salaryForMonthPaise: number;
  additionsTotalPaise: number; deductionsTotalPaise: number; netPayPaise: number;
}

/** Writes only payroll.*; reads companies, people, jobs and month locks. */
@Injectable()
export class PayrollRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findCompany(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: legalEntities.id, code: legalEntities.code, name: legalEntities.name }).from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row;
  }

  async findEmployment(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: employments.id, legalEntityId: employments.legalEntityId, personId: employments.personId })
      .from(employments).where(and(eq(employments.tenantId, tenantId), eq(employments.publicId, publicId)));
    return row;
  }

  /** The month is locked for payroll in the company (an open month lock). */
  async isMonthLocked(conn: Conn, legalEntityId: number, year: number, month: number): Promise<boolean> {
    const [row] = await conn.select({ id: monthLocks.id }).from(monthLocks)
      .where(and(eq(monthLocks.legalEntityId, legalEntityId), eq(monthLocks.year, year), eq(monthLocks.month, month), isNull(monthLocks.unlockedAt)));
    return row !== undefined;
  }

  // ---- salaries and bank accounts ----

  async findSalaryTenant(publicId: string) {
    const [row] = await this.db.select({ tenantId: salaries.tenantId }).from(salaries).where(eq(salaries.publicId, publicId));
    return row?.tenantId;
  }

  async insertSalary(v: { tenantId: number; publicId: string; employmentId: number; legalEntityId: number; monthlyAmountPaise: number;
    effectiveFrom: string; note?: string; createdBy: number }): Promise<void> {
    await this.db.insert(salaries).values(v);
  }

  async salaries(tenantId: number, f: { company?: string; employment?: string; publicId?: string }) {
    return this.db.select({
      publicId: salaries.publicId, personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      monthlyAmountPaise: salaries.monthlyAmountPaise, currency: salaries.currency, effectiveFrom: salaries.effectiveFrom, note: salaries.note,
      creatorPublicId: creator.publicId, creatorName: creator.displayName, createdAt: salaries.createdAt,
    }).from(salaries)
      .innerJoin(employments, eq(employments.id, salaries.employmentId))
      .innerJoin(persons, eq(persons.id, employments.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, salaries.legalEntityId))
      .innerJoin(creator, eq(creator.id, salaries.createdBy))
      .where(and(eq(salaries.tenantId, tenantId), f.company ? eq(legalEntities.code, f.company) : undefined,
        f.employment ? eq(employments.publicId, f.employment) : undefined, f.publicId ? eq(salaries.publicId, f.publicId) : undefined))
      .orderBy(asc(legalEntities.code), asc(persons.displayName), desc(salaries.effectiveFrom));
  }

  async findBankTenant(publicId: string) {
    const [row] = await this.db.select({ tenantId: bankAccounts.tenantId }).from(bankAccounts).where(eq(bankAccounts.publicId, publicId));
    return row?.tenantId;
  }

  async insertBankAccount(v: { tenantId: number; publicId: string; employmentId: number; legalEntityId: number; accountHolder: string;
    accountNumber: string; ifsc: string; effectiveFrom: string; createdBy: number }): Promise<void> {
    await this.db.insert(bankAccounts).values(v);
  }

  async bankAccounts(tenantId: number, f: { company?: string; publicId?: string }) {
    return this.db.select({
      publicId: bankAccounts.publicId, personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      accountHolder: bankAccounts.accountHolder, accountNumber: bankAccounts.accountNumber, ifsc: bankAccounts.ifsc,
      effectiveFrom: bankAccounts.effectiveFrom, createdAt: bankAccounts.createdAt,
    }).from(bankAccounts)
      .innerJoin(employments, eq(employments.id, bankAccounts.employmentId))
      .innerJoin(persons, eq(persons.id, employments.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, bankAccounts.legalEntityId))
      .where(and(eq(bankAccounts.tenantId, tenantId), f.company ? eq(legalEntities.code, f.company) : undefined,
        f.publicId ? eq(bankAccounts.publicId, f.publicId) : undefined))
      .orderBy(asc(legalEntities.code), asc(persons.displayName), desc(bankAccounts.effectiveFrom));
  }

  /** The newest salary of each job in force on the date. */
  async salariesInForce(conn: Conn, employmentIds: number[], onDate: string) {
    if (employmentIds.length === 0) return [];
    return conn.selectDistinctOn([salaries.employmentId], { employmentId: salaries.employmentId, monthlyAmountPaise: salaries.monthlyAmountPaise })
      .from(salaries).where(and(inArray(salaries.employmentId, employmentIds), lte(salaries.effectiveFrom, onDate)))
      .orderBy(salaries.employmentId, desc(salaries.effectiveFrom));
  }

  /** The newest bank account of each job in force on the date (full number: for the bank file only). */
  async bankInForce(employmentIds: number[], onDate: string) {
    if (employmentIds.length === 0) return [];
    return this.db.selectDistinctOn([bankAccounts.employmentId], {
      employmentId: bankAccounts.employmentId, accountHolder: bankAccounts.accountHolder, accountNumber: bankAccounts.accountNumber, ifsc: bankAccounts.ifsc,
    }).from(bankAccounts).where(and(inArray(bankAccounts.employmentId, employmentIds), lte(bankAccounts.effectiveFrom, onDate)))
      .orderBy(bankAccounts.employmentId, desc(bankAccounts.effectiveFrom));
  }

  /** The company's jobs held at some point in from..to that had started (not still joining). */
  async jobsInMonth(conn: Conn, legalEntityId: number, from: string, to: string) {
    return conn.select({
      id: employments.id, publicId: employments.publicId, employeeCode: employments.employeeCode, joinedOn: employments.joinedOn, exitOn: employments.exitOn,
      personPublicId: persons.publicId, personName: persons.displayName,
    }).from(employments).innerJoin(persons, eq(persons.id, employments.personId))
      .where(and(eq(employments.legalEntityId, legalEntityId), ne(employments.status, 'joining'),
        lte(employments.joinedOn, to), or(isNull(employments.exitOn), gte(employments.exitOn, from))))
      .orderBy(asc(persons.displayName));
  }

  // ---- runs ----

  async findRun(tenantId: number, legalEntityId: number, year: number, month: number) {
    const [row] = await this.db.select({ publicId: payrollRuns.publicId }).from(payrollRuns)
      .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.legalEntityId, legalEntityId), eq(payrollRuns.year, year), eq(payrollRuns.month, month)));
    return row;
  }

  async insertRun(tx: Tx, v: { tenantId: number; legalEntityId: number; year: number; month: number; preparedBy: number }) {
    const [row] = await tx.insert(payrollRuns).values(v).returning({ id: payrollRuns.id, publicId: payrollRuns.publicId });
    return row;
  }

  async lockRun(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({
      id: payrollRuns.id, legalEntityId: payrollRuns.legalEntityId, year: payrollRuns.year, month: payrollRuns.month,
      status: payrollRuns.status, preparedBy: payrollRuns.preparedBy, company: legalEntities.code,
    }).from(payrollRuns).innerJoin(legalEntities, eq(legalEntities.id, payrollRuns.legalEntityId))
      .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.publicId, publicId))).for('update');
    return row;
  }

  async setPrepared(tx: Tx, runId: number, by: number): Promise<void> {
    await tx.update(payrollRuns).set({ preparedBy: by, preparedAt: new Date() }).where(eq(payrollRuns.id, runId));
  }

  async approve(tx: Tx, runId: number, by: number): Promise<void> {
    await tx.update(payrollRuns).set({ status: 'approved', approvedBy: by, approvedAt: new Date() }).where(eq(payrollRuns.id, runId));
  }

  async markPaid(tx: Tx, runId: number, paidAt: Date, bankRef: string): Promise<void> {
    await tx.update(payrollRuns).set({ status: 'paid', paidAt, bankRef }).where(eq(payrollRuns.id, runId));
  }

  async runs(tenantId: number, f: { company?: string; year?: number; publicId?: string }): Promise<RunRow[]> {
    return this.db.select({
      id: payrollRuns.id, publicId: payrollRuns.publicId, company: legalEntities.code, companyName: legalEntities.name,
      legalEntityId: payrollRuns.legalEntityId, year: payrollRuns.year, month: payrollRuns.month, status: payrollRuns.status, currency: payrollRuns.currency,
      preparerPublicId: preparer.publicId, preparerName: preparer.displayName, preparedAt: payrollRuns.preparedAt,
      approverPublicId: approver.publicId, approverName: approver.displayName, approvedAt: payrollRuns.approvedAt,
      paidAt: payrollRuns.paidAt, bankRef: payrollRuns.bankRef,
      people: sql<number>`(SELECT count(*) FROM ${payrollItems} i WHERE i.run_id = ${payrollRuns.id})`.mapWith(Number),
      salaryForMonthPaise: sql<number>`(SELECT coalesce(sum(i.salary_for_month_paise), 0) FROM ${payrollItems} i WHERE i.run_id = ${payrollRuns.id})`.mapWith(Number),
      additionsPaise: sql<number>`(SELECT coalesce(sum(i.additions_total_paise), 0) FROM ${payrollItems} i WHERE i.run_id = ${payrollRuns.id})`.mapWith(Number),
      deductionsPaise: sql<number>`(SELECT coalesce(sum(i.deductions_total_paise), 0) FROM ${payrollItems} i WHERE i.run_id = ${payrollRuns.id})`.mapWith(Number),
      netPaise: sql<number>`(SELECT coalesce(sum(i.net_pay_paise), 0) FROM ${payrollItems} i WHERE i.run_id = ${payrollRuns.id})`.mapWith(Number),
    }).from(payrollRuns)
      .innerJoin(legalEntities, eq(legalEntities.id, payrollRuns.legalEntityId))
      .innerJoin(preparer, eq(preparer.id, payrollRuns.preparedBy))
      .leftJoin(approver, eq(approver.id, payrollRuns.approvedBy))
      .where(and(eq(payrollRuns.tenantId, tenantId), f.company ? eq(legalEntities.code, f.company) : undefined,
        f.year ? eq(payrollRuns.year, f.year) : undefined, f.publicId ? eq(payrollRuns.publicId, f.publicId) : undefined))
      .orderBy(desc(payrollRuns.year), desc(payrollRuns.month), asc(legalEntities.code));
  }

  // ---- items and adjustments ----

  /** Items of runs (with the person and job), optionally only one person's or one item. */
  async items(conn: Conn, f: { runIds?: number[]; personId?: number; itemPublicId?: string }) {
    if (f.runIds && f.runIds.length === 0) return [];
    return conn.select({
      id: payrollItems.id, runId: payrollItems.runId, publicId: payrollItems.publicId, employmentId: payrollItems.employmentId,
      personId: employments.personId, personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      currency: payrollItems.currency, monthlySalaryPaise: payrollItems.monthlySalaryPaise, daysInMonth: payrollItems.daysInMonth,
      employedDays: payrollItems.employedDays, absentDays: payrollItems.absentDays, lopAmountPaise: payrollItems.lopAmountPaise,
      salaryForMonthPaise: payrollItems.salaryForMonthPaise, additionsTotalPaise: payrollItems.additionsTotalPaise,
      deductionsTotalPaise: payrollItems.deductionsTotalPaise, netPayPaise: payrollItems.netPayPaise,
    }).from(payrollItems)
      .innerJoin(employments, eq(employments.id, payrollItems.employmentId))
      .innerJoin(persons, eq(persons.id, employments.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, payrollItems.legalEntityId))
      .where(and(f.runIds ? inArray(payrollItems.runId, f.runIds) : undefined, f.personId !== undefined ? eq(employments.personId, f.personId) : undefined,
        f.itemPublicId ? eq(payrollItems.publicId, f.itemPublicId) : undefined))
      .orderBy(asc(persons.displayName));
  }

  async adjustmentsOf(conn: Conn, itemIds: number[]) {
    if (itemIds.length === 0) return [];
    return conn.select({
      itemId: payrollAdjustments.itemId, publicId: payrollAdjustments.publicId, kind: payrollAdjustments.kind, label: payrollAdjustments.label,
      amountPaise: payrollAdjustments.amountPaise, currency: payrollAdjustments.currency, note: payrollAdjustments.note,
    }).from(payrollAdjustments).where(inArray(payrollAdjustments.itemId, itemIds)).orderBy(asc(payrollAdjustments.createdAt), asc(payrollAdjustments.id));
  }

  async upsertItem(tx: Tx, v: ItemValues): Promise<void> {
    const { tenantId: _t, runId: _r, employmentId: _e, legalEntityId: _l, ...changes } = v;
    await tx.insert(payrollItems).values({ ...v, absentDays: String(v.absentDays) })
      .onConflictDoUpdate({ target: [payrollItems.runId, payrollItems.employmentId], set: { ...changes, absentDays: String(v.absentDays) } });
  }

  /** Removes the run's items (and their adjustments) for jobs no longer in it — only while the run is a draft. */
  async removeItemsExcept(tx: Tx, runId: number, keepEmploymentIds: number[]): Promise<void> {
    const gone = await tx.select({ id: payrollItems.id }).from(payrollItems)
      .where(and(eq(payrollItems.runId, runId), keepEmploymentIds.length ? notInArray(payrollItems.employmentId, keepEmploymentIds) : undefined));
    if (gone.length === 0) return;
    await tx.delete(payrollAdjustments).where(inArray(payrollAdjustments.itemId, gone.map((g) => g.id)));
    await tx.delete(payrollItems).where(inArray(payrollItems.id, gone.map((g) => g.id)));
  }

  async lockItem(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: payrollItems.id, runId: payrollItems.runId, runPublicId: payrollRuns.publicId,
      salaryForMonthPaise: payrollItems.salaryForMonthPaise })
      .from(payrollItems).innerJoin(payrollRuns, eq(payrollRuns.id, payrollItems.runId))
      .where(and(eq(payrollItems.tenantId, tenantId), eq(payrollItems.publicId, publicId))).for('update');
    return row;
  }

  async findAdjustment(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: payrollAdjustments.id, itemId: payrollAdjustments.itemId, itemPublicId: payrollItems.publicId })
      .from(payrollAdjustments).innerJoin(payrollItems, eq(payrollItems.id, payrollAdjustments.itemId))
      .where(and(eq(payrollAdjustments.tenantId, tenantId), eq(payrollAdjustments.publicId, publicId)));
    return row;
  }

  async findAdjustmentTenant(publicId: string) {
    const [row] = await this.db.select({ tenantId: payrollAdjustments.tenantId, itemId: payrollAdjustments.itemId }).from(payrollAdjustments)
      .where(eq(payrollAdjustments.publicId, publicId));
    return row;
  }

  async insertAdjustment(tx: Tx, v: { tenantId: number; publicId: string; itemId: number; kind: string; label: string; amountPaise: number; note?: string; createdBy: number }) {
    await tx.insert(payrollAdjustments).values(v);
  }

  async updateAdjustment(tx: Tx, id: number, patch: { kind?: string; label?: string; amountPaise?: number; note?: string | null }) {
    await tx.update(payrollAdjustments).set(patch).where(eq(payrollAdjustments.id, id));
  }

  async deleteAdjustment(tx: Tx, id: number): Promise<void> {
    await tx.delete(payrollAdjustments).where(eq(payrollAdjustments.id, id));
  }

  async setItemTotals(tx: Tx, itemId: number, t: { additionsTotalPaise: number; deductionsTotalPaise: number; netPayPaise: number }) {
    await tx.update(payrollItems).set(t).where(eq(payrollItems.id, itemId));
  }
}
