import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AttendanceHistoryQuery, AttendanceRegister, AttendanceRegisterQuery, DayStatus, HistoryRow, Punch, PunchNotice, PunchRequest,
  RebuildResult, RebuildWorkDaysRequest, TodayAttendance, WorkDayRow, WorkHours, WorkHoursQuery,
} from '@ageless/shared';
import { Conn, databaseMessage, DB, Db, Tx, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireAll } from '../../../../platform/http/request-context';
import { addDays, datesBetween, istDayStart, todayIst } from '../../../../platform/time';
import { CoreFacade } from '../../../core/core.facade';
import { CalendarChange, CalendarService } from '../../calendar/application/calendar.service';
import { MonthLocksService } from './month-locks.service';
import { AttendanceRepository, Visibility } from '../infrastructure/attendance.repository';
import { approvedOvertime, DayPolicy, DaySummary, LeavePart, leavePartOn, summarizeDay } from '../domain/day-summary';
import { calculateWorkDay } from '../domain/work-day-calculator';
import { ATTENDANCE } from '../domain/permissions';
import { toCsv } from '../../../../platform/csv';

/** A job's work day was recalculated (punch, correction, leave, calendar, rebuild) - inside that transaction. */
export interface DayChange { tenantId: number; personId: number; employmentId: number; date: string }
export type DayListener = (tx: Tx, change: DayChange) => Promise<void>;
/** A new punch was stored (after its day was rebuilt), inside that transaction; may answer notices for the app. */
export interface PunchStored { tenantId: number; personId: number; kind: 'in' | 'out'; at: Date }
export type PunchListener = (tx: Tx, punch: PunchStored) => Promise<PunchNotice[]>;

/** A device clock may run a little fast; anything later than this is refused. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Use cases live here: open the transaction, call repositories and other facades, write the outbox event.
 * Punches are stored as they come (append-only); work days are recalculated from them per job and IST date.
 * Holidays and weekly offs come from the CalendarService; when they change, the stored days they touch are rebuilt.
 * Approved leave makes a working day 'leave'; Leave rebuilds the days when it approves or cancels (rebuildRange).
 * Day rules (full / half day minutes, open punch limit, overtime paid) are company policies read per company and date.
 */
