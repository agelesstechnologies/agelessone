import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql, SQL } from 'drizzle-orm';
import { DecidedAs, LeaveLedgerEntry, LeaveRequestView, LeaveStatus, LeaveType } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { departments, employments } from '../../people/schema';
import { leaveLedger, leaveRequests, leaveTypes } from '../schema';

/** Who a caller may see in the report: everyone, their team (and themselves), or only themselves. */
export type Visibility = { scope: 'all' } | { scope: 'team' | 'own'; personId: number };

export interface NewLeaveRequest {
  tenantId: number; publicId: string; personId: number; employmentId: number; legalEntityId: number; leaveTypeId: number;
  fromDate: string; toDate: string; fromHalf: string; toHalf: string; days: number; reason?: string; approverPersonId: number | null;
}
export interface NewLedgerRow {
  tenantId: number; publicId?: string; employmentId: number; legalEntityId: number; leaveTypeId: number; year: number; entry: string; days: number;
  leaveRequestId?: number; reason?: string; postedBy: number;
}

const approver = aliasedTable(persons, 'approver');
const decider = aliasedTable(persons, 'decider');

/** Writes only hrms.leave_requests and hrms.leave_ledger (insert only); reads leave types, people, jobs and companies. */
@Injectable()
export class LeaveRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  types(tenantId: number): Promise<LeaveType[]> {
    return this.db.select({ code: leaveTypes.code, name: leaveTypes.name, isPaid: leaveTypes.isPaid })
      .from(leaveTypes).where(eq(leaveTypes.tenantId, tenantId)).orderBy(asc(leaveTypes.code));
  }

  async findType(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: leaveTypes.id }).from(leaveTypes).where(and(eq(leaveTypes.tenantId, tenantId), eq(leaveTypes.code, code)));
    return row;
  }

  async findEmployment(tenantId: number, publicId: string) {
    const [row] = await this.db.select({
      id: employments.id, personId: employments.personId, managerPersonId: employments.managerPersonId,
      legalEntityId: employments.legalEntityId, status: employments.status, departmentHeadId: departments.headPersonId,
    }).from(employments).leftJoin(departments, eq(departments.id, employments.departmentId))
      .where(and(eq(employments.tenantId, tenantId), eq(employments.publicId, publicId)));
    return row;
  }

  // ---- requests ----

  /** By public id across tenants: a public id is unique everywhere, so a resend can be recognised. */
  async findRequestOwner(publicId: string) {
    const [row] = await this.db.select({ tenantId: leaveRequests.tenantId, personId: leaveRequests.personId })
      .from(leaveRequests).where(eq(leaveRequests.publicId, publicId));
    return row;
  }

  async insertRequest(tx: Tx, r: NewLeaveRequest): Promise<void> {
    await tx.insert(leaveRequests).values({ ...r, days: String(r.days) });
  }

  async request(tenantId: number, publicId: string): Promise<LeaveRequestView | undefined> {
    const [row] = await this.view().where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.publicId, publicId)));
    return row && toView(row);
  }

  async mine(personId: number, status?: LeaveStatus): Promise<LeaveRequestView[]> {
    const rows = await this.view().where(and(eq(leaveRequests.personId, personId), status ? eq(leaveRequests.status, status) : undefined))
      .orderBy(desc(leaveRequests.fromDate), desc(leaveRequests.id));
    return rows.map(toView);
  }

  /** Submitted requests the caller may decide: naming them as approver (team), or anyone else's (all). */
  async toApprove(tenantId: number, personId: number, everyone: boolean): Promise<LeaveRequestView[]> {
    const rows = await this.view().where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.status, 'submitted'),
      everyone ? ne(leaveRequests.personId, personId) : eq(leaveRequests.approverPersonId, personId)))
      .orderBy(asc(leaveRequests.fromDate), asc(leaveRequests.id));
    return rows.map(toView);
  }

  /** Submitted and approved requests touching from..to, visible to the caller. */
  async report(tenantId: number, from: string, to: string, company: string | undefined, visibleTo: Visibility): Promise<LeaveRequestView[]> {
    const rows = await this.view().where(and(eq(leaveRequests.tenantId, tenantId),
      or(eq(leaveRequests.status, 'submitted'), eq(leaveRequests.status, 'approved')),
      lte(leaveRequests.fromDate, to), gte(leaveRequests.toDate, from),
      company ? eq(legalEntities.code, company) : undefined, this.visible(visibleTo)))
      .orderBy(asc(legalEntities.code), asc(leaveRequests.fromDate), asc(persons.displayName));
    return rows.map(toView);
  }

  /** Jobs held at some point between from and to (optionally one company), visible to the caller. */
  async jobsInRange(tenantId: number, from: string, to: string, company: string | undefined, visibleTo: Visibility) {
    return this.db.select({
      id: employments.id, personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
    }).from(employments)
      .innerJoin(persons, eq(persons.id, employments.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .where(and(eq(employments.tenantId, tenantId), lte(employments.joinedOn, to), or(isNull(employments.exitOn), gte(employments.exitOn, from)),
        company ? eq(legalEntities.code, company) : undefined,
        visibleTo.scope === 'all' ? undefined : visibleTo.scope === 'own' ? eq(employments.personId, visibleTo.personId)
          : or(eq(employments.personId, visibleTo.personId), eq(employments.managerPersonId, visibleTo.personId))))
      .orderBy(asc(legalEntities.code), asc(persons.displayName));
  }

  /** Approved leave of these jobs touching from..to. */
  async approvedInRange(employmentIds: number[], from: string, to: string) {
    if (employmentIds.length === 0) return [];
    return this.db.select({
      employmentId: leaveRequests.employmentId, typeCode: leaveTypes.code, fromDate: leaveRequests.fromDate, toDate: leaveRequests.toDate,
      fromHalf: leaveRequests.fromHalf, toHalf: leaveRequests.toHalf,
    }).from(leaveRequests).innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(and(inArray(leaveRequests.employmentId, employmentIds), eq(leaveRequests.status, 'approved'),
        lte(leaveRequests.fromDate, to), gte(leaveRequests.toDate, from)));
  }

  /** Current balance (sum of the ledger) per job and leave type. */
  async balancesOf(employmentIds: number[]) {
    if (employmentIds.length === 0) return [];
    return this.db.select({
      employmentId: leaveLedger.employmentId, typeCode: leaveTypes.code,
      balance: sql<number>`coalesce(sum(${leaveLedger.days}), 0)`.mapWith(Number),
    }).from(leaveLedger).innerJoin(leaveTypes, eq(leaveTypes.id, leaveLedger.leaveTypeId))
      .where(inArray(leaveLedger.employmentId, employmentIds)).groupBy(leaveLedger.employmentId, leaveTypes.code);
  }

  async lockRequest(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({
      id: leaveRequests.id, personId: leaveRequests.personId, employmentId: leaveRequests.employmentId,
      leaveTypeId: leaveRequests.leaveTypeId, legalEntityId: leaveRequests.legalEntityId, fromDate: leaveRequests.fromDate, toDate: leaveRequests.toDate,
      fromHalf: leaveRequests.fromHalf, toHalf: leaveRequests.toHalf, days: leaveRequests.days,
      status: leaveRequests.status, approverPersonId: leaveRequests.approverPersonId, publicId: leaveRequests.publicId, personName: persons.displayName,
    }).from(leaveRequests).innerJoin(persons, eq(persons.id, leaveRequests.personId))
      .where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.publicId, publicId))).for('update');
    return row && { ...row, days: Number(row.days), status: row.status as LeaveStatus };
  }

  /** decidedBy null only with decidedAs 'no_approval_required' (the database checks it). */
  async decide(tx: Tx, id: number, status: 'approved' | 'rejected', decidedBy: number | null, decidedAs: DecidedAs, reason?: string): Promise<void> {
    await tx.update(leaveRequests).set({ status, decidedBy, decidedAs, decidedAt: new Date(), decisionReason: reason ?? null }).where(eq(leaveRequests.id, id));
  }

  async cancel(tx: Tx, id: number, cancelledBy: number): Promise<void> {
    await tx.update(leaveRequests).set({ status: 'cancelled', cancelledBy, cancelledAt: new Date() }).where(eq(leaveRequests.id, id));
  }

  // ---- ledger ----

  async insertLedger(tx: Tx, rows: NewLedgerRow[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(leaveLedger).values(rows.map((r) => ({ ...r, days: String(r.days) })));
  }

  /** The 'taken' rows of a request, to give back when an approved leave is cancelled. */
  async takenRows(tx: Tx, leaveRequestId: number) {
    const rows = await tx.select({ year: leaveLedger.year, days: leaveLedger.days }).from(leaveLedger)
      .where(and(eq(leaveLedger.leaveRequestId, leaveRequestId), eq(leaveLedger.entry, 'taken')));
    return rows.map((r) => ({ year: r.year, days: Number(r.days) }));
  }

  /** Balance of one job and type: the sum of every ledger row. */
  async balance(conn: Conn, employmentId: number, leaveTypeId: number): Promise<number> {
    const [row] = await conn.select({ sum: sql<number>`coalesce(sum(${leaveLedger.days}), 0)`.mapWith(Number) })
      .from(leaveLedger).where(and(eq(leaveLedger.employmentId, employmentId), eq(leaveLedger.leaveTypeId, leaveTypeId)));
    return row.sum;
  }

  /** Every leave type for each of the person's active jobs, with its balance (0 when nothing is posted yet). */
  async balancesOfPerson(tenantId: number, personId: number) {
    return this.db.select({
      employmentPublicId: employments.publicId, company: legalEntities.code, code: leaveTypes.code, name: leaveTypes.name,
      balance: sql<number>`coalesce((SELECT sum(l.days) FROM hrms.leave_ledger l WHERE l.employment_id = ${employments.id} AND l.leave_type_id = ${leaveTypes.id}), 0)`.mapWith(Number),
    }).from(employments)
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .innerJoin(leaveTypes, eq(leaveTypes.tenantId, employments.tenantId))
      .where(and(eq(employments.tenantId, tenantId), eq(employments.personId, personId), eq(employments.status, 'active')))
      .orderBy(asc(legalEntities.code), asc(leaveTypes.code));
  }

  async findLedgerTenant(publicId: string) {
    const [row] = await this.db.select({ tenantId: leaveLedger.tenantId }).from(leaveLedger).where(eq(leaveLedger.publicId, publicId));
    return row?.tenantId;
  }

  async ledgerEntry(publicId: string): Promise<LeaveLedgerEntry | undefined> {
    const [r] = await this.db.select({
      publicId: leaveLedger.publicId, employmentPublicId: employments.publicId, company: legalEntities.code,
      code: leaveTypes.code, name: leaveTypes.name, year: leaveLedger.year, entry: leaveLedger.entry, days: leaveLedger.days,
      reason: leaveLedger.reason, postedAt: leaveLedger.postedAt,
    }).from(leaveLedger)
      .innerJoin(employments, eq(employments.id, leaveLedger.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveLedger.leaveTypeId))
      .where(eq(leaveLedger.publicId, publicId));
    return r && {
      publicId: r.publicId, employment: { publicId: r.employmentPublicId, company: r.company }, leaveType: { code: r.code, name: r.name },
      year: r.year, entry: r.entry as LeaveLedgerEntry['entry'], days: Number(r.days), reason: r.reason, postedAt: r.postedAt.toISOString(),
    };
  }

  private visible(v: Visibility): SQL | undefined {
    if (v.scope === 'all') return undefined;
    if (v.scope === 'own') return eq(leaveRequests.personId, v.personId);
    return or(eq(leaveRequests.personId, v.personId), eq(employments.managerPersonId, v.personId));
  }

  private view() {
    return this.db.select({
      publicId: leaveRequests.publicId, personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      typeCode: leaveTypes.code, typeName: leaveTypes.name,
      fromDate: leaveRequests.fromDate, toDate: leaveRequests.toDate, fromHalf: leaveRequests.fromHalf, toHalf: leaveRequests.toHalf,
      days: leaveRequests.days, reason: leaveRequests.reason, status: leaveRequests.status,
      approverPublicId: approver.publicId, approverName: approver.displayName,
      deciderPublicId: decider.publicId, deciderName: decider.displayName,
      decidedAs: leaveRequests.decidedAs, decidedAt: leaveRequests.decidedAt, decisionReason: leaveRequests.decisionReason,
      cancelledAt: leaveRequests.cancelledAt, createdAt: leaveRequests.createdAt,
    }).from(leaveRequests)
      .innerJoin(persons, eq(persons.id, leaveRequests.personId))
      .innerJoin(employments, eq(employments.id, leaveRequests.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, leaveRequests.legalEntityId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .leftJoin(approver, eq(approver.id, leaveRequests.approverPersonId))
      .leftJoin(decider, eq(decider.id, leaveRequests.decidedBy))
      .$dynamic();
  }
}

interface ViewRow {
  publicId: string; personPublicId: string; personName: string; employmentPublicId: string; company: string; employeeCode: string;
  typeCode: string; typeName: string; fromDate: string; toDate: string; fromHalf: string; toHalf: string; days: string;
  reason: string | null; status: string; approverPublicId: string | null; approverName: string | null;
  deciderPublicId: string | null; deciderName: string | null; decidedAs: string | null; decidedAt: Date | null; decisionReason: string | null;
  cancelledAt: Date | null; createdAt: Date;
}
function toView(r: ViewRow): LeaveRequestView {
  return {
    publicId: r.publicId, person: { publicId: r.personPublicId, displayName: r.personName },
    employment: { publicId: r.employmentPublicId, company: r.company, employeeCode: r.employeeCode },
    leaveType: { code: r.typeCode, name: r.typeName },
    fromDate: r.fromDate, toDate: r.toDate,
    fromHalf: r.fromHalf as LeaveRequestView['fromHalf'], toHalf: r.toHalf as LeaveRequestView['toHalf'],
    days: Number(r.days), reason: r.reason, status: r.status as LeaveStatus,
    approver: r.approverPublicId ? { publicId: r.approverPublicId, displayName: r.approverName! } : null,
    decidedBy: r.deciderPublicId ? { publicId: r.deciderPublicId, displayName: r.deciderName! } : null,
    decidedAs: r.decidedAs as DecidedAs | null,
    decidedAt: r.decidedAt?.toISOString() ?? null, decisionReason: r.decisionReason,
    cancelledAt: r.cancelledAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
  };
}
