import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  BankImportRequest, BankImportResult, BankLine, BankLinesQuery, MarkBatchPaid, MatchBankLine, NewPaymentBatch, NewPaymentRequest, PaymentBatch,
  PaymentBatchDetail, PaymentBatchesQuery, PaymentDecision, PaymentRequest, PaymentRequestsQuery, PaymentsSummary, PaymentsSummaryQuery, TrialBalance, TrialBalanceQuery,
} from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { BankLineRow, BatchRow, PaymentsRepository, RequestRow } from '../infrastructure/payments.repository';
import { AccountsService } from './accounts.service';

const person = (publicId: string | null, displayName: string | null) => (publicId && displayName ? { publicId, displayName } : null);
const REQUEST_STATES = ['pending', 'approved', 'rejected', 'batched', 'paid', 'cancelled'] as const;
const BATCH_STATES = ['draft', 'approved', 'paid', 'cancelled'] as const;

const toRequest = (r: RequestRow, company: string): PaymentRequest => ({
  publicId: r.publicId, company, payeeName: r.payeeName, payeeKind: r.payeeKind as PaymentRequest['payeeKind'], purpose: r.purpose,
  amountMinor: r.amountMinor, currency: r.currency, dueDate: r.dueDate, state: r.state as PaymentRequest['state'],
  requestedBy: { publicId: r.requestedByPublicId, displayName: r.requestedByName }, requestedAt: r.requestedAt.toISOString(),
  decidedBy: person(r.decidedByPublicId, r.decidedByName), decidedAt: r.decidedAt?.toISOString() ?? null, decisionNote: r.decisionNote, batchPublicId: r.batchPublicId,
});
const toBatch = (b: BatchRow, company: string): PaymentBatch => ({
  publicId: b.publicId, company, bankLedgerKey: b.bankLedgerKey, state: b.state as PaymentBatch['state'], requestCount: b.requestCount, totalMinor: b.totalMinor,
  currency: b.currency, createdBy: { publicId: b.createdByPublicId, displayName: b.createdByName }, createdAt: b.createdAt.toISOString(),
  approvedBy: person(b.approvedByPublicId, b.approvedByName), approvedAt: b.approvedAt?.toISOString() ?? null, paidOn: b.paidOn, bankReference: b.bankReference,
  paidBy: person(b.paidByPublicId, b.paidByName), reconciled: b.reconciled,
});
const toLine = (l: BankLineRow, company: string): BankLine => ({
  publicId: l.publicId, company, bankLedgerKey: l.bankLedgerKey, txnDate: l.txnDate, description: l.description, reference: l.reference || null,
  debitMinor: l.debitMinor, creditMinor: l.creditMinor, state: l.state as BankLine['state'], matchedBatchPublicId: l.matchedBatchPublicId,
  matchedBy: person(l.matchedByPublicId, l.matchedByName), matchedAt: l.matchedAt?.toISOString() ?? null,
});