@Injectable()
export class AttendanceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AttendanceRepository) private readonly repo: AttendanceRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
    @Inject(CalendarService) private readonly calendar: CalendarService,
    @Inject(MonthLocksService) private readonly months: MonthLocksService,
  ) {
    calendar.onChange((tx, change) => this.calendarChanged(tx, change));
  }

  private readonly dayListeners: DayListener[] = [];
  private readonly punchListeners: PunchListener[] = [];

  /** Other modules (through HrmsFacade) follow work-day changes, e.g. tickets stop running timers and recalculate ticket time. */
  onDayChanged(listener: DayListener): void { this.dayListeners.push(listener); }
  /** Other modules (through HrmsFacade) add notices to the answer of a new punch. */
  onPunchStored(listener: PunchListener): void { this.punchListeners.push(listener); }

  /** The person's latest punch that counts (any job), or undefined. auto: added by the system for a forgotten punch-out. */
  latestPunchOf(conn: Conn, personId: number): Promise<{ kind: 'in' | 'out'; at: Date; auto: boolean; legalEntityId: number } | undefined> {
    return this.repo.latestPunchOf(conn, personId);
  }

  /**
   * The person's attended periods on an IST date (complete in/out pairs of each job, as the work day counts them) and the
   * minutes they add up to. An open punch-in adds nothing.
   */
  async attendedPeriods(conn: Conn, personId: number, date: string): Promise<{ periods: { start: Date; end: Date }[]; workedMinutes: number }> {
    const jobs = await this.repo.jobsOfPerson(personId);
    const punches = await this.repo.punchesOf(conn, jobs.map((j) => j.id), istDayStart(date), istDayStart(addDays(date, 1)));
    const periods: { start: Date; end: Date }[] = [];
    let workedMinutes = 0;
    for (const job of jobs) {
      const own = punches.filter((p) => p.employmentId === job.id);
      workedMinutes += calculateWorkDay(own, { fullDayMinutes: 1, halfDayMinutes: 1 }).workedMinutes;
      let openIn: Date | null = null;
      for (const p of own) {
        if (p.kind === 'in') openIn = p.at;
        else if (openIn) { periods.push({ start: openIn, end: p.at }); openIn = null; }
      }
    }
    return { periods, workedMinutes };
  }

  health() { return { module: 'hrms', sub: 'attendance', ok: true }; }

  /**
   * Stores a punch on one of the caller's jobs and rebuilds that job's work day in the same transaction.
   * The same publicId again returns the stored punch (created: false). Order is enforced by the database trigger.
   * A punch-in after a forgotten punch-out first closes the open punch-in automatically (see autoPunchOut).
   */
  async punch(ctx: RequestContext, req: PunchRequest): Promise<{ punch: Punch; created: boolean }> {
    const resent = await this.resent(ctx, req.publicId);
    if (resent) return { punch: resent, created: false };

    const job = await this.repo.findEmployment(ctx.tenantId, req.employmentPublicId);
    if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
    if (job.personId !== ctx.personId) throw new AppError('HRMS_NOT_YOUR_EMPLOYMENT', 403, 'You can only punch on your own job');
    if (job.status !== 'active') throw new AppError('HRMS_EMPLOYMENT_NOT_ACTIVE', 409, 'This job is not active');
    const occurredAt = new Date(req.occurredAt);
    if (occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw new AppError('HRMS_PUNCH_IN_FUTURE', 400, 'The punch time is in the future');
    await this.months.assertOpen(this.db, job.legalEntityId, todayIst(occurredAt));
    // the address is looked up before the transaction (a slow provider never holds a lock); no answer: coordinates only
    const found = req.latitude === undefined ? null : await this.core.lookUpAddress(req.latitude, req.longitude!);

    const notices: PunchNotice[] = [];
    try {
      await this.db.transaction(async (tx) => {
        if (req.kind === 'in') await this.autoPunchOut(tx, ctx.tenantId, ctx.personId, occurredAt);
        const place = found ? await this.core.savePlace(tx, { tenantId: ctx.tenantId, latitude: req.latitude!, longitude: req.longitude!, accuracyM: req.accuracyM }, found) : null;
        await this.repo.insertPunch(tx, { placeId: place?.id ?? null,
          tenantId: ctx.tenantId, publicId: req.publicId, personId: ctx.personId, employmentId: job.id, legalEntityId: job.legalEntityId, kind: req.kind, source: 'web',
          occurredAt, latitude: req.latitude?.toString(), longitude: req.longitude?.toString(), accuracyM: req.accuracyM,
          // geofencing needs work locations (not built yet): record whether a position was sent
          locationStatus: req.latitude === undefined ? 'not_taken' : 'not_configured',
        });
        await this.rebuildDay(tx, ctx.tenantId, ctx.personId, job.id, todayIst(occurredAt));
        for (const l of this.punchListeners) notices.push(...await l(tx, { tenantId: ctx.tenantId, personId: ctx.personId, kind: req.kind, at: occurredAt }));
      });
    } catch (err) {
      const message = databaseMessage(err) ?? '';
      if (message.startsWith('HRMS_PUNCH_ORDER')) throw new AppError('HRMS_PUNCH_ORDER', 409, message.replace(/^HRMS_PUNCH_ORDER:\s*/, ''));
      if (message.startsWith('HRMS_MONTH_LOCKED')) throw new AppError('HRMS_MONTH_LOCKED', 409, message.replace(/^HRMS_MONTH_LOCKED:\s*/, ''));
      if (violatedConstraint(err) === 'attendance_events_public_id_unique') {
        const again = await this.resent(ctx, req.publicId); // the same punch arrived twice at the same moment
        if (again) return { punch: again, created: false };
      }
      throw err;
    }
    return { punch: { ...(await this.repo.punch(req.publicId))!, ...(notices.length ? { notices } : {}) }, created: true };
  }

  /**
   * Am I punched in, since when, and how many minutes today (all jobs, the open punch counted up to now); and the latest
   * earlier day still a missed punch without an open correction, so the app can ask for one.
   */
  async today(ctx: RequestContext): Promise<TodayAttendance> {
    const now = new Date();
    const date = todayIst(now);
    const last = await this.repo.lastPunch(ctx.personId);
    const jobs = await this.repo.jobsOfPerson(ctx.personId);
    const punches = await this.repo.punchesOf(this.db, jobs.map((j) => j.id), istDayStart(date), istDayStart(addDays(date, 1)));
    let workedMinutes = 0;
    for (const j of jobs) {
      const policy = await this.policy(ctx.tenantId, j.legalEntityId, date);
      workedMinutes += summarizeDay(punches.filter((p) => p.employmentId === j.id), policy, now).workedMinutes;
    }
    const open = last?.kind === 'in';
    return {
      date, punchedIn: open, since: open ? last.occurredAt.toISOString() : null,
      employment: open ? { publicId: last.employmentPublicId, company: last.company } : null, workedMinutes,
      lastMissedPunchDate: await this.repo.lastMissedPunchDate(ctx.personId, date),
    };
  }

  /**
   * My work days per date and company, newest first, each with all its punches (ones a correction left out are marked
   * corrected); today is calculated live (running time while punched in).
   */
  async history(ctx: RequestContext, q: AttendanceHistoryQuery): Promise<HistoryRow[]> {
    const days = await this.days(ctx, q);
    const punches = await this.repo.punchesForHistory(ctx.personId, istDayStart(q.from), istDayStart(addDays(q.to, 1)));
    const jobs = new Map((await this.repo.jobsOfPerson(ctx.personId)).map((j) => [j.id, j.publicId]));
    return days.map((d) => ({
      ...d,
      punches: punches.filter((p) => jobs.get(p.employmentId) === d.employment.publicId && todayIst(p.occurredAt) === d.date).map((p) => ({
        publicId: p.publicId, kind: p.kind as 'in' | 'out', occurredAt: p.occurredAt.toISOString(), source: p.source, corrected: p.corrected,
      })),
    }));
  }

  private async days(ctx: RequestContext, q: AttendanceHistoryQuery): Promise<WorkDayRow[]> {
    const stored = await this.repo.workDaysOfPerson(ctx.personId, q.from, q.to);
    const rows: WorkDayRow[] = stored.map((d) => ({
      date: d.date, employment: { publicId: d.employmentPublicId, company: d.company, employeeCode: d.employeeCode },
      firstIn: d.firstIn?.toISOString() ?? null, lastOut: d.lastOut?.toISOString() ?? null,
      workedMinutes: d.workedMinutes, extraMinutes: d.extraMinutes, approvedOvertimeMinutes: d.approvedOvertimeMinutes, status: d.dayStatus as DayStatus, locked: d.locked, running: false,
      leaveDays: Number(d.leaveDays), absentDays: Number(d.absentDays), workedOnLeave: d.workedOnLeave,
    }));
    const date = todayIst();
    if (date < q.from || date > q.to) return rows;

    const now = new Date();
    const jobs = await this.repo.jobsOfPerson(ctx.personId);
    const punches = await this.repo.punchesOf(this.db, jobs.map((j) => j.id), istDayStart(date), istDayStart(addDays(date, 1)));
    const calendar = await this.calendar.daysFor(this.db, jobs.map((j) => j.id), date, date);
    const leave = await this.leaveOn(this.db, jobs.map((j) => j.id), date);
    const overtime = await this.repo.approvedOvertimeOn(this.db, jobs.map((j) => j.id), date);
    const live: WorkDayRow[] = [];
    for (const job of jobs) {
      const own = punches.filter((p) => p.employmentId === job.id);
      const storedRow = rows.find((r) => r.date === date && r.employment.publicId === job.publicId);
      if (own.length === 0 || storedRow?.locked) continue;
      const s = summarizeDay(own, await this.policy(ctx.tenantId, job.legalEntityId, date), now, calendar.get(job.id)?.[0]?.kind, leave.get(job.id));
      live.push({ date, employment: { publicId: job.publicId, company: job.company, employeeCode: job.employeeCode },
        ...shown(s, overtime.filter((o) => o.employmentId === job.id).map((o) => o.minutes)) });
    }
    const replaced = new Set(live.map((r) => r.employment.publicId));
    return [...live, ...rows.filter((r) => !(r.date === date && replaced.has(r.employment.publicId)))]
      .sort((a, b) => b.date.localeCompare(a.date) || a.employment.company.localeCompare(b.employment.company));
  }

  /**
   * Everyone's day on one date (people with an active job). No row: absent (one absent day), or the weekly off /
   * holiday; today is live. Totals add up leave and absent days.
   */
  async register(ctx: RequestContext, q: AttendanceRegisterQuery): Promise<AttendanceRegister> {
    const rows = await this.repo.register(ctx.tenantId, q.date, q.company, this.visibility(ctx));
    const isToday = q.date === todayIst();
    const now = new Date();
    const punches = isToday ? await this.repo.punchesOf(this.db, rows.map((r) => r.employmentId), istDayStart(q.date), istDayStart(addDays(q.date, 1))) : [];
    const calendar = await this.calendar.daysFor(this.db, rows.map((r) => r.employmentId), q.date, q.date);
    const leave = isToday ? await this.leaveOn(this.db, rows.map((r) => r.employmentId), q.date) : new Map<number, LeavePart>();
    const overtime = isToday ? await this.repo.approvedOvertimeOn(this.db, rows.map((r) => r.employmentId), q.date) : [];
    const out: AttendanceRegister['rows'] = [];
    for (const r of rows) {
      const kind = calendar.get(r.employmentId)?.[0]?.kind ?? 'working';
      const own = punches.filter((p) => p.employmentId === r.employmentId);
      const base = {
        person: { publicId: r.personPublicId, displayName: r.personName },
        employment: { publicId: r.employmentPublicId, company: r.company, employeeCode: r.employeeCode },
      };
      if (isToday && own.length > 0 && !r.locked) {
        const s = summarizeDay(own, await this.policy(ctx.tenantId, r.legalEntityId, q.date), now, kind, leave.get(r.employmentId));
        out.push({ ...base, ...shown(s, overtime.filter((o) => o.employmentId === r.employmentId).map((o) => o.minutes)) });
      } else if (r.dayStatus) {
        out.push({ ...base, firstIn: r.firstIn?.toISOString() ?? null, lastOut: r.lastOut?.toISOString() ?? null,
          workedMinutes: r.workedMinutes ?? 0, extraMinutes: r.extraMinutes ?? 0, approvedOvertimeMinutes: r.approvedOvertimeMinutes ?? 0, status: r.dayStatus as DayStatus,
          locked: r.locked ?? false, running: false, leaveDays: Number(r.leaveDays), absentDays: Number(r.absentDays), workedOnLeave: r.workedOnLeave ?? false });
      } else {
        out.push({ ...base, firstIn: null, lastOut: null, workedMinutes: 0, extraMinutes: 0, approvedOvertimeMinutes: 0, status: kind === 'working' ? 'absent' : kind,
          locked: false, running: false, leaveDays: 0, absentDays: kind === 'working' ? 1 : 0, workedOnLeave: false });
      }
    }
    const summary: Partial<Record<DayStatus, number>> = {};
    for (const r of out) summary[r.status] = (summary[r.status] ?? 0) + 1;
    const totals = { leaveDays: sum(out.map((r) => r.leaveDays)), absentDays: sum(out.map((r) => r.absentDays)) };
    return { date: q.date, company: q.company ?? null, rows: out, summary, totals };
  }

  /**
   * Per job over the range: day counts, minutes, leave days and absent days. A past working day (before today, while
   * the job was held) with no stored day at all counts as one absent day.
   */
  workHours(ctx: RequestContext, q: WorkHoursQuery): Promise<WorkHours> {
    return this.hoursOf(ctx.tenantId, q, this.visibility(ctx));
  }

  /** The work-hours figures for a period, for the callers given (also used by payroll through HrmsFacade). */
  async hoursOf(tenantId: number, q: { company?: string; from: string; to: string }, visibility: Visibility): Promise<WorkHours> {
    const jobs = await this.repo.jobsInRange(tenantId, q.from, q.to, q.company, visibility);
    const totals = new Map((await this.repo.workDayTotals(jobs.map((j) => j.id), q.from, q.to)).map((t) => [t.employmentId, t]));
    const calendar = await this.calendar.daysFor(this.db, jobs.map((j) => j.id), q.from, q.to);
    const today = todayIst();
    const rows: WorkHours['rows'] = [];
    for (const j of jobs) {
      const t = totals.get(j.id);
      const stored = new Set(t?.dates ?? []);
      const unrecorded = (calendar.get(j.id) ?? []).filter((d) => d.kind === 'working' && d.date < today && d.date >= j.joinedOn
        && (!j.exitOn || d.date <= j.exitOn) && !stored.has(d.date)).length;
      rows.push({
        person: { publicId: j.personPublicId, displayName: j.personName },
        employment: { publicId: j.employmentPublicId, company: j.company, employeeCode: j.employeeCode },
        days: { present: t?.present ?? 0, halfDay: t?.halfDay ?? 0, missedPunch: t?.missedPunch ?? 0, absent: (t?.absent ?? 0) + unrecorded, leave: t?.leave ?? 0 },
        leaveDays: t?.leaveDays ?? 0, absentDays: (t?.absentDays ?? 0) + unrecorded,
        workedMinutes: t?.workedMinutes ?? 0, extraMinutes: t?.extraMinutes ?? 0, approvedOvertimeMinutes: t?.approvedOvertimeMinutes ?? 0,
        overtimePayable: await this.core.getPolicy(tenantId, 'hrms.overtime.payable', j.legalEntityId, q.to),
      });
    }
    return { company: q.company ?? null, from: q.from, to: q.to, producedAt: new Date().toISOString(), rows };
  }

  /** Work hours as CSV: one line per job, the same numbers as the screen. */
  workHoursCsv(r: WorkHours): { name: string; body: string } {
    const body = toCsv(
      [['Report', 'Work hours'], ['Company', r.company ?? 'All companies'], ['Period', `${r.from} to ${r.to}`], ['Produced at', r.producedAt]],
      ['Company', 'Employee code', 'Name', 'Present', 'Half day', 'Missed punch', 'Absent', 'Leave', 'Leave days', 'Absent days',
        'Worked minutes', 'Extra minutes', 'Approved overtime minutes', 'Overtime payable'],
      r.rows.map((x) => [x.employment.company, x.employment.employeeCode, x.person.displayName, x.days.present, x.days.halfDay, x.days.missedPunch,
        x.days.absent, x.days.leave, x.leaveDays, x.absentDays, x.workedMinutes, x.extraMinutes, x.approvedOvertimeMinutes, x.overtimePayable ? 'yes' : 'no']));
    return { name: `work-hours-${r.company ?? 'all'}-${r.from}-${r.to}.csv`, body };
  }

  /** Admin: recalculate stored work days for one job (or all of a person's jobs) over a date range. Locked days are skipped. */
  async rebuild(ctx: RequestContext, req: RebuildWorkDaysRequest): Promise<RebuildResult> {
    requireAll(ctx, ATTENDANCE.rebuild);
    const jobs = await this.repo.employmentsFor(ctx.tenantId, req);
    if (jobs.length === 0) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'No job found to rebuild');
    const result: RebuildResult = { rebuilt: 0, skippedLocked: 0 };
    for (const job of jobs) {
      for (const date of datesBetween(req.from, req.to)) {
        const outcome = await this.db.transaction((tx) => this.rebuildDay(tx, ctx.tenantId, job.personId, job.id, date));
        if (outcome === 'rebuilt') result.rebuilt += 1;
        if (outcome === 'locked') result.skippedLocked += 1;
      }
    }
    return result;
  }

  /**
   * POLICY (hrms.attendance.auto_punch_out_hours, 8 for now): when a punch-in arrives while an earlier punch-in is still
   * open and at least that many hours old, a punch-out (source 'auto') is added at punch-in + those hours and its day
   * rebuilt — so a forgotten punch-out never blocks the next morning. A late real punch-out (overtime) is kept as it is.
   */
  private async autoPunchOut(tx: Tx, tenantId: number, personId: number, before: Date): Promise<void> {
    await this.repo.lockPerson(tx, personId);
    const open = await this.repo.latestPunch(tx, personId);
    if (open?.kind !== 'in' || open.at >= before) return;
    const hours = await this.core.getPolicy(tenantId, 'hrms.attendance.auto_punch_out_hours', open.legalEntityId, todayIst(open.at));
    const at = new Date(open.at.getTime() + hours * 3_600_000);
    if (at > before) return; // still inside the hours: the order rule refuses the punch-in
    await this.repo.insertPunch(tx, {
      tenantId, publicId: randomUUID(), personId, employmentId: open.employmentId, legalEntityId: open.legalEntityId, kind: 'out', source: 'auto', occurredAt: at, locationStatus: null,
    });
    for (const date of new Set([todayIst(open.at), todayIst(at)])) await this.rebuildDay(tx, tenantId, personId, open.employmentId, date);
  }

  /** Leave or overtime approved or cancelled: rebuild the job's days from..to inside Leave's transaction (locked days are skipped). */
  async rebuildRange(tx: Tx, tenantId: number, personId: number, employmentId: number, from: string, to: string): Promise<void> {
    for (const date of datesBetween(from, to)) await this.rebuildDay(tx, tenantId, personId, employmentId, date);
  }

  /**
   * Recalculates one job's work day for one IST date from its punches, the calendar and approved leave, and stores it.
   * An open punch-in is stored as missed_punch (the API shows today live instead). A locked day is left alone. A date
   * with no punches and no leave has no row (shown from the calendar instead): an old row is removed.
   */
  private async rebuildDay(tx: Tx, tenantId: number, personId: number, employmentId: number, date: string): Promise<'rebuilt' | 'locked' | 'empty'> {
    const outcome = await this.storeDay(tx, tenantId, personId, employmentId, date);
    if (outcome !== 'locked') for (const l of this.dayListeners) await l(tx, { tenantId, personId, employmentId, date });
    return outcome;
  }

  private async storeDay(tx: Tx, tenantId: number, personId: number, employmentId: number, date: string): Promise<'rebuilt' | 'locked' | 'empty'> {
    const existing = await this.repo.lockWorkDay(tx, employmentId, date);
    if (existing?.locked) return 'locked';
    const punches = await this.repo.punchesOf(tx, [employmentId], istDayStart(date), istDayStart(addDays(date, 1)));
    const leave = (await this.leaveOn(tx, [employmentId], date)).get(employmentId) ?? null;
    if (punches.length === 0 && !leave) {
      if (!existing) return 'empty';
      await this.repo.deleteWorkDay(tx, existing.id);
      return 'rebuilt';
    }
    const legalEntityId = await this.repo.companyOf(tx, employmentId);
    const policy = await this.policy(tenantId, legalEntityId, date);
    const s = summarizeDay(punches, policy, undefined, await this.calendar.dayKind(tx, employmentId, date), leave);
    await this.repo.upsertWorkDay(tx, {
      tenantId, personId, employmentId, legalEntityId, workDate: date, firstIn: s.firstIn, lastOut: s.lastOut,
      workedMinutes: s.workedMinutes, extraMinutes: s.extraMinutes, dayStatus: s.status,
      approvedOvertimeMinutes: approvedOvertime(s.extraMinutes, (await this.repo.approvedOvertimeOn(tx, [employmentId], date)).map((o) => o.minutes)),
      leaveDays: s.leaveDays, absentDays: s.absentDays, workedOnLeave: s.workedOnLeave,
    });
    return 'rebuilt';
  }

  /** A holiday or weekly off changed: rebuild the stored, unlocked days it touches, in the same transaction. */
  private async calendarChanged(tx: Tx, change: CalendarChange): Promise<void> {
    for (const d of await this.repo.storedDays(tx, change)) await this.rebuildDay(tx, d.tenantId, d.personId, d.employmentId, d.date);
  }

  /** Which of these jobs have approved leave on the date, and how much of it. */
  private async leaveOn(conn: Conn, employmentIds: number[], date: string): Promise<Map<number, LeavePart>> {
    const parts = new Map<number, LeavePart>();
    for (const r of await this.repo.approvedLeave(conn, employmentIds, date, date)) parts.set(r.employmentId, leavePartOn(r, date));
    return parts;
  }

  /** The company's day rules on the date (policies; time beyond a full day is extra, overtime only when approved). */
  private async policy(tenantId: number, companyId: number, date: string): Promise<DayPolicy> {
    const fullDayMinutes = await this.core.getPolicy(tenantId, 'hrms.attendance.full_day_minutes', companyId, date);
    return {
      fullDayMinutes,
      halfDayMinutes: await this.core.getPolicy(tenantId, 'hrms.attendance.half_day_minutes', companyId, date),
      maxOpenPunchHours: await this.core.getPolicy(tenantId, 'hrms.attendance.max_open_punch_hours', companyId, date),
    };
  }

  private async resent(ctx: RequestContext, publicId: string): Promise<Punch | undefined> {
    const owner = await this.repo.findPunchOwner(publicId);
    if (!owner) return undefined;
    if (owner.tenantId !== ctx.tenantId || owner.personId !== ctx.personId) throw new AppError('HRMS_DUPLICATE_ID', 409, 'This publicId is already used');
    return this.repo.punch(publicId);
  }

  private visibility(ctx: RequestContext): Visibility {
    const scope = ctx.permissions[ATTENDANCE.view];
    return scope === 'all' ? { scope: 'all' } : { scope: scope === 'team' ? 'team' : 'own', personId: ctx.personId };
  }
}

/** A live (today) summary as a row's fields. */
function shown(s: DaySummary, approvedRequestMinutes: number[]): Omit<WorkDayRow, 'date' | 'employment'> {
  return {
    firstIn: s.firstIn?.toISOString() ?? null, lastOut: s.lastOut?.toISOString() ?? null,
    workedMinutes: s.workedMinutes, extraMinutes: s.extraMinutes, approvedOvertimeMinutes: approvedOvertime(s.extraMinutes, approvedRequestMinutes), status: s.status, locked: false, running: s.running,
    leaveDays: s.leaveDays, absentDays: s.absentDays, workedOnLeave: s.workedOnLeave,
  };
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
