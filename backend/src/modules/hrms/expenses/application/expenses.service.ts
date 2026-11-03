import { Inject, Injectable } from '@nestjs/common';
import {
  ApproveExpenseRequest, CreateExpenseRequest, ExpenseCategory, ExpenseClaim, ExpenseClaimList, ExpenseReport,
  ExpenseReportQuery, MarkExpensePaidRequest, MyExpensesQuery, RejectExpenseRequest,
} from '@ageless/shared';
import { DB, Db, Tx } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireAll } from '../../../../platform/http/request-context';
import { discardUpload, saveUpload } from '../../../../platform/storage';
import { ExpensesRepository } from '../infrastructure/expenses.repository';
import { amountToApprove, ClaimAction, detectReceiptType, stepNotAllowed } from '../domain/claims';
import { EXPENSES } from '../domain/permissions';

/** The uploaded file as the multipart parser hands it over (kept in memory, at most MAX_RECEIPT_BYTES). */
export interface ReceiptUpload { buffer: Buffer; size: number }

/**
 * Use cases live here: open the transaction, call repositories and other facades, write the outbox event.
 * submitted → approved (or rejected) → paid. Nobody decides their own claim; a paid claim never changes.
 */
@Injectable()
export class ExpensesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ExpensesRepository) private readonly repo: ExpensesRepository,
  ) {}

  health() { return { module: 'hrms', sub: 'expenses', ok: true }; }

  categories(ctx: RequestContext): Promise<ExpenseCategory[]> {
    return this.repo.categories(ctx.tenantId);
  }

  /**
   * A new claim on one of the caller's own jobs. A resend with the same publicId returns the stored claim
   * (created: false) without saving the file again.
   */
  async submit(ctx: RequestContext, req: CreateExpenseRequest, receipt?: ReceiptUpload): Promise<{ claim: ExpenseClaim; created: boolean }> {
    if (req.publicId) {
      const existing = await this.repo.findClaimOwner(req.publicId);
      if (existing && existing.tenantId === ctx.tenantId && existing.personId === ctx.personId) {
        return { claim: (await this.repo.claim(ctx.tenantId, req.publicId))!, created: false };
      }
      if (existing) throw new AppError('HRMS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const job = await this.repo.findEmployment(ctx.tenantId, req.employmentPublicId);
    if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
    if (job.personId !== ctx.personId) throw new AppError('HRMS_NOT_YOUR_EMPLOYMENT', 403, 'You can only claim expenses on your own job');
    const category = await this.repo.findCategory(ctx.tenantId, req.categoryCode);
    if (!category) throw new AppError('HRMS_UNKNOWN_CATEGORY', 400, `Unknown expense category ${req.categoryCode}`);

    let ext: string | null = null;
    if (receipt) {
      ext = detectReceiptType(receipt.buffer);
      if (!ext) throw new AppError('HRMS_RECEIPT_TYPE', 400, 'The receipt must be a JPEG, PNG or PDF file');
    } else if (category.receiptRequired) {
      throw new AppError('HRMS_RECEIPT_REQUIRED', 400, `A receipt is required for ${req.categoryCode} expenses`);
    }

    const receiptPath = receipt && ext ? await saveUpload('receipts', ext, receipt.buffer) : null;
    try {
      const publicId = await this.repo.insertClaim({
        tenantId: ctx.tenantId, publicId: req.publicId, personId: ctx.personId, employmentId: job.id, categoryId: category.id,
        spentOn: req.spentOn, amountPaise: req.amountPaise, description: req.description, receiptPath,
      });
      return { claim: (await this.repo.claim(ctx.tenantId, publicId))!, created: true };
    } catch (err) {
      if (receiptPath) await discardUpload(receiptPath);
      throw err;
    }
  }

  mine(ctx: RequestContext, q: MyExpensesQuery): Promise<ExpenseClaimList> {
    return this.repo.mine(ctx.tenantId, ctx.personId, q);
  }

  toApprove(ctx: RequestContext): Promise<ExpenseClaim[]> {
    return this.repo.toApprove(ctx.tenantId, ctx.personId);
  }

  async approve(ctx: RequestContext, publicId: string, req: ApproveExpenseRequest): Promise<ExpenseClaim> {
    await this.db.transaction(async (tx) => {
      const claim = await this.decidable(tx, ctx, publicId, 'approve');
      const amount = amountToApprove(claim.amountPaise, req.approvedAmountPaise);
      if (amount === null) throw new AppError('HRMS_APPROVED_TOO_HIGH', 400, 'The approved amount is more than the claimed amount');
      await this.repo.approve(tx, claim.id, ctx.personId, amount);
    });
    return (await this.repo.claim(ctx.tenantId, publicId))!;
  }

  async reject(ctx: RequestContext, publicId: string, req: RejectExpenseRequest): Promise<ExpenseClaim> {
    await this.db.transaction(async (tx) => {
      const claim = await this.decidable(tx, ctx, publicId, 'reject');
      await this.repo.reject(tx, claim.id, ctx.personId, req.reason);
    });
    return (await this.repo.claim(ctx.tenantId, publicId))!;
  }

  async markPaid(ctx: RequestContext, publicId: string, req: MarkExpensePaidRequest): Promise<ExpenseClaim> {
    requireAll(ctx, EXPENSES.pay);
    await this.db.transaction(async (tx) => {
      const claim = await this.lock(tx, ctx, publicId);
      this.checkStep(claim.status, 'pay');
      await this.repo.markPaid(tx, claim.id, req.paidAt ? new Date(req.paidAt) : new Date(), req.paymentRef);
    });
    return (await this.repo.claim(ctx.tenantId, publicId))!;
  }

  async report(ctx: RequestContext, q: ExpenseReportQuery): Promise<ExpenseReport> {
    requireAll(ctx, EXPENSES.report);
    const { byStatus, byCategory } = await this.repo.report(ctx.tenantId, q.from, q.to, q.company);
    const total = byCategory.reduce((t, c) => ({
      count: t.count + c.count, amountPaise: t.amountPaise + c.amountPaise,
      approvedPaise: t.approvedPaise + c.approvedPaise, paidPaise: t.paidPaise + c.paidPaise,
    }), { count: 0, amountPaise: 0, approvedPaise: 0, paidPaise: 0 });
    return { company: q.company ?? null, from: q.from, to: q.to, byStatus, byCategory, total };
  }

  /**
   * Approve / reject: never your own claim; scope team means you manage the claim's job; scope all means anyone's.
   * Then the claim must still be waiting for a decision.
   */
  private async decidable(tx: Tx, ctx: RequestContext, publicId: string, action: ClaimAction) {
    const claim = await this.lock(tx, ctx, publicId);
    if (claim.personId === ctx.personId) throw new AppError('HRMS_SELF_APPROVAL', 403, 'Nobody can approve or reject their own claim');
    const scope = ctx.permissions[EXPENSES.approve];
    const allowed = scope === 'all' || (scope === 'team' && claim.managerPersonId === ctx.personId);
    if (!allowed) throw new AppError('FORBIDDEN', 403, 'This claim is not on a job you manage');
    this.checkStep(claim.status, action);
    return claim;
  }

  private async lock(tx: Tx, ctx: RequestContext, publicId: string) {
    const claim = await this.repo.lockClaim(tx, ctx.tenantId, publicId);
    if (!claim) throw new AppError('HRMS_CLAIM_NOT_FOUND', 404, 'Expense claim not found');
    return claim;
  }

  private checkStep(status: Parameters<typeof stepNotAllowed>[0], action: ClaimAction): void {
    const code = stepNotAllowed(status, action);
    if (!code) return;
    const message = {
      HRMS_CLAIM_PAID: 'This claim is paid and cannot change',
      HRMS_CLAIM_NOT_PENDING: 'This claim has already been decided',
      HRMS_CLAIM_NOT_APPROVED: 'Only an approved claim can be paid',
    }[code] ?? code;
    throw new AppError(code, 409, message);
  }
}
