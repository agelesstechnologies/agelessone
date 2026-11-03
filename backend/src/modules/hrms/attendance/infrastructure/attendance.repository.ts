import { Inject, Injectable } from '@nestjs/common';
import { and, asc, between, desc, eq, gte, inArray, lt, or, sql, SQL } from 'drizzle-orm';
import { Punch } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { employments } from '../../people/schema';
import { attendanceEvents, workDays } from '../schema';

/** Who a caller may see in the register and work hours: everyone, their team (and themselves), or only themselves. */
export type Visibility = { scope: 'all' } | { scope: 'team' | 'own'; personId: number };

export interface NewPunch {
  tenantId: number; publicId: string; personId: number; employmentId: number; kind: 'in' | 'out'; source: 'web';
  occurredAt: Date; latitude?: string; longitude?: string; accuracyM?: number; locationStatus: string;
}
export interface WorkDayValues {
  tenantId: number; personId: number; employmentId: number; workDate: string; firstIn: Date | null; lastOut: Date | null;
  workedMinutes: number; overtimeMinutes: number; dayStatus: string;
}

/** Writes only hrms.attendance_events (insert only) and hrms.work_days; reads people, jobs and companies. */
@Injectable()
export class AttendanceRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findEmployment(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: employments.id, personId: employments.personId, status: employments.status })
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

  /** Punches of the given jobs in [from, to). */
  async punchesOf(conn: Conn, employmentIds: number[], from: Date, to: Date) {
    if (employmentIds.length === 0) return [];
    const rows = await conn.select({ employmentId: attendanceEvents.employmentId, kind: attendanceEvents.kind, at: attendanceEvents.occurredAt })
      .from(attendanceEvents)
      .where(and(inArray(attendanceEvents.employmentId, employmentIds), gte(attendanceEvents.occurredAt, from), lt(attendanceEvents.occurredAt, to)))
      .orderBy(asc(attendanceEvents.occurredAt), asc(attendanceEvents.id));
    return rows as { employmentId: number; kind: 'in' | 'out'; at: Date }[];
  }

  /** The person's latest punch on any job. */
  async lastPunch(personId: number) {
    const [row] = await this.db.select({
      kind: attendanceEvents.kind, occurredAt: attendanceEvents.occurredAt, employmentPublicId: employments.publicId, company: legalEntities.code,
    }).from(attendanceEvents).innerJoin(employments, eq(employments.id, attendanceEvents.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .where(eq(attendanceEvents.personId, personId)).orderBy(desc(attendanceEvents.occurredAt), desc(attendanceEvents.id)).limit(1);
    return row;
  }

  /** The person's jobs with company, for showing rows (today's live rows in history). */
  async jobsOfPerson(personId: number) {
    return this.db.select({ id: employments.id, publicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode })
      .from(employments).innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId)).where(eq(employments.personId, personId));
  }

  async lockWorkDay(tx: Tx, employmentId: number, date: string) {
    const [row] = await tx.select({ id: workDays.id, locked: workDays.lockedForPayroll }).from(workDays)
      .where(and(eq(workDays.employmentId, employmentId), eq(workDays.workDate, date))).for('update');
    return row;
  }

  async upsertWorkDay(tx: Tx, v: WorkDayValues): Promise<void> {
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
      employmentId: employments.id, personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      firstIn: workDays.firstIn, lastOut: workDays.lastOut, workedMinutes: workDays.workedMinutes,
      overtimeMinutes: workDays.overtimeMinutes, dayStatus: workDays.dayStatus, locked: workDays.lockedForPayroll,
    }).from(employments)
      .innerJoin(persons, eq(persons.id, employments.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .leftJoin(workDays, and(eq(workDays.employmentId, employments.id), eq(workDays.workDate, date)))
      .where(and(eq(employments.tenantId, tenantId), eq(employments.status, 'active'),
        company ? eq(legalEntities.code, company) : undefined, this.visible(visibleTo)))
      .orderBy(asc(legalEntities.code), asc(persons.displayName));
  }

  /** Totals per job over stored work days in the range. */
  async workHours(tenantId: number, from: string, to: string, company: string | undefined, visibleTo: Visibility) {
    const n = (status: string) => sql<number>`count(*) filter (where ${workDays.dayStatus} = ${status})`.mapWith(Number);
    return this.db.select({
      personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, employeeCode: employments.employeeCode,
      present: n('present'), halfDay: n('half_day'), missedPunch: n('missed_punch'), absent: n('absent'),
      workedMinutes: sql<number>`coalesce(sum(${workDays.workedMinutes}), 0)`.mapWith(Number),
      overtimeMinutes: sql<number>`coalesce(sum(${workDays.overtimeMinutes}), 0)`.mapWith(Number),
    }).from(workDays)
      .innerJoin(employments, eq(employments.id, workDays.employmentId))
      .innerJoin(persons, eq(persons.id, workDays.personId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .where(and(eq(workDays.tenantId, tenantId), between(workDays.workDate, from, to),
        company ? eq(legalEntities.code, company) : undefined, this.visible(visibleTo)))
      .groupBy(persons.publicId, persons.displayName, employments.publicId, legalEntities.code, employments.employeeCode)
      .orderBy(asc(legalEntities.code), asc(persons.displayName));
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
      workedMinutes: workDays.workedMinutes, overtimeMinutes: workDays.overtimeMinutes, dayStatus: workDays.dayStatus,
      locked: workDays.lockedForPayroll,
    }).from(workDays)
      .innerJoin(employments, eq(employments.id, workDays.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .$dynamic();
  }
}
