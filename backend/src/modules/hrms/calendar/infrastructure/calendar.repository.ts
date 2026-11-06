import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, between, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { Holiday, WeeklyOff, WeeklyOffRule, WeeklyOffsQuery } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { employments } from '../../people/schema';
import { leaveRequests } from '../../leave/schema';
import { holidayCalendars, holidays, weeklyOffRules } from '../schema';
import { HolidayDate, RulePeriod } from '../domain/work-calendar';

/** The company of an override's job (a second join on core.legal_entities). */
const jobCompany = aliasedTable(legalEntities, 'job_company');

/** Whose rule: a company's default (no employmentId), or one job's override (the job's company and the job). */
export type RuleTarget = { legalEntityId: number; employmentId?: number };

/** Writes only hrms.holiday_calendars, hrms.holidays and hrms.weekly_off_rules; reads companies, jobs and leave. */
@Injectable()
export class CalendarRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findCompany(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: legalEntities.id, code: legalEntities.code }).from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row;
  }

  async findEmployment(tenantId: number, publicId: string) {
    const [row] = await this.db.select({
      id: employments.id, publicId: employments.publicId, personId: employments.personId, managerPersonId: employments.managerPersonId,
      legalEntityId: employments.legalEntityId, company: legalEntities.code,
    }).from(employments).innerJoin(legalEntities, eq(legalEntities.id, employments.legalEntityId))
      .where(and(eq(employments.tenantId, tenantId), eq(employments.publicId, publicId)));
    return row;
  }

  /** Company of each job. */
  async companiesOf(conn: Conn, employmentIds: number[]) {
    if (employmentIds.length === 0) return [];
    return conn.select({ id: employments.id, legalEntityId: employments.legalEntityId }).from(employments).where(inArray(employments.id, employmentIds));
  }

  // ---- holidays ----

  async holidays(tenantId: number, year: number, company?: string): Promise<Holiday[]> {
    return this.holidayView()
      .where(and(eq(holidayCalendars.tenantId, tenantId), eq(holidayCalendars.year, year), company ? eq(legalEntities.code, company) : undefined))
      .orderBy(asc(holidays.date), asc(legalEntities.code));
  }

  async holiday(publicId: string): Promise<Holiday | undefined> {
    const [row] = await this.holidayView().where(eq(holidays.publicId, publicId));
    return row;
  }

  /** By public id across tenants: a public id is unique everywhere, so a resend can be recognised. */
  async findHolidayTenant(publicId: string) {
    const [row] = await this.db.select({ tenantId: holidays.tenantId }).from(holidays).where(eq(holidays.publicId, publicId));
    return row?.tenantId;
  }

  /** The company's calendar for the year, created on first use. */
  async calendarFor(tx: Tx, tenantId: number, legalEntityId: number, year: number, company: string): Promise<number> {
    await tx.insert(holidayCalendars).values({ tenantId, legalEntityId, year, name: `${company} holidays ${year}` }).onConflictDoNothing();
    const [row] = await tx.select({ id: holidayCalendars.id }).from(holidayCalendars)
      .where(and(eq(holidayCalendars.legalEntityId, legalEntityId), eq(holidayCalendars.year, year)));
    return row.id;
  }

  async insertHoliday(tx: Tx, v: { tenantId: number; publicId: string; calendarId: number; date: string; name: string; isOptional: boolean; createdBy: number }) {
    await tx.insert(holidays).values(v);
  }

  async lockHoliday(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: holidays.id, date: holidays.date, legalEntityId: holidayCalendars.legalEntityId })
      .from(holidays).innerJoin(holidayCalendars, eq(holidayCalendars.id, holidays.calendarId))
      .where(and(eq(holidays.tenantId, tenantId), eq(holidays.publicId, publicId))).for('update');
    return row;
  }

  /** An approved leave of someone working in the company covers the date. */
  async inApprovedLeave(tx: Tx, legalEntityId: number, date: string): Promise<boolean> {
    const [row] = await tx.select({ id: leaveRequests.id }).from(leaveRequests)
      .where(and(eq(leaveRequests.legalEntityId, legalEntityId), eq(leaveRequests.status, 'approved'),
        lte(leaveRequests.fromDate, date), gte(leaveRequests.toDate, date))).limit(1);
    return row !== undefined;
  }

  async deleteHoliday(tx: Tx, id: number): Promise<void> {
    await tx.delete(holidays).where(eq(holidays.id, id));
  }

  // ---- weekly offs ----

  async weeklyOffs(tenantId: number, q: WeeklyOffsQuery): Promise<WeeklyOff[]> {
    const rows = await this.weeklyOffView().where(and(eq(weeklyOffRules.tenantId, tenantId),
      q.company ? or(eq(legalEntities.code, q.company), eq(jobCompany.code, q.company)) : undefined,
      q.employment ? eq(employments.publicId, q.employment) : undefined))
      .orderBy(sql`coalesce(${legalEntities.code}, ${jobCompany.code})`, sql`${weeklyOffRules.employmentId} NULLS FIRST`, asc(weeklyOffRules.validFrom));
    return rows.map(toWeeklyOff);
  }

  async weeklyOff(publicId: string): Promise<WeeklyOff | undefined> {
    const [row] = await this.weeklyOffView().where(eq(weeklyOffRules.publicId, publicId));
    return row && toWeeklyOff(row);
  }

  async findWeeklyOffTenant(publicId: string) {
    const [row] = await this.db.select({ tenantId: weeklyOffRules.tenantId }).from(weeklyOffRules).where(eq(weeklyOffRules.publicId, publicId));
    return row?.tenantId;
  }

  /** Ends the target's open rule that started before `validFrom` on the day before it. */
  async endOpenRule(tx: Tx, target: RuleTarget, validFrom: string, dayBefore: string): Promise<void> {
    await tx.update(weeklyOffRules).set({ validTo: dayBefore })
      .where(and(this.targetIs(target), isNull(weeklyOffRules.validTo), lt(weeklyOffRules.validFrom, validFrom)));
  }

  async insertWeeklyOff(tx: Tx, v: { tenantId: number; publicId: string; target: RuleTarget; validFrom: string; validTo?: string; rule: WeeklyOffRule; createdBy: number }) {
    const { target, ...rest } = v;
    await tx.insert(weeklyOffRules).values({ ...rest, legalEntityId: target.legalEntityId, employmentId: target.employmentId ?? null });
  }

  // ---- what the calendar is built from ----

  /** Rules of these companies and jobs that are in force at some point between from and to. */
  async rulesFor(conn: Conn, legalEntityIds: number[], employmentIds: number[], from: string, to: string) {
    const rows = await conn.select({
      legalEntityId: weeklyOffRules.legalEntityId, employmentId: weeklyOffRules.employmentId,
      validFrom: weeklyOffRules.validFrom, validTo: weeklyOffRules.validTo, rule: weeklyOffRules.rule,
    }).from(weeklyOffRules).where(and(
      or(legalEntityIds.length ? inArray(weeklyOffRules.legalEntityId, legalEntityIds) : undefined,
        employmentIds.length ? inArray(weeklyOffRules.employmentId, employmentIds) : undefined),
      lte(weeklyOffRules.validFrom, to), or(isNull(weeklyOffRules.validTo), gte(weeklyOffRules.validTo, from))));
    return rows as (RulePeriod & { legalEntityId: number | null; employmentId: number | null })[];
  }

  async holidaysFor(conn: Conn, legalEntityIds: number[], from: string, to: string): Promise<(HolidayDate & { legalEntityId: number })[]> {
    if (legalEntityIds.length === 0) return [];
    return conn.select({ legalEntityId: holidayCalendars.legalEntityId, date: holidays.date, name: holidays.name, optional: holidays.isOptional })
      .from(holidays).innerJoin(holidayCalendars, eq(holidayCalendars.id, holidays.calendarId))
      .where(and(inArray(holidayCalendars.legalEntityId, legalEntityIds), between(holidays.date, from, to)));
  }

  private targetIs(t: RuleTarget) {
    return t.employmentId !== undefined ? eq(weeklyOffRules.employmentId, t.employmentId)
      : and(eq(weeklyOffRules.legalEntityId, t.legalEntityId), isNull(weeklyOffRules.employmentId));
  }

  private holidayView() {
    return this.db.select({
      publicId: holidays.publicId, company: legalEntities.code, date: holidays.date, name: holidays.name, isOptional: holidays.isOptional,
    }).from(holidays)
      .innerJoin(holidayCalendars, eq(holidayCalendars.id, holidays.calendarId))
      .innerJoin(legalEntities, eq(legalEntities.id, holidayCalendars.legalEntityId))
      .$dynamic();
  }

  private weeklyOffView() {
    return this.db.select({
      publicId: weeklyOffRules.publicId,
      company: sql<string>`coalesce(${legalEntities.code}, ${jobCompany.code})`,
      employmentPublicId: employments.publicId, employeeCode: employments.employeeCode,
      personPublicId: persons.publicId, displayName: persons.displayName,
      validFrom: weeklyOffRules.validFrom, validTo: weeklyOffRules.validTo, rule: weeklyOffRules.rule,
    }).from(weeklyOffRules)
      .leftJoin(legalEntities, eq(legalEntities.id, weeklyOffRules.legalEntityId))
      .leftJoin(employments, eq(employments.id, weeklyOffRules.employmentId))
      .leftJoin(jobCompany, eq(jobCompany.id, employments.legalEntityId))
      .leftJoin(persons, eq(persons.id, employments.personId))
      .$dynamic();
  }
}

type WeeklyOffRow = {
  publicId: string; company: string; employmentPublicId: string | null; employeeCode: string | null;
  personPublicId: string | null; displayName: string | null; validFrom: string; validTo: string | null; rule: unknown;
};
function toWeeklyOff(r: WeeklyOffRow): WeeklyOff {
  return {
    publicId: r.publicId, company: r.company,
    employment: r.employmentPublicId
      ? { publicId: r.employmentPublicId, employeeCode: r.employeeCode!, person: { publicId: r.personPublicId!, displayName: r.displayName! } }
      : null,
    validFrom: r.validFrom, validTo: r.validTo, rule: r.rule as WeeklyOffRule,
  };
}
