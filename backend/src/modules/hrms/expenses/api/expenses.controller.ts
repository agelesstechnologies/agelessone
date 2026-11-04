import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  ApproveExpenseRequest, CreateExpenseRequest, ExpenseCategory, ExpenseClaim, ExpenseClaimList, ExpenseReport, ExpenseReportQuery, MarkExpensePaidRequest, MyExpensesQuery, RejectExpenseRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { respond } from '../../../../platform/csv';
import { Ctx, Permission, Public, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { ExpensesService, ReceiptUpload } from '../application/expenses.service';
import { MAX_RECEIPT_BYTES } from '../domain/claims';
import { EXPENSES } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/expenses')
export class ExpensesController {
  constructor(@Inject(ExpensesService) private readonly service: ExpensesService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  @Doc({ summary: 'Expense categories (and whether a receipt is required)', response: z.array(ExpenseCategory) })
  @SignedIn() @Get('categories')
  categories(@Ctx() ctx: RequestContext) {
    return this.service.categories(ctx);
  }

  /** multipart/form-data: the CreateExpenseRequest fields plus an optional file field `receipt`. 201 new, 200 resend. */
  @Doc({ summary: 'Submit a claim on your own job, with an optional receipt file (JPEG, PNG or PDF)', response: ExpenseClaim, resend: true, multipart: 'receipt' })
  @Permission(EXPENSES.submit) @Post()
  @UseInterceptors(FileInterceptor('receipt', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  async submit(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateExpenseRequest)) body: CreateExpenseRequest,
    @UploadedFile() receipt: ReceiptUpload | undefined, @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { claim, created } = await this.service.submit(ctx, body, receipt);
    if (!created) res.status(200);
    return claim;
  }

  @Doc({ summary: 'My claims', response: ExpenseClaimList })
  @Permission(EXPENSES.submit) @Get('mine')
  mine(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MyExpensesQuery)) q: MyExpensesQuery) {
    return this.service.mine(ctx, q);
  }

  @Doc({ summary: 'Submitted claims on jobs I manage', response: z.array(ExpenseClaim) })
  @Permission(EXPENSES.approve) @Get('to-approve')
  toApprove(@Ctx() ctx: RequestContext) {
    return this.service.toApprove(ctx);
  }

  @Doc({ summary: 'Expense report: per person, category and status, with totals (paise; CSV in rupees)', response: ExpenseReport, csv: true })
  @Permission(EXPENSES.report) @Get('report')
  async report(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ExpenseReportQuery)) q: ExpenseReportQuery,
    @Res({ passthrough: true }) res: { setHeader(k: string, v: string): void }) {
    const report = await this.service.report(ctx, q);
    return respond(q.format, res, report, () => this.service.reportCsv(report));
  }

  @Doc({ summary: 'Approve the claimed amount or a lower one (never your own)', response: ExpenseClaim })
  @Permission(EXPENSES.approve) @Post(':publicId/approve') @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ApproveExpenseRequest)) body: ApproveExpenseRequest) {
    return this.service.approve(ctx, publicId, body);
  }

  @Doc({ summary: 'Reject with a reason', response: ExpenseClaim })
  @Permission(EXPENSES.approve) @Post(':publicId/reject') @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(RejectExpenseRequest)) body: RejectExpenseRequest) {
    return this.service.reject(ctx, publicId, body);
  }

  @Doc({ summary: 'Mark an approved claim paid (it can never change after)', response: ExpenseClaim })
  @Permission(EXPENSES.pay) @Post(':publicId/mark-paid') @HttpCode(200)
  markPaid(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(MarkExpensePaidRequest)) body: MarkExpensePaidRequest) {
    return this.service.markPaid(ctx, publicId, body);
  }
}
