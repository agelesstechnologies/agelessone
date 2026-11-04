import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CalendarDay, CalendarQuery, CreateHolidayRequest, CreateWeeklyOffRequest, Holiday, HolidaysQuery, WeeklyOff, WeeklyOffsQuery, WorkCalendar,
} from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireAll } from '../../../../platform/http/request-context';
import { addDays, datesBetween, todayIst } from '../../../../platform/time';
import { CalendarRepository, RuleTarget } from '../infrastructure/calendar.repository';
import { calendarDays, DayKind } from '../domain/work-calendar';
import { CALENDAR } from '../domain/permissions';

/** What changed: one company's days or one job's days, from a date (to = null: from then on). */
export interface CalendarChange { legalEntityId?: number; employmentId?: number; from: string; to: string | null }
type ChangeListener = (tx: Tx, change: CalendarChange) => Promise<void>;

/**
 * Use cases live here: open the transaction, call repositories and other facades, write the outbox event.
 * The one place where holidays and weekly offs are worked out: leave days and work days both ask here.
 */
@Injectable()
export class CalendarService {
  private readonly listeners: ChangeListener[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CalendarRepository) private readonly repo: CalendarRepository,
  ) {}

  health() { return { module: 'hrms', sub: 'calendar', ok: true }; }

  /** Attendance subscribes here to rebuild work days; listeners run inside the transaction of the change. */
  onChange(listener: ChangeListener): void {
    this.listeners.push(listener);
  }

  /** Every date from..to for each job: working, weekly_off or holiday. Pass the transaction to see its own changes. */
  async daysFor(conn: Conn, employmentIds: number[], from: string, to: string): Promise<Map<number, CalendarDay[]>> {
    const jobs = await this.repo.companiesOf(conn, employmentIds);
    const companies = [...new Set(jobs.map((j) => j.legalEntityId))];
    const rules = await this.repo.rulesFor(conn, companies, jobs.map((j) => j.id), from, to);
    const holidays = await this.repo.holidaysFor(conn, companies, from, to);
    const dates = datesBetween(from, to);
    return new Map(jobs.map((j) => [j.id, calendarDays(dates,
      rules.filter((r) => r.legalEntityId === j.legalEntityId && r.employmentId === null), rules.filter((r) => r.employmentId === j.id),
      holidays.filter((h) => h.legalEntityId === j.legalEntityId))]));
  }

  async dayKind(conn: Conn, employmentId: number, date: string): Promise<DayKind> {
    return (await this.daysFor(conn, [employmentId], date, date)).get(employmentId)?.[0]?.kind ?? 'working';
  }

  /** One job's calendar by its public id; undefined when there is no such job in the tenant. */
  async daysOfJob(tenantId: number, employmentPublicId: string, from: string, to: string): Promise<CalendarDay[] | undefined> {
    const job = await this.repo.findEmployment(tenantId, employmentPublicId);
    return job && (await this.daysFor(this.db, [job.id], from, to)).get(job.id);
  }

  /** A job's calendar: for the person, their manager (team scope) and HR (all). */
  async calendar(ctx: RequestContext, q: CalendarQuery): Promise<WorkCalendar> {
    const job = await this.repo.findEmployment(ctx.tenantId, q.employment);
    if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
    const scope = ctx.permissions[CALENDAR.viewPeople];
    const allowed = job.personId === ctx.personId || scope === 'all' || (scope === 'team' && job.managerPersonId === ctx.personId);
    if (!allowed) throw new AppError('FORBIDDEN', 403, 'This job is outside what you may see');
    const days = (await this.daysFor(this.db, [job.id], q.from, q.to)).get(job.id) ?? [];
    return { employment: { publicId: job.publicId, company: job.company }, from: q.from, to: q.to, days };
  }

  holidays(ctx: RequestContext, q: HolidaysQuery): Promise<Holiday[]> {
    return this.repo.holidays(ctx.tenantId, q.year, q.company);
  }

  /** HR adds a holiday to a company's year. The same publicId again returns the stored holiday (created: false). */
  async addHoliday(ctx: RequestContext, req: CreateHolidayRequest): Promise<{ holiday: Holiday; created: boolean }> {
    requireAll(ctx, CALENDAR.manage);
    if (req.publicId) {
      const tenant = await this.repo.findHolidayTenant(req.publicId);
      if (tenant === ctx.tenantId) return { holiday: (await this.repo.holiday(req.publicId))!, created: false };
      if (tenant !== undefined) throw new AppError('HRMS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const company = await this.repo.findCompany(ctx.tenantId, req.company);
    if (!company) throw new AppError('HRMS_UNKNOWN_COMPANY', 400, `Unknown company ${req.company}`);
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        const calendarId = await this.repo.calendarFor(tx, ctx.tenantId, company.id, Number(req.date.slice(0, 4)), company.code);
        await this.repo.insertHoliday(tx, {
          tenantId: ctx.tenantId, publicId, calendarId, date: req.date, name: req.name, isOptional: req.isOptional, createdBy: ctx.personId,
        });
        await this.changed(tx, { legalEntityId: company.id, from: req.date, to: req.date });
      });
    } catch (err) {
      const constraint = violatedConstraint(err);
      if (constraint === 'holidays_calendar_date_unique') throw new AppError('HRMS_HOLIDAY_EXISTS', 409, `${req.company} already has a holiday on ${req.date}`);
      if (constraint === 'holidays_public_id_unique') return this.addHoliday(ctx, req); // the same request arrived twice at once
      throw err;
    }
    return { holiday: (await this.repo.holiday(publicId))!, created: true };
  }

  /** Only a future holiday that no approved leave covers can be removed. */
  async deleteHoliday(ctx: RequestContext, publicId: string): Promise<void> {
    requireAll(ctx, CALENDAR.manage);
    await this.db.transaction(async (tx) => {
      const holiday = await this.repo.lockHoliday(tx, ctx.tenantId, publicId);
      if (!holiday) throw new AppError('HRMS_HOLIDAY_NOT_FOUND', 404, 'Holiday not found');
      if (holiday.date <= todayIst()) throw new AppError('HRMS_HOLIDAY_PAST', 409, 'Only a holiday still to come can be removed');
      if (await this.repo.inApprovedLeave(tx, holiday.legalEntityId, holiday.date)) {
        throw new AppError('HRMS_HOLIDAY_IN_USE', 409, 'An approved leave covers this holiday');
      }
      await this.repo.deleteHoliday(tx, holiday.id);
      await this.changed(tx, { legalEntityId: holiday.legalEntityId, from: holiday.date, to: holiday.date });
    });
  }

  weeklyOffs(ctx: RequestContext, q: WeeklyOffsQuery): Promise<WeeklyOff[]> {
    requireAll(ctx, CALENDAR.manage);
    return this.repo.weeklyOffs(ctx.tenantId, q);
  }

  /**
   * HR sets a company's weekly off, or one person's override, from validFrom. The same target's open rule that
   * started earlier ends the day before; any other overlap is refused. The same publicId again returns the stored rule.
   */
  async addWeeklyOff(ctx: RequestContext, req: CreateWeeklyOffRequest): Promise<{ weeklyOff: WeeklyOff; created: boolean }> {
    requireAll(ctx, CALENDAR.manage);
    if (req.publicId) {
      const tenant = await this.repo.findWeeklyOffTenant(req.publicId);
      if (tenant === ctx.tenantId) return { weeklyOff: (await this.repo.weeklyOff(req.publicId))!, created: false };
      if (tenant !== undefined) throw new AppError('HRMS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    let target: RuleTarget;
    if (req.company !== undefined) {
      const company = await this.repo.findCompany(ctx.tenantId, req.company);
      if (!company) throw new AppError('HRMS_UNKNOWN_COMPANY', 400, `Unknown company ${req.company}`);
      target = { legalEntityId: company.id };
    } else {
      const job = await this.repo.findEmployment(ctx.tenantId, req.employmentPublicId!);
      if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
      target = { legalEntityId: job.legalEntityId, employmentId: job.id }; // the company comes from the job, never the request
    }
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.endOpenRule(tx, target, req.validFrom, addDays(req.validFrom, -1));
        await this.repo.insertWeeklyOff(tx, {
          tenantId: ctx.tenantId, publicId, target, validFrom: req.validFrom, validTo: req.validTo, rule: req.rule, createdBy: ctx.personId,
        });
        await this.changed(tx, { ...target, from: req.validFrom, to: null });
      });
    } catch (err) {
      const overlap = violatedConstraint(err, '23P01');
      if (overlap?.startsWith('weekly_off_rules_')) {
        throw new AppError('HRMS_WEEKLY_OFF_OVERLAP', 409, 'Another weekly-off rule already covers some of these dates');
      }
      if (violatedConstraint(err) === 'weekly_off_rules_public_id_unique') return this.addWeeklyOff(ctx, req);
      throw err;
    }
    return { weeklyOff: (await this.repo.weeklyOff(publicId))!, created: true };
  }

  private async changed(tx: Tx, change: CalendarChange): Promise<void> {
    for (const listener of this.listeners) await listener(tx, change);
  }
}