/**
 * Payment requests, payment batches, the bank statement and reports. Same two-person rule as the rest of Accounts: the
 * maker asks, builds and pays; a different person (the checker) approves. Paying a batch does not post to the journal yet.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PaymentsRepository) private readonly repo: PaymentsRepository,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  private async codeOf(ctx: RequestContext, legalEntityId: number) {
    return (await this.accounts.companyCodeOf(ctx.tenantId, legalEntityId))!;
  }

  private audit(tx: Tx, ctx: RequestContext, action: string, entity: string, entityPublicId: string, legalEntityId: number, summary: string, details?: Record<string, unknown>) {
    return this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action, entity, entityPublicId, legalEntityId, summary, ...(details ? { details } : {}) });
  }

  // ---- payment requests ----

  async requests(ctx: RequestContext, q: PaymentRequestsQuery): Promise<PaymentRequest[]> {
    const c = await this.accounts.company(ctx, q.company);
    await this.accounts.require(ctx, c.id, 'view');
    return (await this.repo.requests(c.id, q.state)).map((r) => toRequest(r, c.code));
  }

  private async oneRequest(ctx: RequestContext, publicId: string): Promise<PaymentRequest> {
    const r = await this.repo.requestBy(this.db, ctx.tenantId, publicId);
    if (!r) throw new AppError('NOT_FOUND', 404, 'No such payment request');
    return toRequest(r, await this.codeOf(ctx, r.legalEntityId));
  }

  /** The maker asks for a payment. The same publicId sent again returns the stored request. */
  async createRequest(ctx: RequestContext, req: NewPaymentRequest): Promise<{ request: PaymentRequest; created: boolean }> {
    const c = await this.accounts.company(ctx, req.company);
    await this.accounts.require(ctx, c.id, 'maker');
    const publicId = req.publicId ?? randomUUID();
    const found = await this.repo.tenantOfRequest(publicId);
    if (found) {
      if (found.tenantId !== ctx.tenantId) throw new AppError('ACCOUNTS_DUPLICATE_ID', 409, 'This publicId is already used');
      return { request: await this.oneRequest(ctx, publicId), created: false };
    }
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.insertRequest(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: c.id, payeeName: req.payeeName, payeeKind: req.payeeKind,
          purpose: req.purpose, amountMinor: req.amountMinor, dueDate: req.dueDate, requestedBy: ctx.personId });
        await this.audit(tx, ctx, 'accounts.payment_requested', 'payment_request', publicId, c.id, `Asked to pay ${req.payeeName}`, { amountMinor: req.amountMinor });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'payment_requests_public_id_unique') return { request: await this.oneRequest(ctx, publicId), created: false };
      throw err;
    }
    return { request: await this.oneRequest(ctx, publicId), created: true };
  }

  /** Locks one request of the caller's tenant and checks the caller holds the role for its company. */
  private async lockedRequest(ctx: RequestContext, tx: Tx, publicId: string, who: 'maker' | 'checker') {
    const [r] = await this.repo.lockRequests(tx, ctx.tenantId, [publicId]);
    if (!r) throw new AppError('NOT_FOUND', 404, 'No such payment request');
    await this.accounts.require(ctx, r.legalEntityId, who);
    return r;
  }

  /** The checker approves a pending request that someone else made. Approving an approved one changes nothing. */
  async approveRequest(ctx: RequestContext, publicId: string): Promise<PaymentRequest> {
    await this.db.transaction(async (tx) => {
      const r = await this.lockedRequest(ctx, tx, publicId, 'checker');
      if (r.state !== 'pending') {
        if (r.state === 'approved') return;
        throw new AppError('ACCOUNTS_BAD_STATE', 409, `A ${r.state} request cannot be approved`);
      }
      if (r.requestedBy === ctx.personId) throw new AppError('ACCOUNTS_SELF_APPROVAL', 403, 'Someone else must approve your request');
      await this.repo.updateRequest(tx, r.id, { state: 'approved', decidedBy: ctx.personId, decidedAt: new Date() });
      await this.audit(tx, ctx, 'accounts.payment_request_approved', 'payment_request', publicId, r.legalEntityId, 'Approved a payment request');
    });
    return this.oneRequest(ctx, publicId);
  }

  /** The checker rejects a pending request (with a reason). */
  async rejectRequest(ctx: RequestContext, publicId: string, req: PaymentDecision): Promise<PaymentRequest> {
    await this.db.transaction(async (tx) => {
      const r = await this.lockedRequest(ctx, tx, publicId, 'checker');
      if (r.state === 'rejected') return;
      if (r.state !== 'pending') throw new AppError('ACCOUNTS_BAD_STATE', 409, `A ${r.state} request cannot be rejected`);
      if (r.requestedBy === ctx.personId) throw new AppError('ACCOUNTS_SELF_APPROVAL', 403, 'Someone else must decide your request');
      await this.repo.updateRequest(tx, r.id, { state: 'rejected', decidedBy: ctx.personId, decidedAt: new Date(), decisionNote: req.note });
      await this.audit(tx, ctx, 'accounts.payment_request_rejected', 'payment_request', publicId, r.legalEntityId, 'Rejected a payment request', { note: req.note });
    });
    return this.oneRequest(ctx, publicId);
  }

  /** The maker withdraws a request that is still pending. */
  async cancelRequest(ctx: RequestContext, publicId: string, req: PaymentDecision): Promise<PaymentRequest> {
    await this.db.transaction(async (tx) => {
      const r = await this.lockedRequest(ctx, tx, publicId, 'maker');
      if (r.state === 'cancelled') return;
      if (r.state !== 'pending') throw new AppError('ACCOUNTS_BAD_STATE', 409, `Only a pending request can be cancelled (this one is ${r.state})`);
      await this.repo.updateRequest(tx, r.id, { state: 'cancelled', decisionNote: req.note });
      await this.audit(tx, ctx, 'accounts.payment_request_cancelled', 'payment_request', publicId, r.legalEntityId, 'Cancelled a payment request', { note: req.note });
    });
    return this.oneRequest(ctx, publicId);
  }

  // ---- payment batches ----

  async batches(ctx: RequestContext, q: PaymentBatchesQuery): Promise<PaymentBatch[]> {
    const c = await this.accounts.company(ctx, q.company);
    await this.accounts.require(ctx, c.id, 'view');
    return (await this.repo.batches(c.id)).map((b) => toBatch(b, c.code));
  }

  async batch(ctx: RequestContext, publicId: string): Promise<PaymentBatchDetail> {
    const b = await this.repo.batchBy(this.db, ctx.tenantId, publicId);
    if (!b) throw new AppError('NOT_FOUND', 404, 'No such payment batch');
    await this.accounts.require(ctx, b.legalEntityId, 'view');
    const code = await this.codeOf(ctx, b.legalEntityId);
    return { ...toBatch(b, code), requests: (await this.repo.requestsOfBatch(this.db, b.id)).map((r) => toRequest(r, code)) };
  }

  /** The maker groups approved requests of one company into a batch. The same publicId sent again returns the stored batch. */
  async createBatch(ctx: RequestContext, req: NewPaymentBatch): Promise<{ batch: PaymentBatchDetail; created: boolean }> {
    const c = await this.accounts.company(ctx, req.company);
    await this.accounts.require(ctx, c.id, 'maker');
    const publicId = req.publicId ?? randomUUID();
    const found = await this.repo.tenantOfBatch(publicId);
    if (found) {
      if (found.tenantId !== ctx.tenantId) throw new AppError('ACCOUNTS_DUPLICATE_ID', 409, 'This publicId is already used');
      return { batch: await this.batch(ctx, publicId), created: false };
    }
    const ids = [...new Set(req.requestPublicIds)];
    await this.db.transaction(async (tx) => {
      const rows = await this.repo.lockRequests(tx, ctx.tenantId, ids);
      if (rows.length !== ids.length || rows.some((r) => r.legalEntityId !== c.id)) throw new AppError('NOT_FOUND', 404, `Some of those requests are not ${c.code} payment requests`);
      const bad = rows.find((r) => r.state !== 'approved');
      if (bad) throw new AppError('ACCOUNTS_BAD_STATE', 409, `Only approved requests can be batched (one is ${bad.state})`);
      const total = rows.reduce((s, r) => s + r.amountMinor, 0);
      const batchId = await this.repo.insertBatch(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: c.id, bankLedgerKey: req.bankLedgerKey,
        requestCount: rows.length, totalMinor: total, createdBy: ctx.personId });
      for (const r of rows) await this.repo.updateRequest(tx, r.id, { state: 'batched', batchId });
      await this.audit(tx, ctx, 'accounts.payment_batch_created', 'payment_batch', publicId, c.id, `Built a payment batch of ${rows.length} request(s)`, { totalMinor: total });
    });
    return { batch: await this.batch(ctx, publicId), created: true };
  }

  private async lockedBatch(ctx: RequestContext, tx: Tx, publicId: string, who: 'maker' | 'checker') {
    const b = await this.repo.lockBatch(tx, ctx.tenantId, publicId);
    if (!b) throw new AppError('NOT_FOUND', 404, 'No such payment batch');
    await this.accounts.require(ctx, b.legalEntityId, who);
    return b;
  }

  /** The checker approves a draft batch that someone else built. */
  async approveBatch(ctx: RequestContext, publicId: string): Promise<PaymentBatchDetail> {
    await this.db.transaction(async (tx) => {
      const b = await this.lockedBatch(ctx, tx, publicId, 'checker');
      if (b.state === 'approved') return;
      if (b.state !== 'draft') throw new AppError('ACCOUNTS_BAD_STATE', 409, `A ${b.state} batch cannot be approved`);
      if (b.createdBy === ctx.personId) throw new AppError('ACCOUNTS_SELF_APPROVAL', 403, 'Someone else must approve the batch you built');
      await this.repo.updateBatch(tx, b.id, { state: 'approved', approvedBy: ctx.personId, approvedAt: new Date() });
      await this.audit(tx, ctx, 'accounts.payment_batch_approved', 'payment_batch', publicId, b.legalEntityId, 'Approved a payment batch');
    });
    return this.batch(ctx, publicId);
  }

  /** The maker says the approved batch has been paid at the bank (date and bank reference). Its requests become paid. */
  async markPaid(ctx: RequestContext, publicId: string, req: MarkBatchPaid): Promise<PaymentBatchDetail> {
    await this.db.transaction(async (tx) => {
      const b = await this.lockedBatch(ctx, tx, publicId, 'maker');
      if (b.state === 'paid') return;
      if (b.state !== 'approved') throw new AppError('ACCOUNTS_BAD_STATE', 409, `Only an approved batch can be marked paid (this one is ${b.state})`);
      await this.repo.updateBatch(tx, b.id, { state: 'paid', paidBy: ctx.personId, paidAt: new Date(), paidOn: req.paidOn, bankReference: req.bankReference });
      await this.repo.setBatchRequests(tx, b.id, 'batched', { state: 'paid' });
      await this.audit(tx, ctx, 'accounts.payment_batch_paid', 'payment_batch', publicId, b.legalEntityId, 'Marked a payment batch paid', { paidOn: req.paidOn });
    });
    return this.batch(ctx, publicId);
  }

  /** Cancels a draft or approved batch (the maker or the checker); its requests go back to approved. A paid batch cannot be cancelled. */
  async cancelBatch(ctx: RequestContext, publicId: string, req: PaymentDecision): Promise<PaymentBatchDetail> {
    await this.db.transaction(async (tx) => {
      const found = await this.repo.lockBatch(tx, ctx.tenantId, publicId);
      if (!found) throw new AppError('NOT_FOUND', 404, 'No such payment batch');
      const a = await this.accounts.access(ctx, found.legalEntityId);
      if (!a.maker && !a.checker) await this.accounts.require(ctx, found.legalEntityId, 'makerOrChecker');
      if (found.state === 'cancelled') return;
      if (found.state === 'paid') throw new AppError('ACCOUNTS_BAD_STATE', 409, 'A paid batch cannot be cancelled');
      await this.repo.setBatchRequests(tx, found.id, 'batched', { state: 'approved', batchId: null });
      await this.repo.updateBatch(tx, found.id, { state: 'cancelled' });
      await this.audit(tx, ctx, 'accounts.payment_batch_cancelled', 'payment_batch', publicId, found.legalEntityId, 'Cancelled a payment batch', { note: req.note });
    });
    return this.batch(ctx, publicId);
  }

  // ---- bank statement ----

  async lines(ctx: RequestContext, q: BankLinesQuery): Promise<BankLine[]> {
    const c = await this.accounts.company(ctx, q.company);
    await this.accounts.require(ctx, c.id, 'view');
    return (await this.repo.lines(c.id, { bankLedgerKey: q.bankLedgerKey, state: q.state })).map((l) => toLine(l, c.code));
  }

  /** The maker imports statement rows. Rows already on file are skipped, so sending a statement twice adds nothing. */
  async importLines(ctx: RequestContext, req: BankImportRequest): Promise<BankImportResult> {
    const c = await this.accounts.company(ctx, req.company);
    await this.accounts.require(ctx, c.id, 'maker');
    const result = await this.db.transaction(async (tx) => {
      let imported = 0;
      for (const l of req.lines) {
        const added = await this.repo.insertLine(tx, { tenantId: ctx.tenantId, legalEntityId: c.id, bankLedgerKey: req.bankLedgerKey, txnDate: l.txnDate,
          description: l.description, reference: l.reference ?? '', debitMinor: l.debitMinor, creditMinor: l.creditMinor, importedBy: ctx.personId });
        if (added) imported += 1;
      }
      if (imported > 0) {
        await this.audit(tx, ctx, 'accounts.bank_imported', 'bank_statement', randomUUID(), c.id, `Imported ${imported} bank statement line(s) for ${c.code}`, { bank: req.bankLedgerKey });
      }
      return { imported, skipped: req.lines.length - imported };
    });
    return result;
  }

  /** The maker ties a money-out line to the paid batch it settled: same company, same bank, same amount, once. */
  async match(ctx: RequestContext, publicId: string, req: MatchBankLine): Promise<BankLine> {
    const company = await this.db.transaction(async (tx) => {
      const line = await this.repo.lockLine(tx, ctx.tenantId, publicId);
      if (!line) throw new AppError('NOT_FOUND', 404, 'No such bank line');
      await this.accounts.require(ctx, line.legalEntityId, 'maker');
      const batch = await this.repo.lockBatch(tx, ctx.tenantId, req.batchPublicId);
      if (!batch || batch.legalEntityId !== line.legalEntityId) throw new AppError('NOT_FOUND', 404, 'No such payment batch for this company');
      if (line.state === 'matched') {
        if (line.matchedBatchId === batch.id) return line.legalEntityId;
        throw new AppError('ACCOUNTS_BAD_STATE', 409, 'This line is already matched to another batch');
      }
      if (line.debitMinor === 0) throw new AppError('ACCOUNTS_BAD_STATE', 409, 'Only money out can be matched to a payment batch');
      if (batch.state !== 'paid') throw new AppError('ACCOUNTS_BAD_STATE', 409, 'Only a paid batch can be matched to the bank');
      if (batch.bankLedgerKey !== line.bankLedgerKey) throw new AppError('ACCOUNTS_BANK_MISMATCH', 409, 'The line and the batch are on different bank accounts');
      if (batch.totalMinor !== line.debitMinor) throw new AppError('ACCOUNTS_AMOUNT_MISMATCH', 409, 'The line amount differs from the batch total');
      try {
        await this.repo.matchLine(tx, line.id, batch.id, ctx.personId);
      } catch (err) {
        if (violatedConstraint(err) === 'bank_lines_batch_once') throw new AppError('ACCOUNTS_BAD_STATE', 409, 'This batch is already matched to another bank line');
        throw err;
      }
      await this.audit(tx, ctx, 'accounts.bank_line_matched', 'bank_line', publicId, line.legalEntityId, 'Matched a bank line to a payment batch');
      return line.legalEntityId;
    });
    const row = await this.repo.lineBy(this.db, ctx.tenantId, publicId);
    return toLine(row!, await this.codeOf(ctx, company));
  }

  // ---- reports ----

  /** Every ledger with entries in the period, from the journal. Debits and credits always add up to the same total. */
  async trialBalance(ctx: RequestContext, q: TrialBalanceQuery): Promise<TrialBalance> {
    const c = await this.accounts.company(ctx, q.company);
    await this.accounts.require(ctx, c.id, 'view');
    const rows = (await this.repo.trialBalance(c.id, q.from, q.to)).map((r) => ({ ...r, balanceMinor: r.debitMinor - r.creditMinor }));
    return { company: c.code, from: q.from ?? null, to: q.to ?? null, rows,
      totalDebitMinor: rows.reduce((s, r) => s + r.debitMinor, 0), totalCreditMinor: rows.reduce((s, r) => s + r.creditMinor, 0) };
  }

  /** Where requests, batches and the bank statement stand. Every state is listed, with zeros. */
  async summary(ctx: RequestContext, q: PaymentsSummaryQuery): Promise<PaymentsSummary> {
    const c = await this.accounts.company(ctx, q.company);
    await this.accounts.require(ctx, c.id, 'view');
    const [rq, bt, bank] = await Promise.all([this.repo.requestTotals(c.id), this.repo.batchTotals(c.id), this.repo.bankTotals(c.id)]);
    const fill = <S extends string>(states: readonly S[], rows: { state: string; count: number; totalMinor: number }[]) =>
      Object.fromEntries(states.map((s) => { const r = rows.find((x) => x.state === s); return [s, { count: r?.count ?? 0, totalMinor: r?.totalMinor ?? 0 }]; })) as Record<S, { count: number; totalMinor: number }>;
    return { company: c.code, requests: fill(REQUEST_STATES, rq), batches: fill(BATCH_STATES, bt), bank };
  }
}
