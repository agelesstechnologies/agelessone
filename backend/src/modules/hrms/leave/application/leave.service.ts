import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ApplyLeaveRequest, CancelLeaveRequest, LeaveAdjustmentRequest, LeaveBalance, LeaveLedgerEntry, LeaveReport, LeaveReportQuery,
  LeaveRequestView, LeaveType, MyLeaveQuery, RejectLeaveRequest,
} from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { decidedAs, DecidedAs, RequestContext, requireAll } from '../../../../platform/http/request-context';
import { todayIst } from '../../../../platform/time';
import { CoreFacade } from '../../../core/core.facade';
import { AttendanceService } from '../../attendance/application/attendance.service';
import { MonthLocksService } from '../../attendance/application/month-locks.service';
import { CalendarService } from '../../calendar/application/calendar.service';
import { LeaveRepository, Visibility } from '../infrastructure/leave.repository';
import { calculateLeaveDays, FromHalf, ToHalf } from '../leave-days';
import { balanceAllows, daysPerYear, fitToTotal, LeaveAction, LeaveStatus, stepNotAllowed } from '../domain/requests';
import { LEAVE } from '../domain/permissions';
import { toCsv } from '../../../../platform/csv';

/**
 * Use cases live here: open the transaction, call repositories and other facades, write the outbox event.
 * submitted → approved (or rejected); submitted or approved → cancelled. Nobody decides their own request.
 * Approval takes the days from the ledger and marks the work days as leave; cancelling an approved leave gives them back.
 */
