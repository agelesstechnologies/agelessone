import { Inject, Injectable } from '@nestjs/common';
import { and, asc, between, count, desc, eq, ne, sql, SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DecidedAs, ExpenseCategory, ExpenseClaim, ExpenseReport, ExpenseStatus } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { employments } from '../../people/schema';
import { expenseCategories, expenseClaims } from '../schema';

const claimant = alias(persons, 'claimant');
const approver = alias(persons, 'approver');
const rejecter = alias(persons, 'rejecter');
const money = (expr: SQL) => sql<number>`coalesce(${expr}, 0)::bigint`.mapWith(Number);

export interface NewClaim {
  tenantId: number; publicId?: string; personId: number; employmentId: number; legalEntityId: number; categoryId: number;
  spentOn: string; amountPaise: number; description?: string; receiptPath: string | null;
}

/** Writes only hrms.expense_* tables; reads people, jobs and companies to show and check claims. */
@Injectable()
export class ExpensesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async categories(tenantId: number): Promise<ExpenseCategory[]> {
    return this.db.select({ code: expenseCategories.code, name: expenseCategories.name, receiptRequired: expenseCategories.receiptRequired })
      .from(expenseCategories).where(eq(expenseCategories.tenantId, tenantId)).orderBy(asc(expenseCategories.code));
  }

  async findCategory(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: expenseCategories.id, receiptRequired: expenseCategories.receiptRequired })
      .from(expenseCategories).where(and(eq(expenseCategories.tenantId, tenantId), eq(expenseCategories.code, code)));
    return row;
  }

  async findEmployment(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: employments.id, personId: employments.personId, legalEntityId: employments.legalEntityId, status: employments.status })
      .from(employments).where(and(eq(employments.tenantId, tenantId), eq(employments.publicId, publicId)));
    return row;
  }

  /** By public id across tenants: a public id is unique everywhere, so a resend can be recognised. */
  async findClaimOwner(publicId: string) {
    const [row] = await this.db.select({ tenantId: expenseClaims.tenantId, personId: expenseClaims.personId })
      .from(expenseClaims).where(eq(expenseClaims.publicId, publicId));
    return row;
  }

  async insertClaim(conn: Conn, c: NewClaim): Promise<string> {
    const [row] = await conn.insert(expenseClaims).values(c).returning({ publicId: expenseClaims.publicId });
    return row.publicId;
  }

  /** Locks the claim (and its job row) for a decision; managerPersonId is the manager of the claim's job. */
  async lockClaim(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({
      id: expenseClaims.id, personId: expenseClaims.personId, status: expenseClaims.status,
      amountPaise: expenseClaims.amountPaise, managerPersonId: employments.managerPersonId,
      publicId: expenseClaims.publicId, legalEntityId: expenseClaims.legalEntityId, personName: claimant.displayName,
    }).from(expenseClaims).innerJoin(employments, eq(employments.id, expenseClaims.employmentId))
      .innerJoin(claimant, eq(claimant.id, expenseClaims.personId))
      .where(and(eq(expenseClaims.tenantId, tenantId), eq(expenseClaims.publicId, publicId))).for('update');
    return row as (Omit<typeof row, 'status'> & { status: ExpenseStatus }) | undefined;
  }

  /** by null only with decidedAs 'no_approval_required' (the database checks it). The claim still waits for payment. */
  async approve(tx: Tx, id: number, by: number | null, decidedAs: DecidedAs, approvedAmountPaise: number): Promise<void> {
    await tx.update(expenseClaims).set({ status: 'approved', approvedBy: by, decidedAs, approvedAt: new Date(), approvedAmountPaise }).where(eq(expenseClaims.id, id));
  }

  async reject(tx: Tx, id: number, by: number, decidedAs: DecidedAs, reason: string): Promise<void> {
    await tx.update(expenseClaims).set({ status: 'rejected', rejectedBy: by, decidedAs, rejectedAt: new Date(), rejectionReason: reason }).where(eq(expenseClaims.id, id));
  }

  async markPaid(tx: Tx, id: number, paidAt: Date, paymentRef: string): Promise<void> {
    await tx.update(expenseClaims).set({ status: 'paid', paidAt, paymentRef }).where(eq(expenseClaims.id, id));
  }

  async claim(tenantId: number, publicId: string): Promise<ExpenseClaim | undefined> {
    const [row] = await this.view().where(and(eq(expenseClaims.tenantId, tenantId), eq(expenseClaims.publicId, publicId)));
    return row ? toClaim(row) : undefined;
  }

  async mine(tenantId: number, personId: number, q: { status?: ExpenseStatus; page: number; pageSize: number }) {
    const where = and(eq(expenseClaims.tenantId, tenantId), eq(expenseClaims.personId, personId), q.status ? eq(expenseClaims.status, q.status) : undefined);
    const [{ total }] = await this.db.select({ total: count() }).from(expenseClaims).where(where);
    const rows = await this.view().where(where).orderBy(desc(expenseClaims.createdAt), desc(expenseClaims.id))
      .limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    return { items: rows.map(toClaim), page: q.page, pageSize: q.pageSize, total };
  }

  /** Submitted claims on jobs this person manages (team) or anyone's (everyone) — never their own — oldest first. */
  async toApprove(tenantId: number, managerId: number, everyone = false): Promise<ExpenseClaim[]> {
    const rows = await this.view().where(and(eq(expenseClaims.tenantId, tenantId), eq(expenseClaims.status, 'submitted'),
      everyone ? undefined : eq(employments.managerPersonId, managerId), ne(expenseClaims.personId, managerId)))
      .orderBy(asc(expenseClaims.createdAt), asc(expenseClaims.id));
    return rows.map(toClaim);
  }

  /** Totals by status and by category for claims spent between from and to (inclusive), optionally one company. */
  async report(tenantId: number, from: string, to: string, company?: string): Promise<Pick<ExpenseReport, 'byStatus' | 'byCategory' | 'rows'>> {
    const where = and(eq(expenseClaims.tenantId, tenantId), between(expenseClaims.spentOn, from, to), company ? eq(legalEntities.code, company) : undefined);
    const byStatus = await this.db.select({ status: expenseClaims.status, count: count(), amountPaise: money(sql`sum(${expenseClaims.amountPaise})`) })
      .from(expenseClaims).innerJoin(employments, eq(employments.id, expenseClaims.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .where(where).groupBy(expenseClaims.status).orderBy(asc(expenseClaims.status));
    const byCategory = await this.db.select({
      code: expenseCategories.code, name: expenseCategories.name, count: count(),
      amountPaise: money(sql`sum(${expenseClaims.amountPaise})`),
      approvedPaise: money(sql`sum(${expenseClaims.approvedAmountPaise}) filter (where ${expenseClaims.status} in ('approved','paid'))`),
      paidPaise: money(sql`sum(${expenseClaims.approvedAmountPaise}) filter (where ${expenseClaims.status} = 'paid')`),
    }).from(expenseClaims).innerJoin(employments, eq(employments.id, expenseClaims.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenseClaims.categoryId))
      .where(where).groupBy(expenseCategories.code, expenseCategories.name).orderBy(asc(expenseCategories.code));
    const rows = await this.db.select({
      personPublicId: claimant.publicId, personName: claimant.displayName, company: legalEntities.code, employeeCode: employments.employeeCode,
      categoryCode: expenseCategories.code, categoryName: expenseCategories.name, status: expenseClaims.status, currency: expenseClaims.currency,
      count: count(), amountPaise: money(sql`sum(${expenseClaims.amountPaise})`),
      approvedPaise: money(sql`sum(${expenseClaims.approvedAmountPaise}) filter (where ${expenseClaims.status} in ('approved','paid'))`),
      paidPaise: money(sql`sum(${expenseClaims.approvedAmountPaise}) filter (where ${expenseClaims.status} = 'paid')`),
    }).from(expenseClaims).innerJoin(claimant, eq(claimant.id, expenseClaims.personId))
      .innerJoin(employments, eq(employments.id, expenseClaims.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenseClaims.categoryId))
      .where(where)
      .groupBy(claimant.publicId, claimant.displayName, legalEntities.code, employments.employeeCode, expenseCategories.code, expenseCategories.name,
        expenseClaims.status, expenseClaims.currency)
      .orderBy(asc(legalEntities.code), asc(claimant.displayName), asc(expenseCategories.code), asc(expenseClaims.status));
    return {
      byStatus: byStatus as ExpenseReport['byStatus'], byCategory,
      rows: rows.map((r) => ({
        person: { publicId: r.personPublicId, displayName: r.personName }, employment: { company: r.company, employeeCode: r.employeeCode },
        category: { code: r.categoryCode, name: r.categoryName }, status: r.status as ExpenseStatus, currency: r.currency,
        count: r.count, amountPaise: r.amountPaise, approvedPaise: r.approvedPaise, paidPaise: r.paidPaise,
      })),
    };
  }

  private view() {
    return this.db.select({
      publicId: expenseClaims.publicId,
      personPublicId: claimant.publicId, personName: claimant.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      categoryCode: expenseCategories.code, categoryName: expenseCategories.name,
      spentOn: expenseClaims.spentOn, amountPaise: expenseClaims.amountPaise, currency: expenseClaims.currency, description: expenseClaims.description,
      receiptPath: expenseClaims.receiptPath, status: expenseClaims.status, approvedAmountPaise: expenseClaims.approvedAmountPaise,
      approverPublicId: approver.publicId, approverName: approver.displayName, approvedAt: expenseClaims.approvedAt, decidedAs: expenseClaims.decidedAs,
      rejecterPublicId: rejecter.publicId, rejecterName: rejecter.displayName, rejectedAt: expenseClaims.rejectedAt,
      rejectionReason: expenseClaims.rejectionReason, paidAt: expenseClaims.paidAt, paymentRef: expenseClaims.paymentRef,
      createdAt: expenseClaims.createdAt,
    }).from(expenseClaims)
      .innerJoin(claimant, eq(claimant.id, expenseClaims.personId))
      .innerJoin(employments, eq(employments.id, expenseClaims.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .innerJoin(expenseCategories, eq(expenseCategories.id, expenseClaims.categoryId))
      .leftJoin(approver, eq(approver.id, expenseClaims.approvedBy))
      .leftJoin(rejecter, eq(rejecter.id, expenseClaims.rejectedBy))
      .$dynamic();
  }
}

type ViewRow = Awaited<ReturnType<ReturnType<ExpensesRepository['view']>['execute']>>[number];
const iso = (d: Date | null) => d?.toISOString() ?? null;
const who = (publicId: string | null, displayName: string | null) => (publicId && displayName ? { publicId, displayName } : null);

function toClaim(r: ViewRow): ExpenseClaim {
  return {
    publicId: r.publicId,
    person: { publicId: r.personPublicId, displayName: r.personName },
    employment: { publicId: r.employmentPublicId, company: r.company, employeeCode: r.employeeCode },
    category: { code: r.categoryCode, name: r.categoryName },
    spentOn: r.spentOn, amountPaise: r.amountPaise, currency: r.currency, description: r.description, receiptPath: r.receiptPath,
    status: r.status as ExpenseStatus, approvedAmountPaise: r.approvedAmountPaise,
    approvedBy: who(r.approverPublicId, r.approverName), approvedAt: iso(r.approvedAt), decidedAs: r.decidedAs as DecidedAs | null,
    rejectedBy: who(r.rejecterPublicId, r.rejecterName), rejectedAt: iso(r.rejectedAt), rejectionReason: r.rejectionReason,
    paidAt: iso(r.paidAt), paymentRef: r.paymentRef, createdAt: r.createdAt.toISOString(),
  };
}
