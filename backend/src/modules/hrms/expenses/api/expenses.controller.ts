import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  ApproveExpenseRequest, CreateExpenseRequest, ExpenseReportQuery, MarkExpensePaidRequest, MyExpensesQuery, RejectExpenseRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, Public, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { ExpensesService, ReceiptUpload } from '../application/expenses.service';
import { MAX_RECEIPT_BYTES } from '../domain/claims';
import { EXPENSES } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/expenses')
export class ExpensesController {
  constructor(@Inject(ExpensesService) private readonly service: ExpensesService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  @SignedIn() @Get('categories')
  categories(@Ctx() ctx: RequestContext) {
    return this.service.categories(ctx);
  }

  /** multipart/form-data: the CreateExpenseRequest fields plus an optional file field `receipt`. 201 new, 200 resend. */
  @Permission(EXPENSES.submit) @Post()
  @UseInterceptors(FileInterceptor('receipt', { limits: { fileSize: MAX_RECEIPT_BYTES, files: 1 } }))
  async submit(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateExpenseRequest)) body: CreateExpenseRequest,
    @UploadedFile() receipt: ReceiptUpload | undefined, @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { claim, created } = await this.service.submit(ctx, body, receipt);
    if (!created) res.status(200);
    return claim;
  }

  @Permission(EXPENSES.submit) @Get('mine')
  mine(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MyExpensesQuery)) q: MyExpensesQuery) {
    return this.service.mine(ctx, q);
  }

  @Permission(EXPENSES.approve) @Get('to-approve')
  toApprove(@Ctx() ctx: RequestContext) {
    return this.service.toApprove(ctx);
  }

  @Permission(EXPENSES.report) @Get('report')
  report(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ExpenseReportQuery)) q: ExpenseReportQuery) {
    return this.service.report(ctx, q);
  }

  @Permission(EXPENSES.approve) @Post(':publicId/approve') @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ApproveExpenseRequest)) body: ApproveExpenseRequest) {
    return this.service.approve(ctx, publicId, body);
  }

  @Permission(EXPENSES.approve) @Post(':publicId/reject') @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(RejectExpenseRequest)) body: RejectExpenseRequest) {
    return this.service.reject(ctx, publicId, body);
  }

  @Permission(EXPENSES.pay) @Post(':publicId/mark-paid') @HttpCode(200)
  markPaid(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(MarkExpensePaidRequest)) body: MarkExpensePaidRequest) {
    return this.service.markPaid(ctx, publicId, body);
  }
}