@Injectable()
export class LeaveService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LeaveRepository) private readonly repo: LeaveRepository,
    @Inject(CalendarService) private readonly calendar: CalendarService,
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
    @Inject(MonthLocksService) private readonly months: MonthLocksService,
  ) {}

  health() { return { module: 'hrms', sub: 'leave', ok: true }; }

  types(ctx: RequestContext): Promise<LeaveType[]> {
    return this.repo.types(ctx.tenantId);
  }

  /** Working days of leave on one job: its holidays and weekly offs (from the work calendar) are not counted. */
  async countDays(tenantId: number, employmentPublicId: string, from: string, to: string, fromHalf: FromHalf, toHalf: ToHalf): Promise<number> {
    if (to < from) throw new AppError('VALIDATION', 400, 'Leave ends before it starts');
    const days = await this.calendar.daysOfJob(tenantId, employmentPublicId, from, to);
    if (!days) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
    return calculateLeaveDays(from, to, fromHalf, toHalf, days.filter((d) => d.kind !== 'working').map((d) => d.date));
  }

  /**
   * Leave on one of the caller's own active jobs. Days are counted now (holidays and weekly offs skipped) and saved.
   * The approver: the job's manager, else its department head, else HR, else the CEO (never the applicant). The same publicId again returns the stored request.
   */
  async apply(ctx: RequestContext, req: ApplyLeaveRequest): Promise<{ request: LeaveRequestView; created: boolean }> {
    if (req.publicId) {
      const owner = await this.repo.findRequestOwner(req.publicId);
      if (owner && owner.tenantId === ctx.tenantId && owner.personId === ctx.personId) {
        return { request: (await this.repo.request(ctx.tenantId, req.publicId))!, created: false };
      }
      if (owner) throw new AppError('HRMS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const job = await this.repo.findEmployment(ctx.tenantId, req.employmentPublicId);
    if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
    if (job.personId !== ctx.personId) throw new AppError('HRMS_NOT_YOUR_EMPLOYMENT', 403, 'You can only apply for leave on your own job');
    if (job.status !== 'active') throw new AppError('HRMS_EMPLOYMENT_NOT_ACTIVE', 409, 'This job is not active');
    const type = await this.repo.findType(ctx.tenantId, req.leaveTypeCode);
    if (!type) throw new AppError('HRMS_UNKNOWN_LEAVE_TYPE', 400, `Unknown leave type ${req.leaveTypeCode}`);

    await this.months.assertOpen(this.db, job.legalEntityId, req.fromDate, req.toDate);
    const days = (await this.parts(this.db, job.id, req)).reduce((sum, p) => sum + p.days, 0);
    if (days <= 0) throw new AppError('HRMS_LEAVE_NO_WORKING_DAYS', 400, 'These dates are all holidays or weekly offs');
    await this.checkBalance(this.db, ctx.tenantId, job.legalEntityId, job.id, type.id, days, req.fromDate);
    // POLICY hrms.approvals.auto_approve_roles (default: ceo): their own leave is approved on submit, with no decider
    const noApproval = await this.core.needsNoApproval(ctx.tenantId, ctx.personId, job.legalEntityId, todayIst());
    const approverPersonId = noApproval ? null
      : await this.core.approverFor(ctx.tenantId, [ctx.personId], { managerId: job.managerPersonId, departmentHeadId: job.departmentHeadId });

    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.insertRequest(tx, {
          tenantId: ctx.tenantId, publicId, personId: ctx.personId, employmentId: job.id, legalEntityId: job.legalEntityId,
          leaveTypeId: type.id, fromDate: req.fromDate, toDate: req.toDate, fromHalf: req.fromHalf, toHalf: req.toHalf,
          days, reason: req.reason, approverPersonId,
        });
        if (noApproval) await this.applyApproval(tx, ctx.tenantId, (await this.repo.lockRequest(tx, ctx.tenantId, publicId))!, null, 'no_approval_required');
      });
    } catch (err) {
      if (violatedConstraint(err, '23P01') === 'leave_requests_no_overlap') {
        throw new AppError('HRMS_LEAVE_OVERLAP', 409, 'You already have leave on this job for some of these dates');
      }
      if (violatedConstraint(err) === 'leave_requests_public_id_unique') return this.apply(ctx, req); // the same request arrived twice at once
      throw err;
    }
    return { request: (await this.repo.request(ctx.tenantId, publicId))!, created: true };
  }

  mine(ctx: RequestContext, q: MyLeaveQuery): Promise<LeaveRequestView[]> {
    return this.repo.mine(ctx.personId, q.status);
  }

  toApprove(ctx: RequestContext): Promise<LeaveRequestView[]> {
    return this.repo.toApprove(ctx.tenantId, ctx.personId, ctx.permissions[LEAVE.approve] === 'all');
  }

  /**
   * The named approver, HR, or Management (recorded as decided_as). In one transaction: 'taken' ledger rows (negative,
   * per year), status approved, the work days rebuilt as leave, an audit entry.
   */
  async approve(ctx: RequestContext, publicId: string): Promise<LeaveRequestView> {
    await this.db.transaction(async (tx) => {
      const r = await this.decidable(tx, ctx, publicId, 'approve');
      await this.applyApproval(tx, ctx.tenantId, r, ctx.personId, decidedAs(ctx, r.approverPersonId === ctx.personId));
    });
    return (await this.repo.request(ctx.tenantId, publicId))!;
  }

  async reject(ctx: RequestContext, publicId: string, req: RejectLeaveRequest): Promise<LeaveRequestView> {
    await this.db.transaction(async (tx) => {
      const r = await this.decidable(tx, ctx, publicId, 'reject');
      const as = decidedAs(ctx, r.approverPersonId === ctx.personId);
      await this.repo.decide(tx, r.id, 'rejected', ctx.personId, as, req.reason);
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'leave.rejected', entity: 'leave_request',
        entityPublicId: r.publicId, subjectPersonId: r.personId, legalEntityId: r.legalEntityId,
        summary: `Leave of ${r.personName} ${r.fromDate} to ${r.toDate} rejected (${as})` });
    });
    return (await this.repo.request(ctx.tenantId, publicId))!;
  }

  /**
   * The effects of an approval, whoever (or nothing) approved it: the balance check, 'taken' ledger rows, status
   * approved with decided_by / decided_as, the work days rebuilt as leave, and an audit entry.
   */
  private async applyApproval(tx: Tx, tenantId: number, r: NonNullable<Awaited<ReturnType<LeaveRepository['lockRequest']>>>,
    deciderId: number | null, as: DecidedAs): Promise<void> {
    await this.months.assertOpen(tx, r.legalEntityId, r.fromDate, r.toDate);
    await this.checkBalance(tx, tenantId, r.legalEntityId, r.employmentId, r.leaveTypeId, r.days, r.fromDate);
    const parts = fitToTotal(await this.parts(tx, r.employmentId, r), r.days);
    await this.repo.insertLedger(tx, parts.map((p) => ({
      tenantId, employmentId: r.employmentId, legalEntityId: r.legalEntityId, leaveTypeId: r.leaveTypeId, year: p.year, entry: 'taken', days: -p.days,
      leaveRequestId: r.id, postedBy: deciderId ?? r.personId,
    })));
    await this.repo.decide(tx, r.id, 'approved', deciderId, as);
    await this.attendance.rebuildRange(tx, tenantId, r.personId, r.employmentId, r.fromDate, r.toDate);
    await this.core.audit(tx, { tenantId, actorPersonId: deciderId ?? r.personId, action: as === 'no_approval_required' ? 'leave.auto_approved' : 'leave.approved',
      entity: 'leave_request', entityPublicId: r.publicId, subjectPersonId: r.personId, legalEntityId: r.legalEntityId,
      summary: as === 'no_approval_required'
        ? `Leave of ${r.personName} ${r.fromDate} to ${r.toDate} (${r.days} days) approved on submit: no approval required`
        : `Leave of ${r.personName} ${r.fromDate} to ${r.toDate} (${r.days} days) approved (${as})`,
      details: { decidedAs: as, days: r.days } });
  }

  /**
   * The person (or HR) cancels. A request not yet decided is just cancelled. An approved one only while it has not
   * started (it starts today or later): the taken days are given back ('taken_reversal') and the work days rebuilt.
   */
  async cancel(ctx: RequestContext, publicId: string, req: CancelLeaveRequest): Promise<LeaveRequestView> {
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx, publicId);
      if (r.personId !== ctx.personId && ctx.permissions[LEAVE.manage] !== 'all') {
        throw new AppError('FORBIDDEN', 403, 'Only the person or HR can cancel this leave');
      }
      this.checkStep(r.status, 'cancel');
      if (r.status === 'approved') {
        await this.months.assertOpen(tx, r.legalEntityId, r.fromDate, r.toDate);
        if (r.fromDate < todayIst()) throw new AppError('HRMS_LEAVE_STARTED', 409, 'This leave has already started and cannot be cancelled');
        const taken = await this.repo.takenRows(tx, r.id);
        await this.repo.insertLedger(tx, taken.map((t) => ({
          tenantId: ctx.tenantId, employmentId: r.employmentId, legalEntityId: r.legalEntityId, leaveTypeId: r.leaveTypeId, year: t.year, entry: 'taken_reversal', days: -t.days,
          leaveRequestId: r.id, reason: req.reason ?? 'Approved leave cancelled', postedBy: ctx.personId,
        })));
      }
      await this.repo.cancel(tx, r.id, ctx.personId);
      if (r.status === 'approved') await this.attendance.rebuildRange(tx, ctx.tenantId, r.personId, r.employmentId, r.fromDate, r.toDate);
    });
    return (await this.repo.request(ctx.tenantId, publicId))!;
  }

  async balancesMine(ctx: RequestContext): Promise<LeaveBalance[]> {
    const rows = await this.repo.balancesOfPerson(ctx.tenantId, ctx.personId);
    return rows.map((r) => ({
      employment: { publicId: r.employmentPublicId, company: r.company }, leaveType: { code: r.code, name: r.name }, balance: r.balance,
    }));
  }

  /** HR posts an opening balance (one per job, type and year) or an adjustment. Never on their own balance. */
  async adjust(ctx: RequestContext, req: LeaveAdjustmentRequest): Promise<{ entry: LeaveLedgerEntry; created: boolean }> {
    requireAll(ctx, LEAVE.manage);
    if (req.publicId) {
      const tenant = await this.repo.findLedgerTenant(req.publicId);
      if (tenant === ctx.tenantId) return { entry: (await this.repo.ledgerEntry(req.publicId))!, created: false };
      if (tenant !== undefined) throw new AppError('HRMS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const job = await this.repo.findEmployment(ctx.tenantId, req.employmentPublicId);
    if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
    if (job.personId === ctx.personId) throw new AppError('HRMS_SELF_APPROVAL', 403, 'Nobody can change their own leave balance');
    const type = await this.repo.findType(ctx.tenantId, req.leaveTypeCode);
    if (!type) throw new AppError('HRMS_UNKNOWN_LEAVE_TYPE', 400, `Unknown leave type ${req.leaveTypeCode}`);
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction((tx) => this.repo.insertLedger(tx, [{
        tenantId: ctx.tenantId, publicId, employmentId: job.id, legalEntityId: job.legalEntityId, leaveTypeId: type.id, year: req.year, entry: req.entry, days: req.days,
        reason: req.reason, postedBy: ctx.personId,
      }]));
    } catch (err) {
      const constraint = violatedConstraint(err);
      if (constraint === 'uq_leave_ledger_one_opening') throw new AppError('HRMS_OPENING_EXISTS', 409, `This job already has an opening balance for ${req.year}`);
      if (constraint === 'leave_ledger_public_id_unique') return this.adjust(ctx, req);
      throw err;
    }
    return { entry: (await this.repo.ledgerEntry(publicId))!, created: true };
  }

  /**
   * For a period: submitted and approved requests touching it, and per person and job the approved days inside the
   * period by leave type (a request crossing the period counts only its days inside) and the current balance by type.
   * HR sees everyone, a Supervisor themselves and their team.
   */
  async report(ctx: RequestContext, q: LeaveReportQuery): Promise<LeaveReport> {
    const scope = ctx.permissions[LEAVE.report];
    const visibility: Visibility = scope === 'all' ? { scope: 'all' } : { scope: scope === 'team' ? 'team' : 'own', personId: ctx.personId };
    const rows = await this.repo.report(ctx.tenantId, q.from, q.to, q.company, visibility);
    const byType = new Map<string, number>();
    for (const r of rows.filter((x) => x.status === 'approved')) byType.set(r.leaveType.code, (byType.get(r.leaveType.code) ?? 0) + r.days);

    const jobs = await this.repo.jobsInRange(ctx.tenantId, q.from, q.to, q.company, visibility);
    const approved = await this.repo.approvedInRange(jobs.map((j) => j.id), q.from, q.to);
    const balances = await this.repo.balancesOf(jobs.map((j) => j.id));
    const people: LeaveReport['people'] = [];
    for (const j of jobs) {
      const takenByType = await this.takenInPeriod(j.id, approved.filter((a) => a.employmentId === j.id), q.from, q.to);
      const balanceByType = Object.fromEntries(balances.filter((b) => b.employmentId === j.id).map((b) => [b.typeCode, b.balance]));
      people.push({
        person: { publicId: j.personPublicId, displayName: j.personName },
        employment: { publicId: j.employmentPublicId, company: j.company, employeeCode: j.employeeCode },
        takenByType, balanceByType, totalTaken: Object.values(takenByType).reduce((s, d) => s + d, 0),
      });
    }
    return {
      company: q.company ?? null, from: q.from, to: q.to, producedAt: new Date().toISOString(), rows,
      approvedDaysByType: [...byType].map(([code, days]) => ({ code, days })), people,
    };
  }

  /**
   * For payroll (through HrmsFacade): days of approved leave of unpaid types inside from..to, per job of the company
   * (by employment public id). They count as absence for loss of pay.
   */
  async unpaidDaysIn(tenantId: number, company: string, from: string, to: string): Promise<Map<string, number>> {
    const unpaid = new Set((await this.repo.types(tenantId)).filter((t) => !t.isPaid).map((t) => t.code));
    const jobs = await this.repo.jobsInRange(tenantId, from, to, company, { scope: 'all' });
    const approved = (await this.repo.approvedInRange(jobs.map((j) => j.id), from, to)).filter((a) => unpaid.has(a.typeCode));
    const out = new Map<string, number>();
    for (const j of jobs) {
      const taken = await this.takenInPeriod(j.id, approved.filter((a) => a.employmentId === j.id), from, to);
      const days = Object.values(taken).reduce((s, d) => s + d, 0);
      if (days > 0) out.set(j.employmentPublicId, days);
    }
    return out;
  }

  /** Approved leave days of one job inside from..to by leave type (a request crossing the period counts only its days inside). */
  private async takenInPeriod(employmentId: number, approved: { typeCode: string; fromDate: string; toDate: string; fromHalf: string; toHalf: string }[],
    from: string, to: string): Promise<Record<string, number>> {
    const taken: Record<string, number> = {};
    for (const r of approved) {
      const start = r.fromDate < from ? from : r.fromDate;
      const end = r.toDate > to ? to : r.toDate;
      const inside = await this.parts(this.db, employmentId, {
        fromDate: start, toDate: end, fromHalf: start === r.fromDate ? r.fromHalf : 'full', toHalf: end === r.toDate ? r.toHalf : 'full',
      });
      taken[r.typeCode] = (taken[r.typeCode] ?? 0) + inside.reduce((s, p) => s + p.days, 0);
    }
    return taken;
  }

  /** The leave report as CSV: one line per person, job and leave type (days taken in the period and current balance). */
  async reportCsv(ctx: RequestContext, r: LeaveReport): Promise<{ name: string; body: string }> {
    const types = (await this.repo.types(ctx.tenantId)).map((t) => t.code);
    const body = toCsv(
      [['Report', 'Leave'], ['Company', r.company ?? 'All companies'], ['Period', `${r.from} to ${r.to}`], ['Produced at', r.producedAt]],
      ['Company', 'Employee code', 'Name', 'Leave type', 'Days taken in period', 'Current balance'],
      r.people.flatMap((p) => types.map((t) => [p.employment.company, p.employment.employeeCode, p.person.displayName, t,
        p.takenByType[t] ?? 0, p.balanceByType[t] ?? 0])));
    return { name: `leave-${r.company ?? 'all'}-${r.from}-${r.to}.csv`, body };
  }

  /** The leave's working days per year, from the job's calendar (holidays and weekly offs skipped). */
  private async parts(conn: Conn, employmentId: number, r: { fromDate: string; toDate: string; fromHalf: string; toHalf: string }) {
    const days = (await this.calendar.daysFor(conn, [employmentId], r.fromDate, r.toDate)).get(employmentId) ?? [];
    const off = days.filter((d) => d.kind !== 'working').map((d) => d.date);
    return daysPerYear(r.fromDate, r.toDate, r.fromHalf as FromHalf, r.toHalf as ToHalf, off);
  }

  /** The company's hrms.leave.balance_check policy (off by default): leave may not take the balance below zero. */
  private async checkBalance(conn: Conn, tenantId: number, companyId: number, employmentId: number, leaveTypeId: number, days: number, onDate: string): Promise<void> {
    if (!(await this.core.getPolicy(tenantId, 'hrms.leave.balance_check', companyId, onDate))) return;
    if (!balanceAllows(await this.repo.balance(conn, employmentId, leaveTypeId), days, true)) {
      throw new AppError('HRMS_LEAVE_BALANCE', 409, 'Not enough leave balance');
    }
  }

  /**
   * Approve / reject: never your own request; scope team means the request names you as approver; scope all means
   * anyone's (this is also how a request with no approver — a job with no manager — gets decided).
   */
  private async decidable(tx: Tx, ctx: RequestContext, publicId: string, action: LeaveAction) {
    const r = await this.lock(tx, ctx, publicId);
    if (r.personId === ctx.personId) throw new AppError('HRMS_SELF_APPROVAL', 403, 'Nobody can approve or reject their own leave');
    const scope = ctx.permissions[LEAVE.approve];
    const allowed = scope === 'all' || (scope === 'team' && r.approverPersonId === ctx.personId);
    if (!allowed) throw new AppError('FORBIDDEN', 403, 'This leave is not waiting for your decision');
    this.checkStep(r.status, action);
    return r;
  }

  private async lock(tx: Tx, ctx: RequestContext, publicId: string) {
    const r = await this.repo.lockRequest(tx, ctx.tenantId, publicId);
    if (!r) throw new AppError('HRMS_LEAVE_NOT_FOUND', 404, 'Leave request not found');
    return r;
  }

  private checkStep(status: LeaveStatus, action: LeaveAction): void {
    const code = stepNotAllowed(status, action);
    if (!code) return;
    const message = { HRMS_LEAVE_NOT_PENDING: 'This leave has already been decided', HRMS_LEAVE_CLOSED: 'This leave is already rejected or cancelled' }[code];
    throw new AppError(code, 409, message);
  }
}
