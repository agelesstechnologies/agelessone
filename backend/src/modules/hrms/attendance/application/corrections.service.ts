import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Correction, CreateCorrectionRequest, MyCorrectionsQuery, RejectCorrectionRequest } from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext } from '../../../../platform/http/request-context';
import { addDays, istDayStart, todayIst } from '../../../../platform/time';
import { CoreFacade } from '../../../core/core.facade';
import { AttendanceRepository } from '../infrastructure/attendance.repository';
import { CorrectionsRepository } from '../infrastructure/corrections.repository';
import { CorrectionAction, correctionPunches, CorrectionStatus, stepNotAllowed, timesOnDate } from '../domain/corrections';
import { ATTENDANCE } from '../domain/permissions';
import { AttendanceService } from './attendance.service';
import { MonthLocksService } from './month-locks.service';

/**
 * Use cases live here: open the transaction, call repositories and other facades, write the outbox event.
 * submitted → approved (or rejected / cancelled). Punches are never edited: approval adds punches (source 'correction')
 * and exclusions for the wrong ones, then rebuilds the day. Nobody decides a correction about themselves or filed by them.
 */
@Injectable()
export class CorrectionsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CorrectionsRepository) private readonly repo: CorrectionsRepository,
    @Inject(AttendanceRepository) private readonly punches: AttendanceRepository,
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
    @Inject(MonthLocksService) private readonly months: MonthLocksService,
  ) {}

  /**
   * For your own day, or (as the job's manager) a team member's. Not for a future or locked day. The approver is the
   * job's manager, then the department head, then HR, then the CEO — never the person or whoever filed it. The same publicId again: the stored one.
   */
  async request(ctx: RequestContext, req: CreateCorrectionRequest): Promise<{ correction: Correction; created: boolean }> {
    if (req.publicId) {
      const owner = await this.repo.findOwner(req.publicId);
      if (owner && owner.tenantId === ctx.tenantId && owner.requestedBy === ctx.personId) {
        return { correction: (await this.repo.correction(ctx.tenantId, req.publicId))!, created: false };
      }
      if (owner) throw new AppError('HRMS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const job = await this.punches.findEmployment(ctx.tenantId, req.employmentPublicId);
    if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
    if (job.personId !== ctx.personId && job.managerPersonId !== ctx.personId) {
      throw new AppError('FORBIDDEN', 403, 'You can correct only your own days or those of people you manage');
    }
    if (req.workDate > todayIst()) throw new AppError('HRMS_CORRECTION_FUTURE', 400, 'A day still to come cannot be corrected');
    if (!timesOnDate(req.workDate, [req.requestedIn, req.requestedOut])) {
      throw new AppError('HRMS_CORRECTION_OUTSIDE_DAY', 400, `The times must be on ${req.workDate} (IST)`);
    }
    await this.months.assertOpen(this.db, job.legalEntityId, req.workDate);
    if (await this.punches.isDayLocked(this.db, job.id, req.workDate)) throw new AppError('HRMS_DAY_LOCKED', 409, 'This day is locked for payroll');
    const found = await this.repo.punchesByPublicId(this.db, job.id, istDayStart(req.workDate), istDayStart(addDays(req.workDate, 1)), req.punchIdsToExclude);
    if (found.length !== new Set(req.punchIdsToExclude).size || found.some((p) => p.excludedBy !== null)) {
      throw new AppError('HRMS_CORRECTION_UNKNOWN_PUNCH', 400, 'Punches to leave out must be this job\'s punches on that day, not already left out');
    }

    const approverPersonId = await this.core.approverFor(ctx.tenantId, [job.personId, ctx.personId], { managerId: job.managerPersonId, departmentHeadId: job.departmentHeadId });
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction((tx) => this.repo.insert(tx, {
        tenantId: ctx.tenantId, publicId, personId: job.personId, employmentId: job.id, legalEntityId: job.legalEntityId,
        workDate: req.workDate, kind: req.kind, requestedIn: req.requestedIn ? new Date(req.requestedIn) : null,
        requestedOut: req.requestedOut ? new Date(req.requestedOut) : null, punchIdsToExclude: [...new Set(req.punchIdsToExclude)],
        reason: req.reason, requestedBy: ctx.personId, approverPersonId,
      }));
    } catch (err) {
      const constraint = violatedConstraint(err);
      if (constraint === 'uq_correction_open_per_day') throw new AppError('HRMS_CORRECTION_OPEN', 409, 'This day already has a correction waiting for a decision');
      if (constraint === 'attendance_corrections_public_id_unique') return this.request(ctx, req); // the same request twice at once
      throw err;
    }
    return { correction: (await this.repo.correction(ctx.tenantId, publicId))!, created: true };
  }

  mine(ctx: RequestContext, q: MyCorrectionsQuery): Promise<Correction[]> {
    return this.repo.mine(ctx.personId, q.status);
  }

  toApprove(ctx: RequestContext): Promise<Correction[]> {
    return this.repo.toApprove(ctx.tenantId, ctx.personId, ctx.permissions[ATTENDANCE.approve] === 'all');
  }

  /**
   * In ONE transaction: exclusions for the wrong punches (and for any automatic punch-out of that day, which the
   * correction replaces), the correction's punches, status approved, the day rebuilt.
   */
  async approve(ctx: RequestContext, publicId: string): Promise<Correction> {
    try {
      await this.db.transaction(async (tx) => {
        const c = await this.decidable(tx, ctx, publicId, 'approve');
        await this.months.assertOpen(tx, c.legalEntityId, c.workDate);
        if (await this.punches.isDayLocked(tx, c.employmentId, c.workDate)) throw new AppError('HRMS_DAY_LOCKED', 409, 'This day is locked for payroll');
        const wrong = await this.repo.punchesByPublicId(tx, c.employmentId, istDayStart(c.workDate), istDayStart(addDays(c.workDate, 1)), c.punchIdsToExclude);
        const auto = await this.punches.autoPunches(tx, c.employmentId, istDayStart(c.workDate), istDayStart(addDays(c.workDate, 1)));
        await this.repo.insertExclusions(tx, [
          ...wrong.map((p) => ({ tenantId: ctx.tenantId, punchId: p.id, correctionId: c.id, reason: c.reason })),
          ...auto.filter((a) => !wrong.some((w) => w.id === a.id))
            .map((a) => ({ tenantId: ctx.tenantId, punchId: a.id, correctionId: c.id, reason: 'Automatic punch-out replaced by the approved correction' })),
        ]);
        for (const p of correctionPunches(c)) {
          await this.punches.insertPunch(tx, {
            tenantId: ctx.tenantId, publicId: randomUUID(), personId: c.personId, employmentId: c.employmentId, legalEntityId: c.legalEntityId, kind: p.kind,
            source: 'correction', occurredAt: p.at, locationStatus: null, correctionId: c.id,
          });
        }
        await this.repo.decide(tx, c.id, 'approved', ctx.personId);
        await this.attendance.rebuildRange(tx, ctx.tenantId, c.personId, c.employmentId, c.workDate, c.workDate);
      });
    } catch (err) {
      if (violatedConstraint(err) === 'attendance_exclusions_punch_id_unique') {
        throw new AppError('HRMS_CORRECTION_STALE', 409, 'A punch named here was already left out by another correction');
      }
      throw err;
    }
    return (await this.repo.correction(ctx.tenantId, publicId))!;
  }

  async reject(ctx: RequestContext, publicId: string, req: RejectCorrectionRequest): Promise<Correction> {
    await this.db.transaction(async (tx) => {
      const c = await this.decidable(tx, ctx, publicId, 'reject');
      await this.repo.decide(tx, c.id, 'rejected', ctx.personId, req.reason);
    });
    return (await this.repo.correction(ctx.tenantId, publicId))!;
  }

  /** The person or whoever filed it, while it waits for a decision. */
  async cancel(ctx: RequestContext, publicId: string): Promise<Correction> {
    await this.db.transaction(async (tx) => {
      const c = await this.lock(tx, ctx, publicId);
      if (c.personId !== ctx.personId && c.requestedBy !== ctx.personId) throw new AppError('FORBIDDEN', 403, 'Only the person or whoever filed it can cancel');
      this.checkStep(c.status, 'cancel');
      await this.repo.cancel(tx, c.id, ctx.personId);
    });
    return (await this.repo.correction(ctx.tenantId, publicId))!;
  }

  /** Never about yourself or filed by you; scope team means the correction names you as approver; scope all means anyone's. */
  private async decidable(tx: Tx, ctx: RequestContext, publicId: string, action: CorrectionAction) {
    const c = await this.lock(tx, ctx, publicId);
    if (c.personId === ctx.personId || c.requestedBy === ctx.personId) {
      throw new AppError('HRMS_SELF_APPROVAL', 403, 'Nobody can decide a correction about themselves or filed by them');
    }
    const scope = ctx.permissions[ATTENDANCE.approve];
    if (!(scope === 'all' || (scope === 'team' && c.approverPersonId === ctx.personId))) {
      throw new AppError('FORBIDDEN', 403, 'This correction is not waiting for your decision');
    }
    this.checkStep(c.status, action);
    return c;
  }

  private async lock(tx: Tx, ctx: RequestContext, publicId: string) {
    const c = await this.repo.lock(tx, ctx.tenantId, publicId);
    if (!c) throw new AppError('HRMS_CORRECTION_NOT_FOUND', 404, 'Correction not found');
    return c;
  }

  private checkStep(status: CorrectionStatus, action: CorrectionAction): void {
    const code = stepNotAllowed(status, action);
    if (code) throw new AppError(code, 409, 'This correction has already been decided or cancelled');
  }
}
