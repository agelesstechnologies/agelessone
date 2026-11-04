import { Inject, Injectable } from '@nestjs/common';
import { LockMonthRequest, MonthLock, MonthLocksQuery, UnlockMonthRequest } from '@ageless/shared';
import { Conn, DB, Db, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireAll } from '../../../../platform/http/request-context';
import { todayIst } from '../../../../platform/time';
import { MonthLocksRepository } from '../infrastructure/month-locks.repository';
import { monthEnded, monthRange, monthsBetween } from '../domain/months';
import { ATTENDANCE } from '../domain/permissions';

/**
 * Use cases live here. HR locks a company's month once it has ended: its work days are locked and nothing may change
 * that month any more (punches, corrections, leave, overtime). A System Admin may unlock it, with a reason that is kept.
 */
@Injectable()
export class MonthLocksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MonthLocksRepository) private readonly repo: MonthLocksRepository,
  ) {}

  /** Refuses (HRMS_MONTH_LOCKED) when any month between from and to is locked for the company. */
  async assertOpen(conn: Conn, legalEntityId: number, from: string, to: string = from): Promise<void> {
    const locked = await this.repo.lockedAmong(conn, legalEntityId, monthsBetween(from, to));
    if (locked.length) {
      const m = locked[0];
      throw new AppError('HRMS_MONTH_LOCKED', 409, `${m.year}-${String(m.month).padStart(2, '0')} is locked for payroll`);
    }
  }

  list(ctx: RequestContext, q: MonthLocksQuery): Promise<MonthLock[]> {
    if (ctx.permissions[ATTENDANCE.lockMonth] !== 'all' && ctx.permissions[ATTENDANCE.unlockMonth] !== 'all') {
      throw new AppError('FORBIDDEN', 403, 'Only HR and System Admin see month locks');
    }
    return this.repo.list(ctx.tenantId, q.company, q.year);
  }

  /** HR: lock an ended month; its stored work days are locked in the same transaction. */
  async lock(ctx: RequestContext, req: LockMonthRequest): Promise<MonthLock> {
    requireAll(ctx, ATTENDANCE.lockMonth);
    const company = await this.repo.findCompany(ctx.tenantId, req.company);
    if (!company) throw new AppError('HRMS_UNKNOWN_COMPANY', 400, `Unknown company ${req.company}`);
    if (!monthEnded(req, todayIst())) throw new AppError('HRMS_MONTH_NOT_ENDED', 400, 'A month can be locked once it has ended');
    const { from, to } = monthRange(req);
    try {
      const publicId = await this.db.transaction(async (tx) => {
        const id = await this.repo.insert(tx, { tenantId: ctx.tenantId, legalEntityId: company.id, year: req.year, month: req.month, lockedBy: ctx.personId });
        await this.repo.setDaysLocked(tx, company.id, from, to, true);
        return id;
      });
      return (await this.repo.list(ctx.tenantId, undefined, undefined, [publicId]))[0];
    } catch (err) {
      if (violatedConstraint(err) === 'uq_month_lock_open') throw new AppError('HRMS_MONTH_ALREADY_LOCKED', 409, 'This month is already locked');
      throw err;
    }
  }

  /** System Admin: unlock with a reason (who, when and why are kept); the month's work days are unlocked. */
  async unlock(ctx: RequestContext, publicId: string, req: UnlockMonthRequest): Promise<MonthLock> {
    requireAll(ctx, ATTENDANCE.unlockMonth);
    await this.db.transaction(async (tx) => {
      const lock = await this.repo.lockFor(tx, ctx.tenantId, publicId);
      if (!lock) throw new AppError('HRMS_MONTH_LOCK_NOT_FOUND', 404, 'Month lock not found');
      if (lock.unlockedAt) throw new AppError('HRMS_MONTH_NOT_LOCKED', 409, 'This lock has already been undone');
      await this.repo.unlock(tx, lock.id, ctx.personId, req.reason);
      const { from, to } = monthRange(lock);
      await this.repo.setDaysLocked(tx, lock.legalEntityId, from, to, false);
    });
    return (await this.repo.list(ctx.tenantId, undefined, undefined, [publicId]))[0];
  }
}
