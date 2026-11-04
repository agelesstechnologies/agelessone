import { Inject, Injectable } from '@nestjs/common';
import { and, AnyColumn, asc, between, desc, eq, gte, inArray, isNull, lt, lte, or, sql, SQL } from 'drizzle-orm';
import { Punch } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { employments } from '../../people/schema';
import { leaveRequests } from '../../leave/schema';
import { attendanceCorrections, attendanceEvents, attendanceExclusions, overtimeRequests, workDays } from '../schema';

/** The punch is not left out by an approved correction. */
const notExcluded = sql`NOT EXISTS (SELECT 1 FROM ${attendanceExclusions} x WHERE x.punch_id = ${attendanceEvents.id})`;

/** Who a caller may see in the register and work hours: everyone, their team (and themselves), or only themselves. */
export type Visibility = { scope: 'all' } | { scope: 'team' | 'own'; personId: number };

export interface NewPunch {
  tenantId: number; publicId: string; personId: number; employmentId: number; kind: 'in' | 'out'; source: 'web' | 'correction' | 'auto';
  occurredAt: Date; latitude?: string; longitude?: string; accuracyM?: number; locationStatus: string | null; correctionId?: number;
}
export interface WorkDayValues {
  tenantId: number; personId: number; employmentId: number; workDate: string; firstIn: Date | null; lastOut: Date | null;
  workedMinutes: number; extraMinutes: number; approvedOvertimeMinutes: number; dayStatus: string; leaveDays: number; absentDays: number; workedOnLeave: boolean;
}

