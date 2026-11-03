import { Inject, Injectable } from '@nestjs/common';
import {
  AttendanceHistoryQuery, AttendanceRegister, AttendanceRegisterQuery, DayStatus, Punch, PunchRequest,
  RebuildResult, RebuildWorkDaysRequest, TodayAttendance, WorkDayRow, WorkHours, WorkHoursQuery,
} from '@ageless/shared';
import { databaseMessage, DB, Db, Tx, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireAll } from '../../../../platform/http/request-context';
import { addDays, datesBetween, istDayStart, todayIst } from '../../../../platform/time';
import { CoreFacade } from '../../../core/core.facade';
import { AttendanceRepository, Visibility } from '../infrastructure/attendance.repository';
import { DayPolicy, summarizeDay } from '../domain/day-summary';
import { ATTENDANCE } from '../domain/permissions';

/** A device clock may run a little fast; anything later than this is refused. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const DEFAULT_DAY_POLICY: DayPolicy = { fullDayMinutes: 480, halfDayMinutes: 240, overtimeAfterMinutes: 480 };

/**
 * Use cases live here: open the transaction, call repositories and other facades, write the outbox event.
 * Punches are stored as they come (append-only); work days are recalculated from them per job and IST date.
 */
@Injectable()
export class AttendanceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AttendanceRepository) private readonly repo: AttendanceRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  health() { return { module: 'hrms', sub: 'attendance', ok: true }; }

  /**
   * Stores a punch on one of the caller's jobs and rebuilds that job's work day in the same transaction.
   * The same publicId again returns the stored punch (created: false). Order is enforced by the database trigger.
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

    try {
      await this.db.transaction(async (tx) => {
        await this.repo.insertPunch(tx, {
          tenantId: ctx.tenantId, publicId: req.publicId, personId: ctx.personId, employmentId: job.id, kind: req.kind, source: 'web',
          occurredAt, latitude: req.latitude?.toString(), longitude: req.longitude?.toString(), accuracyM: req.accuracyM,
          // geofencing needs work locations (not built yet): record whether a position was sent
          locationStatus: req.latitude === undefined ? 'not_taken' : 'not_configured',
        });
        await this.rebuildDay(tx, ctx.tenantId, ctx.personId, job.id, todayIst(occurredAt));
      });
    } catch (err) {
      const message = databaseMessage(err) ?? '';
      if (message.startsWith('HRMS_PUNCH_ORDER')) throw new AppError('HRMS_PUNCH_ORDER', 409, message.replace(/^HRMS_PUNCH_ORDER:\s*/, ''));
      if (violatedConstraint(err) === 'attendance_events_public_id_unique') {
        const again = await this.resent(ctx, req.publicId); // the same punch arrived twice at the same moment
        if (again) return { punch: again, created: false };
      }
      throw err;
    }
    return { punch: (await this.repo.punch(req.publicId))!, created: true };
  }

  /** Am I punched in, since when, and how many minutes today (all jobs, the open punch counted up to now). */
  async today(ctx: RequestContext): Promise<TodayAttendance> {
    const now = new Date();
    const date = todayIst(now);
    const last = await this.repo.lastPunch(ctx.personId);
    const jobs = await this.repo.jobsOfPerson(ctx.personId);
    const punches = await this.repo.punchesOf(this.db, jobs.map((j) => j.id), istDayStart(date), istDayStart(addDays(date, 1)));
    const policy = await this.policy(date);
    const workedMinutes = jobs.reduce((sum, j) => sum + summarizeDay(punches.filter((p) => p.employmentId === j.id), policy, now).workedMinutes, 0);
    const open = last?.kind === 'in';
    return {
      date, punchedIn: open, since: open ? last.occurredAt.toISOString() : null,
      employment: open ? { publicId: last.employmentPublicId, company: last.company } : null, workedMinutes,
    };
  }

  /** My work days per date and company, newest first; today is calculated live (running time while punched in). */
  async history(ctx: RequestContext, q: AttendanceHistoryQuery): Promise<WorkDayRow[]> {
    const stored = await this.repo.workDaysOfPerson(ctx.personId, q.from, q.to);
    const rows: WorkDayRow[] = stored.map((d) => ({
      date: d.date, employment: { publicId: d.employmentPublicId, company: d.company, employeeCode: d.employeeCode },
      firstIn: d.firstIn?.toISOString() ?? null, lastOut: d.lastOut?.toISOString() ?? null,
      workedMinutes: d.workedMinutes, overtimeMinutes: d.overtimeMinutes, status: d.dayStatus as DayStatus, locked: d.locked, running: false,
    }));
    const date = todayIst();
    if (date < q.from || date > q.to) return rows;

    const now = new Date();
    const jobs = await this.repo.jobsOfPerson(ctx.personId);
    const punches = await this.repo.punchesOf(this.db, jobs.map((j) => j.id), istDayStart(date), istDayStart(addDays(date, 1)));
    const policy = await this.policy(date);
    const live: WorkDayRow[] = [];
    for (const job of jobs) {
      const own = punches.filter((p) => p.employmentId === job.id);
      const storedRow = rows.find((r) => r.date === date && r.employment.publicId === job.publicId);
      if (own.length === 0 || storedRow?.locked) continue;
      const s = summarizeDay(own, policy, now);
      live.push({
        date, employment: { publicId: job.publicId, company: job.company, employeeCode: job.employeeCode },
        firstIn: s.firstIn?.toISOString() ?? null, lastOut: s.lastOut?.toISOString() ?? null,
        workedMinutes: s.workedMinutes, overtimeMinutes: s.overtimeMinutes, status: s.status, locked: false, running: s.running,
      });
    }
    const replaced = new Set(live.map((r) => r.employment.publicId));
    return [...live, ...rows.filter((r) => !(r.date === date && replaced.has(r.employment.publicId)))]
      .sort((a, b) => b.date.localeCompare(a.date) || a.employment.company.localeCompare(b.employment.company));
  }

  /** Everyone's day on one date (people with an active job). No row means absent; today is live. */
  async register(ctx: RequestContext, q: AttendanceRegisterQuery): Promise<AttendanceRegister> {
    const rows = await this.repo.register(ctx.tenantId, q.date, q.company, this.visibility(ctx));
    const isToday = q.date === todayIst();
    const now = new Date();
    const punches = isToday ? await this.repo.punchesOf(this.db, rows.map((r) => r.employmentId), istDayStart(q.date), istDayStart(addDays(q.date, 1))) : [];
    const policy = await this.policy(q.date);
    const out = rows.map((r) => {
      const own = punches.filter((p) => p.employmentId === r.employmentId);
      const base = {
        person: { publicId: r.personPublicId, displayName: r.personName },
        employment: { publicId: r.employmentPublicId, company: r.company, employeeCode: r.employeeCode }, locked: r.locked ?? false,
      };
      if (isToday && own.length > 0 && !r.locked) {
        const s = summarizeDay(own, policy, now);
        return { ...base, firstIn: s.firstIn?.toISOString() ?? null, lastOut: s.lastOut?.toISOString() ?? null,
          workedMinutes: s.workedMinutes, overtimeMinutes: s.overtimeMinutes, status: s.status as DayStatus, running: s.running };
      }
      return { ...base, firstIn: r.firstIn?.toISOString() ?? null, lastOut: r.lastOut?.toISOString() ?? null,
        workedMinutes: r.workedMinutes ?? 0, overtimeMinutes: r.overtimeMinutes ?? 0, status: (r.dayStatus ?? 'absent') as DayStatus, running: false };
    });
    const summary: Partial<Record<DayStatus, number>> = {};
    for (const r of out) summary[r.status] = (summary[r.status] ?? 0) + 1;
    return { date: q.date, company: q.company ?? null, rows: out, summary };
  }

  async workHours(ctx: RequestContext, q: WorkHoursQuery): Promise<WorkHours> {
    const rows = await this.repo.workHours(ctx.tenantId, q.from, q.to, q.company, this.visibility(ctx));
    return {
      company: q.company ?? null, from: q.from, to: q.to,
      rows: rows.map((r) => ({
        person: { publicId: r.personPublicId, displayName: r.personName },
        employment: { publicId: r.employmentPublicId, company: r.company, employeeCode: r.employeeCode },
        days: { present: r.present, halfDay: r.halfDay, missedPunch: r.missedPunch, absent: r.absent },
        workedMinutes: r.workedMinutes, overtimeMinutes: r.overtimeMinutes,
      })),
    };
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
   * Recalculates one job's work day for one IST date from its punches and stores it. An open punch-in is stored as
   * missed_punch (the API shows today live instead). A locked day is left alone; a date with no punches and no row is skipped.
   */
  private async rebuildDay(tx: Tx, tenantId: number, personId: number, employmentId: number, date: string): Promise<'rebuilt' | 'locked' | 'empty'> {
    const existing = await this.repo.lockWorkDay(tx, employmentId, date);
    if (existing?.locked) return 'locked';
    const punches = await this.repo.punchesOf(tx, [employmentId], istDayStart(date), istDayStart(addDays(date, 1)));
    if (punches.length === 0 && !existing) return 'empty';
    const s = summarizeDay(punches, await this.policy(date));
    await this.repo.upsertWorkDay(tx, {
      tenantId, personId, employmentId, workDate: date, firstIn: s.firstIn, lastOut: s.lastOut,
      workedMinutes: s.workedMinutes, overtimeMinutes: s.overtimeMinutes, dayStatus: punches.length === 0 ? 'absent' : s.status,
    });
    return 'rebuilt';
  }

  /** Full / half day and overtime thresholds are company policy (not final): read with a default. */
  private policy(date: string): Promise<DayPolicy> {
    return this.core.getPolicy('hrms.attendance.day_rules', {}, date, DEFAULT_DAY_POLICY);
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
