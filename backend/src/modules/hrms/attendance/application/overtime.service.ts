import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CreateOvertimeRequest, ForwardRequest, MyOvertimeQuery, OvertimeRequestView, RejectOvertimeRequest } from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { decidedAs, DecidedAs, RequestContext } from '../../../../platform/http/request-context';
import { todayIst } from '../../../../platform/time';
import { CoreFacade } from '../../../core/core.facade';
import { AttendanceRepository } from '../infrastructure/attendance.repository';
import { OvertimeRepository } from '../infrastructure/overtime.repository';
import { OvertimeAction, OvertimeStatus, stepNotAllowed } from '../domain/overtime';
import { ATTENDANCE } from '../domain/permissions';
import { AttendanceService } from './attendance.service';
import { MonthLocksService } from './month-locks.service';

/**
 * Use cases live here: open the transaction, call repositories and other facades, write the outbox event.
 * Extra time is overtime only when approved: an approved request counts on its day up to the extra minutes worked
 * (a future day gets it when the day is built). Nobody decides a request about themselves or filed by them.
 */
@Injectable()
export class OvertimeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OvertimeRepository) private readonly repo: OvertimeRepository,
    @Inject(AttendanceRepository) private readonly days: AttendanceRepository,
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
    @Inject(MonthLocksService) private readonly months: MonthLocksService,
  ) {}

  /**
   * For your own job, or (as the job's manager) a team member's; a future date is planned overtime. Not for a locked day.
   * The approver is the job's manager, then the department head, then HR, then the CEO — never the person or whoever filed it.
   */
  async request(ctx: RequestContext, req: CreateOvertimeRequest): Promise<{ request: OvertimeRequestView; created: boolean }> {
    if (req.publicId) {
      const owner = await this.repo.findOwner(req.publicId);
      if (owner && owner.tenantId === ctx.tenantId && owner.requestedBy === ctx.personId) {
        return { request: (await this.repo.request(ctx.tenantId, req.publicId))!, created: false };
      }
      if (owner) throw new AppError('HRMS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const job = await this.days.findEmployment(ctx.tenantId, req.employmentPublicId);
    if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
    if (job.personId !== ctx.personId && job.managerPersonId !== ctx.personId) {
      throw new AppError('FORBIDDEN', 403, 'You can ask for overtime only for yourself or people you manage');
    }
    if (job.status !== 'active') throw new AppError('HRMS_EMPLOYMENT_NOT_ACTIVE', 409, 'This job is not active');
    let ticketId: number | null = null;
    if (req.ticketPublicId) {
      const ticket = await this.repo.findTicket(ctx.tenantId, req.ticketPublicId);
      if (!ticket) throw new AppError('HRMS_UNKNOWN_TICKET', 400, 'Ticket not found');
      ticketId = ticket.id;
    }
    await this.months.assertOpen(this.db, job.legalEntityId, req.workDate);
    if (await this.days.isDayLocked(this.db, job.id, req.workDate)) throw new AppError('HRMS_DAY_LOCKED', 409, 'This day is locked for payroll');

    // POLICY hrms.approvals.auto_approve_roles (default: ceo): their own overtime is approved on submit, with no decider
    const noApproval = job.personId === ctx.personId && await this.core.needsNoApproval(ctx.tenantId, ctx.personId, job.legalEntityId, todayIst());
    const approverPersonId = noApproval ? null
      : await this.core.approverFor(ctx.tenantId, [job.personId, ctx.personId], { managerId: job.managerPersonId, departmentHeadId: job.departmentHeadId });
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.insert(tx, {
          tenantId: ctx.tenantId, publicId, personId: job.personId, employmentId: job.id, legalEntityId: job.legalEntityId,
          workDate: req.workDate, minutes: req.minutes, reason: req.reason, ticketId, requestedBy: ctx.personId, approverPersonId,
        });
        if (noApproval) await this.applyApproval(tx, ctx.tenantId, (await this.repo.lock(tx, ctx.tenantId, publicId))!, null, 'no_approval_required');
      });
    } catch (err) {
      if (violatedConstraint(err) === 'overtime_requests_public_id_unique') return this.request(ctx, req); // the same request twice at once
      throw err;
    }
    return { request: (await this.repo.request(ctx.tenantId, publicId))!, created: true };
  }

  mine(ctx: RequestContext, q: MyOvertimeQuery): Promise<OvertimeRequestView[]> {
    return this.repo.mine(ctx.personId, q.status);
  }

  toApprove(ctx: RequestContext): Promise<OvertimeRequestView[]> {
    return this.repo.toApprove(ctx.tenantId, ctx.personId, ctx.permissions[ATTENDANCE.approve] === 'all');
  }

  /** Approved and the day rebuilt in one transaction (a future day has nothing to rebuild yet). Locked days refused. */
  async approve(ctx: RequestContext, publicId: string): Promise<OvertimeRequestView> {
    await this.db.transaction(async (tx) => {
      const r = await this.decidable(tx, ctx, publicId, 'approve');
      await this.applyApproval(tx, ctx.tenantId, r, ctx.personId, decidedAs(ctx, r.approverPersonId === ctx.personId));
    });
    return (await this.repo.request(ctx.tenantId, publicId))!;
  }

  async reject(ctx: RequestContext, publicId: string, req: RejectOvertimeRequest): Promise<OvertimeRequestView> {
    await this.db.transaction(async (tx) => {
      const r = await this.decidable(tx, ctx, publicId, 'reject');
      const as = decidedAs(ctx, r.approverPersonId === ctx.personId);
      await this.repo.decide(tx, r.id, 'rejected', ctx.personId, as, req.reason);
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'overtime.rejected', entity: 'overtime_request',
        entityPublicId: r.publicId, subjectPersonId: r.personId, legalEntityId: r.legalEntityId,
        summary: `Overtime of ${r.minutes} min for ${r.personName} on ${r.workDate} rejected (${as})` });
    });
    return (await this.repo.request(ctx.tenantId, publicId))!;
  }

  /**
   * Send to the CEO: whoever may decide it now, while it still waits for a decision; never about or filed by you. It
   * stays decidable by the approver too (the first decision wins). Sent twice: stored once, the same answer.
   */
  async forward(ctx: RequestContext, publicId: string, req: ForwardRequest): Promise<OvertimeRequestView> {
    await this.db.transaction(async (tx) => {
      const r = await this.decidable(tx, ctx, publicId, 'approve');
      if (r.escalatedAt) return;
      await this.repo.escalate(tx, r.id, ctx.personId, req.reason);
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'overtime.forwarded', entity: 'overtime_request',
        entityPublicId: r.publicId, subjectPersonId: r.personId, legalEntityId: r.legalEntityId,
        summary: `Overtime of ${r.minutes} min for ${r.personName} on ${r.workDate} forwarded to the CEO` });
    });
    return (await this.repo.request(ctx.tenantId, publicId))!;
  }

  /** For the daily job: overtime waiting since before the instant, not yet sent to the CEO; send one automatically. */
  waiting(createdBefore: Date) { return this.repo.waiting(createdBefore); }
  escalateAutomatically(id: number, reason: string) { return this.repo.escalate(this.db, id, null, reason); }

  /** The person or whoever filed it. An approved request too (its day is rebuilt), unless the day is locked. */
  async cancel(ctx: RequestContext, publicId: string): Promise<OvertimeRequestView> {
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx, publicId);
      if (r.personId !== ctx.personId && r.requestedBy !== ctx.personId) throw new AppError('FORBIDDEN', 403, 'Only the person or whoever filed it can cancel');
      this.checkStep(r.status, 'cancel');
      if (r.status === 'approved') await this.months.assertOpen(tx, r.legalEntityId, r.workDate);
      if (r.status === 'approved' && await this.days.isDayLocked(tx, r.employmentId, r.workDate)) {
        throw new AppError('HRMS_DAY_LOCKED', 409, 'This day is locked for payroll');
      }
      await this.repo.cancel(tx, r.id, ctx.personId);
      if (r.status === 'approved') await this.attendance.rebuildRange(tx, ctx.tenantId, r.personId, r.employmentId, r.workDate, r.workDate);
    });
    return (await this.repo.request(ctx.tenantId, publicId))!;
  }

  /** Approved with decided_by / decided_as and the day rebuilt (a future day has nothing to rebuild yet); an audit entry. */
  private async applyApproval(tx: Tx, tenantId: number, r: NonNullable<Awaited<ReturnType<OvertimeRepository['lock']>>>,
    deciderId: number | null, as: DecidedAs): Promise<void> {
    await this.months.assertOpen(tx, r.legalEntityId, r.workDate);
    if (await this.days.isDayLocked(tx, r.employmentId, r.workDate)) throw new AppError('HRMS_DAY_LOCKED', 409, 'This day is locked for payroll');
    await this.repo.decide(tx, r.id, 'approved', deciderId, as);
    await this.attendance.rebuildRange(tx, tenantId, r.personId, r.employmentId, r.workDate, r.workDate);
    await this.core.audit(tx, { tenantId, actorPersonId: deciderId ?? r.requestedBy,
      action: as === 'no_approval_required' ? 'overtime.auto_approved' : 'overtime.approved', entity: 'overtime_request',
      entityPublicId: r.publicId, subjectPersonId: r.personId, legalEntityId: r.legalEntityId,
      summary: as === 'no_approval_required'
        ? `Overtime of ${r.minutes} min for ${r.personName} on ${r.workDate} approved on submit: no approval required`
        : `Overtime of ${r.minutes} min for ${r.personName} on ${r.workDate} approved (${as})`,
      details: { decidedAs: as, minutes: r.minutes } });
  }

  /** Never about yourself or filed by you; scope team means the request names you as approver; scope all means anyone's. */
  private async decidable(tx: Tx, ctx: RequestContext, publicId: string, action: OvertimeAction) {
    const r = await this.lock(tx, ctx, publicId);
    if (r.personId === ctx.personId || r.requestedBy === ctx.personId) {
      throw new AppError('HRMS_SELF_APPROVAL', 403, 'Nobody can decide overtime about themselves or filed by them');
    }
    const scope = ctx.permissions[ATTENDANCE.approve];
    if (!(scope === 'all' || (scope === 'team' && r.approverPersonId === ctx.personId))) {
      throw new AppError('FORBIDDEN', 403, 'This request is not waiting for your decision');
    }
    this.checkStep(r.status, action);
    return r;
  }

  private async lock(tx: Tx, ctx: RequestContext, publicId: string) {
    const r = await this.repo.lock(tx, ctx.tenantId, publicId);
    if (!r) throw new AppError('HRMS_OVERTIME_NOT_FOUND', 404, 'Overtime request not found');
    return r;
  }

  private checkStep(status: OvertimeStatus, action: OvertimeAction): void {
    const code = stepNotAllowed(status, action);
    if (!code) return;
    throw new AppError(code, 409, code === 'HRMS_OVERTIME_NOT_PENDING' ? 'This request has already been decided' : 'This request is already rejected or cancelled');
  }
}
