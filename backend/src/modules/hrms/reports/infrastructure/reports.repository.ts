import { Inject, Injectable } from '@nestjs/common';
import { and, asc, between, count, countDistinct, desc, eq, gte, inArray, isNull, lte, ne, notLike, or, sql, SQL } from 'drizzle-orm';
import { DB, Db } from '../../../../platform/db/db.module';
import { auditLog, legalEntities, persons } from '../../../core/schema';
import { departments, employments, positions } from '../../people/schema';
import { workDays } from '../../attendance/schema';
import { leaveRequests, leaveTypes } from '../../leave/schema';
import { expenseClaims } from '../../expenses/schema';
import { certificates } from '../../skills/schema';

/** all: everyone in the tenant; team: the caller and the people whose job lists them as manager. */
export type Visibility = { scope: 'all' } | { scope: 'team'; personId: number };

const money = (expr: SQL) => sql<number>`coalesce(${expr}, 0)::bigint`.mapWith(Number);

/** Read only: counts and sums over the HRMS tables for the dashboard. */
@Injectable()
export class ReportsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async companies(tenantId: number) {
    return this.db.select({ id: legalEntities.id, code: legalEntities.code })
      .from(legalEntities).where(eq(legalEntities.tenantId, tenantId)).orderBy(asc(legalEntities.code));
  }

  /** Jobs visible to the caller held at some point between from and to (optionally some companies), with their department. */
  async jobs(tenantId: number, from: string, to: string, companyIds: number[], v: Visibility) {
    if (companyIds.length === 0) return [];
    return this.db.select({
      id: employments.id, personId: employments.personId, legalEntityId: employments.legalEntityId, company: legalEntities.code,
      status: employments.status, joinedOn: employments.joinedOn, exitOn: employments.exitOn, engagementType: employments.employmentType,
      departmentCode: departments.codePrefix, departmentName: departments.name,
    }).from(employments)
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .leftJoin(departments, eq(departments.id, employments.departmentId))
      .where(and(eq(employments.tenantId, tenantId), inArray(employments.legalEntityId, companyIds),
        lte(employments.joinedOn, to), or(isNull(employments.exitOn), gte(employments.exitOn, from)),
        v.scope === 'all' ? undefined : or(eq(employments.personId, v.personId), eq(employments.managerPersonId, v.personId))))
      .orderBy(asc(legalEntities.code), asc(employments.id));
  }

  /** Companies of the jobs a team caller can see (their own and those they manage). */
  async teamCompanyIds(tenantId: number, personId: number): Promise<number[]> {
    const rows = await this.db.selectDistinct({ id: employments.legalEntityId }).from(employments)
      .where(and(eq(employments.tenantId, tenantId), ne(employments.status, 'exited'),
        or(eq(employments.personId, personId), eq(employments.managerPersonId, personId))));
    return rows.map((r) => r.id);
  }

  async storedDays(employmentIds: number[], from: string, to: string) {
    if (employmentIds.length === 0) return [];
    return this.db.select({
      employmentId: workDays.employmentId, date: workDays.workDate, status: workDays.dayStatus,
      leaveDays: workDays.leaveDays, absentDays: workDays.absentDays,
      workedMinutes: workDays.workedMinutes, approvedOvertimeMinutes: workDays.approvedOvertimeMinutes,
    }).from(workDays).where(and(inArray(workDays.employmentId, employmentIds), between(workDays.workDate, from, to)));
  }

  /** Jobs with approved leave covering the date. */
  async onLeave(employmentIds: number[], date: string): Promise<number> {
    if (employmentIds.length === 0) return 0;
    const [row] = await this.db.select({ n: countDistinct(leaveRequests.employmentId) }).from(leaveRequests)
      .where(and(inArray(leaveRequests.employmentId, employmentIds), eq(leaveRequests.status, 'approved'),
        lte(leaveRequests.fromDate, date), gte(leaveRequests.toDate, date)));
    return row.n;
  }

  async openPositions(companyIds: number[]): Promise<number> {
    if (companyIds.length === 0) return 0;
    const [row] = await this.db.select({ n: count() }).from(positions)
      .where(and(inArray(positions.legalEntityId, companyIds), eq(positions.status, 'open')));
    return row.n;
  }

  /** Certificates of these people still valid today and expiring by `until`. */
  async certificatesExpiring(personIds: number[], today: string, until: string): Promise<number> {
    if (personIds.length === 0) return 0;
    const [row] = await this.db.select({ n: count() }).from(certificates)
      .where(and(inArray(certificates.personId, personIds), ne(certificates.status, 'expired'), between(certificates.expiresOn, today, until)));
    return row.n;
  }

  /** Per currency: claimed amounts waiting for a decision, approved amounts waiting for payment. */
  async pendingExpenses(employmentIds: number[]) {
    if (employmentIds.length === 0) return [];
    return this.db.select({
      currency: expenseClaims.currency,
      awaitingApprovalPaise: money(sql`sum(${expenseClaims.amountPaise}) filter (where ${expenseClaims.status} = 'submitted')`),
      awaitingPaymentPaise: money(sql`sum(${expenseClaims.approvedAmountPaise}) filter (where ${expenseClaims.status} = 'approved')`),
    }).from(expenseClaims)
      .where(and(inArray(expenseClaims.employmentId, employmentIds), inArray(expenseClaims.status, ['submitted', 'approved'])))
      .groupBy(expenseClaims.currency).orderBy(asc(expenseClaims.currency));
  }

  /** Submitted and approved leave requests touching the period, per status and leave type. */
  async leaveRequests(employmentIds: number[], from: string, to: string) {
    if (employmentIds.length === 0) return [];
    return this.db.select({ status: leaveRequests.status, code: leaveTypes.code, name: leaveTypes.name, n: count() })
      .from(leaveRequests).innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(and(inArray(leaveRequests.employmentId, employmentIds), inArray(leaveRequests.status, ['submitted', 'approved']),
        lte(leaveRequests.fromDate, to), gte(leaveRequests.toDate, from)))
      .groupBy(leaveRequests.status, leaveTypes.code, leaveTypes.name).orderBy(asc(leaveTypes.code));
  }

  /**
   * The latest audit entries: for all visibility, those of the companies counted (and, with company=all, those tied to
   * no company); for team, those about the team's people or done by the caller, without private-details entries.
   */
  async recentActivity(tenantId: number, f: { companyIds: number[]; includeNoCompany: boolean; team?: { personIds: number[]; me: number } }, limit = 20) {
    const where = f.team
      ? and(or(f.team.personIds.length ? inArray(auditLog.subjectPersonId, f.team.personIds) : undefined, eq(auditLog.actorPersonId, f.team.me)),
        notLike(auditLog.action, 'private.%'))
      : or(f.companyIds.length ? inArray(auditLog.legalEntityId, f.companyIds) : sql`false`, f.includeNoCompany ? isNull(auditLog.legalEntityId) : undefined);
    return this.db.select({
      at: auditLog.at, action: auditLog.action, summary: auditLog.summary,
      actorPublicId: persons.publicId, actorName: persons.displayName, company: legalEntities.code,
    }).from(auditLog)
      .leftJoin(persons, eq(persons.id, auditLog.actorPersonId))
      .leftJoin(legalEntities, eq(legalEntities.id, auditLog.legalEntityId))
      .where(and(eq(auditLog.tenantId, tenantId), where))
      .orderBy(desc(auditLog.at), desc(auditLog.id)).limit(limit);
  }
}
