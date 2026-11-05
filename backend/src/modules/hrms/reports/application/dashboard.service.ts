import { Inject, Injectable } from '@nestjs/common';
import { Dashboard, DashboardQuery } from '@ageless/shared';
import { DB, Db } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { isManagement, RequestContext } from '../../../../platform/http/request-context';
import { addDays, datesBetween, todayIst } from '../../../../platform/time';
import { CalendarService } from '../../calendar/application/calendar.service';
import { ReportsRepository, Visibility } from '../infrastructure/reports.repository';
import { attendancePercent, emptySplit, monthBounds, previousMonth, Split, splitKey } from '../domain/dashboard';
import { DASHBOARD } from '../domain/permissions';
import { ApprovalsInboxService } from './approvals-inbox.service';

type Job = Awaited<ReturnType<ReportsRepository['jobs']>>[number];
const CURRENT = new Set(['joining', 'active', 'notice']);
const people = (jobs: Job[]) => new Set(jobs.map((j) => j.personId)).size;

/**
 * The HRMS dashboard for one month: team visibility (supervisor: you and the people you manage) or all (HR,
 * Management), over one company or every company the caller may see. Totals are as of now; attendance, leave and the
 * comparison are for the month (up to today). Things not built yet are null, never 0.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ReportsRepository) private readonly repo: ReportsRepository,
    @Inject(CalendarService) private readonly calendar: CalendarService,
    @Inject(ApprovalsInboxService) private readonly inbox: ApprovalsInboxService,
  ) {}

  async dashboard(ctx: RequestContext, q: DashboardQuery): Promise<Dashboard> {
    const scope = isManagement(ctx) ? 'all' : ctx.permissions[DASHBOARD.view];
    if (scope !== 'all' && scope !== 'team') throw new AppError('FORBIDDEN', 403, 'The dashboard is for supervisors, HR and Management');
    const v: Visibility = scope === 'all' ? { scope: 'all' } : { scope: 'team', personId: ctx.personId };
    const now = new Date();
    const today = todayIst(now);
    const month = q.month ?? today.slice(0, 7);

    // the companies the caller may see, then the one asked for (or all of them)
    const all = await this.repo.companies(ctx.tenantId);
    const visibleIds = new Set(scope === 'all' ? all.map((c) => c.id) : await this.repo.teamCompanyIds(ctx.tenantId, ctx.personId));
    const visible = all.filter((c) => visibleIds.has(c.id));
    const counted = q.company === 'all' ? visible : visible.filter((c) => c.code === q.company);
    if (q.company !== 'all' && counted.length === 0) {
      if (all.some((c) => c.code === q.company)) throw new AppError('FORBIDDEN', 403, `${q.company} is outside what you may see`);
      throw new AppError('HRMS_UNKNOWN_COMPANY', 400, `Unknown company ${q.company}`);
    }
    const companyIds = counted.map((c) => c.id);

    const { from, to } = monthBounds(month);
    const current = (await this.repo.jobs(ctx.tenantId, today, '9999-12-31', companyIds, v)).filter((j) => CURRENT.has(j.status));
    const currentIds = current.map((j) => j.id);
    const monthJobs = await this.repo.jobs(ctx.tenantId, from, to, companyIds, v);
    const thisMonth = await this.figures(month, monthJobs, today);
    const lastMonthName = previousMonth(month);
    const last = monthBounds(lastMonthName);
    const lastMonth = await this.figures(lastMonthName, await this.repo.jobs(ctx.tenantId, last.from, last.to, companyIds, v), today);

    const requests = await this.repo.leaveRequests(monthJobs.map((j) => j.id), from, to);
    const byType = new Map<string, { code: string; name: string; requests: number }>();
    for (const r of requests) {
      const t = byType.get(r.code) ?? { code: r.code, name: r.name, requests: 0 };
      t.requests += r.n;
      byType.set(r.code, t);
    }

    const departments = new Map<string, { company: string; code: string | null; name: string; people: Set<number>; split: Split }>();
    for (const j of current) {
      const key = `${j.company}|${j.departmentCode ?? ''}`;
      const d = departments.get(key) ?? { company: j.company, code: j.departmentCode, name: j.departmentName ?? 'No department', people: new Set<number>(), split: emptySplit() };
      d.people.add(j.personId);
      const s = thisMonth.perJob.get(j.id);
      if (s) for (const k of Object.keys(s) as (keyof Split)[]) d.split[k] += s[k];
      departments.set(key, d);
    }

    const activity = await this.repo.recentActivity(ctx.tenantId, v.scope === 'all'
      ? { companyIds, includeNoCompany: q.company === 'all' }
      : { companyIds, includeNoCompany: false, team: { personIds: [...new Set(current.map((j) => j.personId))], me: ctx.personId } });

    return {
      asOf: now.toISOString(),
      month,
      scope: { visibility: scope, company: q.company, companies: counted.map((c) => c.code) },
      totals: {
        employees: people(current),
        active: people(current.filter((j) => j.status === 'active')),
        joinersThisMonth: monthJobs.filter((j) => j.joinedOn >= from && j.joinedOn <= to).length,
        onProbation: people(current.filter((j) => j.engagementType === 'probation')),
        onLeaveToday: await this.repo.onLeave(currentIds, today),
        openPositions: scope === 'all' ? await this.repo.openPositions(companyIds) : null,
        certificatesExpiringIn30Days: await this.repo.certificatesExpiring([...new Set(current.map((j) => j.personId))], today, addDays(today, 30)),
        pendingExpenses: await this.repo.pendingExpenses(currentIds),
        openTickets: null,        // the service tickets module is not built yet
        documentsExpiring: null,  // the documents module is not built yet
      },
      attendance: { from, to: thisMonth.to, split: thisMonth.split, daily: thisMonth.daily },
      leave: {
        submitted: requests.filter((r) => r.status === 'submitted').reduce((n, r) => n + r.n, 0),
        approved: requests.filter((r) => r.status === 'approved').reduce((n, r) => n + r.n, 0),
        leaveDays: thisMonth.leaveDays,
        byType: [...byType.values()],
      },
      departments: [...departments.values()].map((d) => ({
        company: d.company, code: d.code, name: d.name, headcount: d.people.size, attendancePercent: attendancePercent(d.split),
      })),
      myApprovals: await this.inbox.counts(ctx),
      recentActivity: activity.map((a) => ({
        at: a.at.toISOString(), action: a.action, summary: a.summary, company: a.company,
        actor: a.actorPublicId ? { publicId: a.actorPublicId, displayName: a.actorName! } : null,
      })),
      comparison: { thisMonth: thisMonth.figures, lastMonth: lastMonth.figures },
    };
  }

  /**
   * Each job's day from the month's first day up to today: the stored work day, else (a past day) the calendar — a
   * working day with nothing stored is an absence. Today without a stored day is not counted yet.
   */
  private async figures(month: string, jobs: Job[], today: string) {
    const { from, to: monthEnd } = monthBounds(month);
    const to = monthEnd < today ? monthEnd : today;
    const daily = new Map<string, Split>();
    const perJob = new Map<number, Split>();
    const split = emptySplit();
    let leaveDays = 0, absentDays = 0, workedMinutes = 0, approvedOvertimeMinutes = 0;
    if (to >= from && jobs.length > 0) {
      const ids = jobs.map((j) => j.id);
      const stored = new Map((await this.repo.storedDays(ids, from, to)).map((d) => [`${d.employmentId}|${d.date}`, d]));
      const calendar = await this.calendar.daysFor(this.db, ids, from, to);
      for (const date of datesBetween(from, to)) daily.set(date, emptySplit());
      for (const j of jobs) {
        const kinds = new Map((calendar.get(j.id) ?? []).map((d) => [d.date, d.kind]));
        const mine = emptySplit();
        for (const date of datesBetween(from, to)) {
          if (date < j.joinedOn || (j.exitOn && date > j.exitOn)) continue;
          const d = stored.get(`${j.id}|${date}`);
          if (!d && date >= today) continue;
          const key = splitKey(d ? d.status : kinds.get(date) ?? 'working');
          mine[key] += 1;
          daily.get(date)![key] += 1;
          if (d) {
            leaveDays += Number(d.leaveDays); absentDays += Number(d.absentDays);
            workedMinutes += d.workedMinutes; approvedOvertimeMinutes += d.approvedOvertimeMinutes;
          } else if (key === 'absent') absentDays += 1;
        }
        perJob.set(j.id, mine);
        for (const k of Object.keys(mine) as (keyof Split)[]) split[k] += mine[k];
      }
    }
    return {
      to: to >= from ? to : from, split, perJob, leaveDays,
      daily: [...daily.entries()].map(([date, s]) => ({ date, ...s })),
      figures: {
        month, from, to: to >= from ? to : from, employees: people(jobs),
        presentDays: split.present + split.halfDay / 2, absentDays, leaveDays,
        attendancePercent: attendancePercent(split), workedMinutes, approvedOvertimeMinutes,
      },
    };
  }
}