/** Writes only hrms.attendance_events (insert only) and hrms.work_days; reads people, jobs, companies, leave and corrections. */
@Injectable()
export class AttendanceRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findEmployment(tenantId: number, publicId: string) {
    const [row] = await this.db.select({
      id: employments.id, personId: employments.personId, status: employments.status,
      managerPersonId: employments.managerPersonId, legalEntityId: employments.legalEntityId,
    })
      .from(employments).where(and(eq(employments.tenantId, tenantId), eq(employments.publicId, publicId)));
    return row;
  }

  /** Jobs to rebuild: one by public id, or every job of a person. */
  async employmentsFor(tenantId: number, by: { employmentPublicId?: string; personPublicId?: string }) {
    const where = by.employmentPublicId
      ? and(eq(employments.tenantId, tenantId), eq(employments.publicId, by.employmentPublicId))
      : and(eq(employments.tenantId, tenantId), eq(persons.publicId, by.personPublicId!));
    return this.db.select({ id: employments.id, personId: employments.personId })
      .from(employments).innerJoin(persons, eq(persons.id, employments.personId)).where(where);
  }

  /** By public id across tenants: a public id is unique everywhere, so a resend can be recognised. */
  async findPunchOwner(publicId: string) {
    const [row] = await this.db.select({ tenantId: attendanceEvents.tenantId, personId: attendanceEvents.personId })
      .from(attendanceEvents).where(eq(attendanceEvents.publicId, publicId));
    return row;
  }

  async insertPunch(tx: Tx, p: NewPunch): Promise<void> {
    await tx.insert(attendanceEvents).values(p);
  }

  async punch(publicId: string): Promise<Punch | undefined> {
    const [r] = await this.db.select({
      publicId: attendanceEvents.publicId, kind: attendanceEvents.kind, occurredAt: attendanceEvents.occurredAt,
      receivedAt: attendanceEvents.receivedAt, employmentPublicId: employments.publicId, company: legalEntities.code,
      locationStatus: attendanceEvents.locationStatus,
    }).from(attendanceEvents).innerJoin(employments, eq(employments.id, attendanceEvents.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId)).where(eq(attendanceEvents.publicId, publicId));
    if (!r) return undefined;
    return {
      publicId: r.publicId, kind: r.kind as Punch['kind'], occurredAt: r.occurredAt.toISOString(), receivedAt: r.receivedAt.toISOString(),
      employment: { publicId: r.employmentPublicId, company: r.company }, locationStatus: r.locationStatus,
    };
  }

  /** Punches of the given jobs in [from, to) that count (not left out by a correction). */
  async punchesOf(conn: Conn, employmentIds: number[], from: Date, to: Date) {
    if (employmentIds.length === 0) return [];
    const rows = await conn.select({
      employmentId: attendanceEvents.employmentId, kind: attendanceEvents.kind, at: attendanceEvents.occurredAt,
      auto: sql<boolean>`${attendanceEvents.source} = 'auto'`,
    })
      .from(attendanceEvents)
      .where(and(inArray(attendanceEvents.employmentId, employmentIds), gte(attendanceEvents.occurredAt, from), lt(attendanceEvents.occurredAt, to), notExcluded))
      .orderBy(asc(attendanceEvents.occurredAt), asc(attendanceEvents.id));
    return rows as { employmentId: number; kind: 'in' | 'out'; at: Date; auto: boolean }[];
  }

  /** Every stored punch of the person in [from, to), including ones a correction left out (marked corrected). */
  async punchesForHistory(personId: number, from: Date, to: Date) {
    return this.db.select({
      employmentId: attendanceEvents.employmentId, publicId: attendanceEvents.publicId, kind: attendanceEvents.kind,
      occurredAt: attendanceEvents.occurredAt, source: attendanceEvents.source,
      corrected: sql<boolean>`NOT ${notExcluded}`,
    }).from(attendanceEvents)
      .where(and(eq(attendanceEvents.personId, personId), gte(attendanceEvents.occurredAt, from), lt(attendanceEvents.occurredAt, to)))
      .orderBy(asc(attendanceEvents.occurredAt), asc(attendanceEvents.id));
  }

  /** The latest day before `before` stored as a missed punch that has no open correction. */
  async lastMissedPunchDate(personId: number, before: string): Promise<string | null> {
    const [row] = await this.db.select({ date: workDays.workDate }).from(workDays)
      .where(and(eq(workDays.personId, personId), eq(workDays.dayStatus, 'missed_punch'), lt(workDays.workDate, before),
        sql`NOT EXISTS (SELECT 1 FROM ${attendanceCorrections} c WHERE c.employment_id = ${workDays.employmentId}
          AND c.work_date = ${workDays.workDate} AND c.status = 'submitted')`))
      .orderBy(desc(workDays.workDate)).limit(1);
    return row?.date ?? null;
  }

  /** Serialises a person's punches inside the transaction (the same lock the punch-order trigger takes). */
  async lockPerson(tx: Tx, personId: number): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${personId}::bigint)`);
  }

  /** The person's latest punch that counts, with its job and company. */
  async latestPunch(tx: Tx, personId: number) {
    const [row] = await tx.select({
      kind: attendanceEvents.kind, at: attendanceEvents.occurredAt, employmentId: attendanceEvents.employmentId, legalEntityId: employments.legalEntityId,
    }).from(attendanceEvents).innerJoin(employments, eq(employments.id, attendanceEvents.employmentId))
      .where(and(eq(attendanceEvents.personId, personId), notExcluded)).orderBy(desc(attendanceEvents.occurredAt), desc(attendanceEvents.id)).limit(1);
    return row;
  }

  /** Automatic punch-outs of the job in [from, to) that still count. */
  async autoPunches(tx: Tx, employmentId: number, from: Date, to: Date) {
    return tx.select({ id: attendanceEvents.id }).from(attendanceEvents)
      .where(and(eq(attendanceEvents.employmentId, employmentId), eq(attendanceEvents.source, 'auto'),
        gte(attendanceEvents.occurredAt, from), lt(attendanceEvents.occurredAt, to), notExcluded));
  }

  /** The person's latest punch on any job. */
  async lastPunch(personId: number) {
    const [row] = await this.db.select({
      kind: attendanceEvents.kind, occurredAt: attendanceEvents.occurredAt, employmentPublicId: employments.publicId, company: legalEntities.code,
    }).from(attendanceEvents).innerJoin(employments, eq(employments.id, attendanceEvents.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .where(and(eq(attendanceEvents.personId, personId), notExcluded)).orderBy(desc(attendanceEvents.occurredAt), desc(attendanceEvents.id)).limit(1);
    return row;
  }

  /** The person's jobs with company, for showing rows (today's live rows in history). */
  async jobsOfPerson(personId: number) {
    return this.db.select({ id: employments.id, publicId: employments.publicId, legalEntityId: employments.legalEntityId, company: legalEntities.code, employeeCode: employments.employeeCode })
      .from(employments).innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId)).where(eq(employments.personId, personId));
  }

  async companyOf(conn: Conn, employmentId: number): Promise<number> {
    const [row] = await conn.select({ id: employments.legalEntityId }).from(employments).where(eq(employments.id, employmentId));
    return row.id;
  }

  async isDayLocked(conn: Conn, employmentId: number, date: string): Promise<boolean> {
    const [row] = await conn.select({ locked: workDays.lockedForPayroll }).from(workDays)
      .where(and(eq(workDays.employmentId, employmentId), eq(workDays.workDate, date)));
    return row?.locked ?? false;
  }

  async lockWorkDay(tx: Tx, employmentId: number, date: string) {
    const [row] = await tx.select({ id: workDays.id, locked: workDays.lockedForPayroll }).from(workDays)
      .where(and(eq(workDays.employmentId, employmentId), eq(workDays.workDate, date))).for('update');
    return row;
  }

  /** Stored, unlocked work days of a company's jobs or of one job, from a date (to null: every later date). */
  async storedDays(tx: Tx, by: { legalEntityId?: number; employmentId?: number; from: string; to: string | null }) {
    return tx.select({ tenantId: workDays.tenantId, personId: workDays.personId, employmentId: workDays.employmentId, date: workDays.workDate })
      .from(workDays).innerJoin(employments, eq(employments.id, workDays.employmentId))
      .where(and(by.employmentId !== undefined ? eq(workDays.employmentId, by.employmentId) : eq(employments.legalEntityId, by.legalEntityId!),
        gte(workDays.workDate, by.from), by.to ? lte(workDays.workDate, by.to) : undefined, eq(workDays.lockedForPayroll, false)));
  }

  /** Approved leave of these jobs that touches from..to. */
  async approvedLeave(conn: Conn, employmentIds: number[], from: string, to: string) {
    if (employmentIds.length === 0) return [];
    return conn.select({
      employmentId: leaveRequests.employmentId, fromDate: leaveRequests.fromDate, toDate: leaveRequests.toDate,
      fromHalf: leaveRequests.fromHalf, toHalf: leaveRequests.toHalf,
    }).from(leaveRequests).where(and(inArray(leaveRequests.employmentId, employmentIds), eq(leaveRequests.status, 'approved'),
      lte(leaveRequests.fromDate, to), gte(leaveRequests.toDate, from)));
  }

  /** Minutes of each approved overtime request of these jobs on the date. */
  async approvedOvertimeOn(conn: Conn, employmentIds: number[], date: string) {
    if (employmentIds.length === 0) return [];
    return conn.select({ employmentId: overtimeRequests.employmentId, minutes: overtimeRequests.minutes }).from(overtimeRequests)
      .where(and(inArray(overtimeRequests.employmentId, employmentIds), eq(overtimeRequests.workDate, date), eq(overtimeRequests.status, 'approved')));
  }

  async deleteWorkDay(tx: Tx, id: number): Promise<void> {
    await tx.delete(workDays).where(eq(workDays.id, id));
  }

  async upsertWorkDay(tx: Tx, w: WorkDayValues): Promise<void> {
    const v = { ...w, leaveDays: String(w.leaveDays), absentDays: String(w.absentDays) };
    const { tenantId: _t, personId: _p, employmentId: _e, workDate: _d, ...changes } = v;
    await tx.insert(workDays).values(v)
      .onConflictDoUpdate({ target: [workDays.employmentId, workDays.workDate], set: { ...changes, updatedAt: new Date() } });
  }

  /** Stored work days of one person, newest first. */
  async workDaysOfPerson(personId: number, from: string, to: string) {
    return this.days().where(and(eq(workDays.personId, personId), between(workDays.workDate, from, to)))
      .orderBy(desc(workDays.workDate), asc(legalEntities.code));
  }

  /** Active jobs (optionally one company) visible to the caller, with that date's stored work day if any. */
  async register(tenantId: number, date: string, company: string | undefined, visibleTo: Visibility) {
    return this.db.select({
      employmentId: employments.id, legalEntityId: employments.legalEntityId, personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      firstIn: workDays.firstIn, lastOut: workDays.lastOut, workedMinutes: workDays.workedMinutes,
      extraMinutes: workDays.extraMinutes, approvedOvertimeMinutes: workDays.approvedOvertimeMinutes, dayStatus: workDays.dayStatus, locked: workDays.lockedForPayroll,
      leaveDays: workDays.leaveDays, absentDays: workDays.absentDays, workedOnLeave: workDays.workedOnLeave,
    }).from(employments)
      .innerJoin(persons, eq(persons.id, employments.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .leftJoin(workDays, and(eq(workDays.employmentId, employments.id), eq(workDays.workDate, date)))
      .where(and(eq(employments.tenantId, tenantId), eq(employments.status, 'active'),
        company ? eq(legalEntities.code, company) : undefined, this.visible(visibleTo)))
      .orderBy(asc(legalEntities.code), asc(persons.displayName));
  }

  /** Jobs (optionally one company) visible to the caller that were held at some point between from and to. */
  async jobsInRange(tenantId: number, from: string, to: string, company: string | undefined, visibleTo: Visibility) {
    return this.db.select({
      id: employments.id, legalEntityId: employments.legalEntityId, joinedOn: employments.joinedOn, exitOn: employments.exitOn,
      personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
    }).from(employments)
      .innerJoin(persons, eq(persons.id, employments.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .where(and(eq(employments.tenantId, tenantId), lte(employments.joinedOn, to), or(isNull(employments.exitOn), gte(employments.exitOn, from)),
        company ? eq(legalEntities.code, company) : undefined, this.visible(visibleTo)))
      .orderBy(asc(legalEntities.code), asc(persons.displayName));
  }

  /** Totals per job over its stored work days in the range, and the dates that have a stored day. */
  async workDayTotals(employmentIds: number[], from: string, to: string) {
    if (employmentIds.length === 0) return [];
    const n = (status: string) => sql<number>`count(*) filter (where ${workDays.dayStatus} = ${status})`.mapWith(Number);
    const sum = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
    return this.db.select({
      employmentId: workDays.employmentId,
      present: n('present'), halfDay: n('half_day'), missedPunch: n('missed_punch'), absent: n('absent'), leave: n('leave'),
      workedMinutes: sum(workDays.workedMinutes), extraMinutes: sum(workDays.extraMinutes), approvedOvertimeMinutes: sum(workDays.approvedOvertimeMinutes),
      leaveDays: sum(workDays.leaveDays), absentDays: sum(workDays.absentDays),
      dates: sql<string[]>`array_agg(${workDays.workDate}::text)`,
    }).from(workDays)
      .where(and(inArray(workDays.employmentId, employmentIds), between(workDays.workDate, from, to)))
      .groupBy(workDays.employmentId);
  }

  private visible(v: Visibility): SQL | undefined {
    if (v.scope === 'all') return undefined;
    if (v.scope === 'own') return eq(employments.personId, v.personId);
    return or(eq(employments.personId, v.personId), eq(employments.managerPersonId, v.personId));
  }

  private days() {
    return this.db.select({
      date: workDays.workDate, employmentId: workDays.employmentId, employmentPublicId: employments.publicId,
      company: legalEntities.code, employeeCode: employments.employeeCode, firstIn: workDays.firstIn, lastOut: workDays.lastOut,
      workedMinutes: workDays.workedMinutes, extraMinutes: workDays.extraMinutes, approvedOvertimeMinutes: workDays.approvedOvertimeMinutes, dayStatus: workDays.dayStatus,
      locked: workDays.lockedForPayroll, leaveDays: workDays.leaveDays, absentDays: workDays.absentDays, workedOnLeave: workDays.workedOnLeave,
    }).from(workDays)
      .innerJoin(employments, eq(employments.id, workDays.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .$dynamic();
  }
}
