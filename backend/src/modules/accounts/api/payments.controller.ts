import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  BankImportRequest, BankImportResult, BankLine, BankLinesQuery, MarkBatchPaid, MatchBankLine, NewPaymentBatch, NewPaymentRequest, PaymentBatch, PaymentBatchDetail,
  PaymentBatchesQuery, PaymentDecision, PaymentRequest, PaymentRequestsQuery, PaymentsSummary, PaymentsSummaryQuery, TrialBalance, TrialBalanceQuery,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { PaymentsService } from '../application/payments.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
const WHO = 'Accounts roles only (maker, checker, or HR/CEO while the interim policy accounts.interim_roles applies); others get 403.';
const MAKER = 'Accounts maker only; others get 403.';
const CHECKER = 'Accounts checker only, and never the person who made it (ACCOUNTS_SELF_APPROVAL); others get 403.';

/** Only: validate input, check permission, call one use case. */
@Controller('accounts')
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly service: PaymentsService) {}

  // ---- payment requests ----

  @Doc({ summary: 'Payment requests of a company, newest first (optionally one state)', response: z.array(PaymentRequest), description: WHO })
  @SignedIn() @Get('payment-requests')
  requests(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PaymentRequestsQuery)) q: PaymentRequestsQuery) { return this.service.requests(ctx, q); }

  @Doc({ summary: 'Ask for a payment', response: PaymentRequest, resend: true, description: MAKER })
  @SignedIn() @Post('payment-requests')
  async createRequest(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(NewPaymentRequest)) body: NewPaymentRequest, @Res({ passthrough: true }) res: Created) {
    const { request, created } = await this.service.createRequest(ctx, body);
    if (!created) res.status(200);
    return request;
  }

  @Doc({ summary: 'Approve a pending payment request', response: PaymentRequest, description: CHECKER })
  @SignedIn() @Post('payment-requests/:publicId/approve')
  approveRequest(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.approveRequest(ctx, publicId);
  }

  @Doc({ summary: 'Reject a pending payment request, with a reason', response: PaymentRequest, description: CHECKER })
  @SignedIn() @Post('payment-requests/:publicId/reject')
  rejectRequest(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(PaymentDecision)) body: PaymentDecision,
    @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.rejectRequest(ctx, publicId, body);
  }

  @Doc({ summary: 'Withdraw a payment request that is still pending, with a reason', response: PaymentRequest, description: MAKER })
  @SignedIn() @Post('payment-requests/:publicId/cancel')
  cancelRequest(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(PaymentDecision)) body: PaymentDecision,
    @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.cancelRequest(ctx, publicId, body);
  }

  // ---- payment batches ----

  @Doc({ summary: 'Payment batches of a company, newest first', response: z.array(PaymentBatch), description: WHO })
  @SignedIn() @Get('payment-batches')
  batches(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PaymentBatchesQuery)) q: PaymentBatchesQuery) { return this.service.batches(ctx, q); }

  @Doc({ summary: 'Group approved payment requests into a batch to be paid from one bank ledger', response: PaymentBatchDetail, resend: true, description: MAKER })
  @SignedIn() @Post('payment-batches')
  async createBatch(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(NewPaymentBatch)) body: NewPaymentBatch, @Res({ passthrough: true }) res: Created) {
    const { batch, created } = await this.service.createBatch(ctx, body);
    if (!created) res.status(200);
    return batch;
  }

  @Doc({ summary: 'One payment batch with its requests', response: PaymentBatchDetail, description: WHO })
  @SignedIn() @Get('payment-batches/:publicId')
  batch(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) { return this.service.batch(ctx, publicId); }

  @Doc({ summary: 'Approve a draft payment batch', response: PaymentBatchDetail, description: CHECKER })
  @SignedIn() @Post('payment-batches/:publicId/approve')
  approveBatch(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.approveBatch(ctx, publicId);
  }

  @Doc({ summary: 'Say an approved batch has been paid at the bank (date and bank reference)', response: PaymentBatchDetail, description: MAKER })
  @SignedIn() @Post('payment-batches/:publicId/mark-paid')
  markPaid(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(MarkBatchPaid)) body: MarkBatchPaid,
    @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.markPaid(ctx, publicId, body);
  }

  @Doc({ summary: 'Cancel a draft or approved batch; its requests go back to approved', response: PaymentBatchDetail, description: 'Accounts maker or checker; a paid batch cannot be cancelled.' })
  @SignedIn() @Post('payment-batches/:publicId/cancel')
  cancelBatch(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(PaymentDecision)) body: PaymentDecision,
    @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.cancelBatch(ctx, publicId, body);
  }

  // ---- bank statement ----

  @Doc({ summary: 'Imported bank statement lines, newest first', response: z.array(BankLine), description: WHO })
  @SignedIn() @Get('bank/lines')
  lines(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(BankLinesQuery)) q: BankLinesQuery) { return this.service.lines(ctx, q); }

  @Doc({ summary: 'Import bank statement lines (rows already on file are skipped)', response: BankImportResult, description: MAKER })
  @SignedIn() @Post('bank/import')
  import(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(BankImportRequest)) body: BankImportRequest, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.importLines(ctx, body);
  }

  @Doc({ summary: 'Match a money-out bank line to the paid batch it settled (same bank, same amount)', response: BankLine, description: MAKER })
  @SignedIn() @Post('bank/lines/:publicId/match')
  match(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(MatchBankLine)) body: MatchBankLine,
    @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.match(ctx, publicId, body);
  }

  // ---- reports ----

  @Doc({ summary: 'Trial balance: every ledger with entries in the period, from the journal', response: TrialBalance, description: WHO })
  @SignedIn() @Get('reports/trial-balance')
  trialBalance(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(TrialBalanceQuery)) q: TrialBalanceQuery) { return this.service.trialBalance(ctx, q); }

  @Doc({ summary: 'Where payment requests, batches and the bank statement stand', response: PaymentsSummary, description: WHO })
  @SignedIn() @Get('reports/payments-summary')
  summary(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PaymentsSummaryQuery)) q: PaymentsSummaryQuery) { return this.service.summary(ctx, q); }
}
