import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  AddAdjustmentRequest, AddBankAccountRequest, AddSalaryRequest, BankAccount, BankAccountsQuery, CreateRunRequest, MarkRunPaidRequest,
  PayrollRun, PayrollRunSummary, Payslip, RunsQuery, Salary, SalariesQuery, UpdateAdjustmentRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, Public, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { PayrollService } from '../application/payroll.service';
import { PAYROLL } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
type FileReply = { setHeader(k: string, v: string): void; send(b: Buffer | string): void };
const STAFF = 'Payroll roles only (payroll.prepare or payroll.approve, scope all); others get 403.';

/** Only: validate input, check permission, call one use case. */
@Controller('payroll')
export class PayrollController {
  constructor(@Inject(PayrollService) private readonly service: PayrollService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  @Doc({ summary: 'Salaries: every row, newest first', response: z.array(Salary), description: STAFF })
  @SignedIn() @Get('salaries')
  salaries(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(SalariesQuery)) q: SalariesQuery) {
    return this.service.salaries(ctx, q);
  }

  @Doc({ summary: 'Add a job\'s monthly salary from a date (a change is a new row)', response: Salary, resend: true })
  @Permission(PAYROLL.prepare) @Post('salaries')
  async addSalary(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(AddSalaryRequest)) body: AddSalaryRequest, @Res({ passthrough: true }) res: Created) {
    const { salary, created } = await this.service.addSalary(ctx, body);
    if (!created) res.status(200);
    return salary;
  }

  @Doc({ summary: 'Bank details (account numbers masked)', response: z.array(BankAccount), description: STAFF })
  @SignedIn() @Get('bank-accounts')
  bankAccounts(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(BankAccountsQuery)) q: BankAccountsQuery) {
    return this.service.bankAccounts(ctx, q);
  }

  @Doc({ summary: 'Add where a job\'s salary is paid, from a date', response: BankAccount, resend: true })
  @Permission(PAYROLL.prepare) @Post('bank-accounts')
  async addBankAccount(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(AddBankAccountRequest)) body: AddBankAccountRequest,
    @Res({ passthrough: true }) res: Created) {
    const { account, created } = await this.service.addBankAccount(ctx, body);
    if (!created) res.status(200);
    return account;
  }

  @Doc({ summary: 'Payroll runs with totals', response: z.array(PayrollRunSummary), description: STAFF })
  @SignedIn() @Get('runs')
  runs(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(RunsQuery)) q: RunsQuery) {
    return this.service.runs(ctx, q);
  }

  @Doc({ summary: 'Create the company\'s run for a month (attendance must be locked: HRMS_MONTH_NOT_LOCKED)', response: PayrollRun,
    description: 'Asking again for the same company and month answers the existing run with 200.' })
  @Permission(PAYROLL.prepare) @Post('runs')
  async createRun(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateRunRequest)) body: CreateRunRequest, @Res({ passthrough: true }) res: Created) {
    const { run, created } = await this.service.createRun(ctx, body);
    if (!created) res.status(200);
    return run;
  }

  @Doc({ summary: 'One run: every person\'s pay and adjustments (draft: also jobs without a salary)', response: PayrollRun, description: STAFF })
  @SignedIn() @Get('runs/:publicId')
  run(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.run(ctx, publicId);
  }

  @Doc({ summary: 'Recalculate a draft from salaries and the locked attendance (adjustments are kept)', response: PayrollRun })
  @Permission(PAYROLL.prepare) @Post('runs/:publicId/recalculate') @HttpCode(200)
  recalculate(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.recalculate(ctx, publicId);
  }

  @Doc({ summary: 'Approve a draft (never the one who prepared it last); it can no longer change', response: PayrollRun })
  @Permission(PAYROLL.approve) @Post('runs/:publicId/approve') @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.approve(ctx, publicId);
  }

  @Doc({ summary: 'Record that an approved run was paid (date and bank reference)', response: PayrollRun })
  @Permission(PAYROLL.prepare) @Post('runs/:publicId/mark-paid') @HttpCode(200)
  markPaid(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(MarkRunPaidRequest)) body: MarkRunPaidRequest) {
    return this.service.markPaid(ctx, publicId, body);
  }

  @Doc({ summary: 'Salary register CSV of an approved or paid run (TOTAL line)', csv: true, description: STAFF })
  @SignedIn() @Get('runs/:publicId/register')
  async register(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    this.sendCsv(res, await this.service.registerCsv(ctx, publicId));
  }

  @Doc({ summary: 'Bank upload CSV of an approved or paid run (name, account, IFSC, amount)', csv: true, description: STAFF })
  @SignedIn() @Get('runs/:publicId/bank-file')
  async bankFile(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    this.sendCsv(res, await this.service.bankCsv(ctx, publicId));
  }

  @Doc({ summary: 'Add an addition or deduction (PT, TDS, ESI, Advance, Bonus …) to a person\'s pay in a draft', response: PayrollRun, resend: true })
  @Permission(PAYROLL.prepare) @Post('items/:publicId/adjustments')
  async addAdjustment(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddAdjustmentRequest)) body: AddAdjustmentRequest, @Res({ passthrough: true }) res: Created) {
    const { run, created } = await this.service.addAdjustment(ctx, publicId, body);
    if (!created) res.status(200);
    return run;
  }

  @Doc({ summary: 'Change an adjustment (draft only)', response: PayrollRun })
  @Permission(PAYROLL.prepare) @Patch('adjustments/:publicId')
  updateAdjustment(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UpdateAdjustmentRequest)) body: UpdateAdjustmentRequest) {
    return this.service.updateAdjustment(ctx, publicId, body);
  }

  @Doc({ summary: 'Remove an adjustment (draft only)', response: PayrollRun })
  @Permission(PAYROLL.prepare) @Delete('adjustments/:publicId')
  removeAdjustment(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.removeAdjustment(ctx, publicId);
  }

  @Doc({ summary: 'My payslips (approved or paid runs)', response: z.array(Payslip) })
  @Permission(PAYROLL.payslip) @Get('payslips/mine')
  payslips(@Ctx() ctx: RequestContext) {
    return this.service.payslipsMine(ctx);
  }

  @Doc({ summary: 'A payslip PDF: your own, or any for the payroll roles', file: true })
  @SignedIn() @Get('payslips/:publicId/pdf')
  async payslipPdf(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    const { name, data } = await this.service.payslipPdf(ctx, publicId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(data);
  }

  private sendCsv(res: FileReply, file: { name: string; body: string }): void {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
    res.send(file.body);
  }
}
