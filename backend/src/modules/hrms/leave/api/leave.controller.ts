import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { ApplyLeaveRequest, CancelLeaveRequest, LeaveAdjustmentRequest, LeaveBalance, LeaveLedgerEntry, LeaveReport, LeaveReportQuery, LeaveRequestView, LeaveType, MyLeaveQuery, RejectLeaveRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { respond } from '../../../../platform/csv';
import { Ctx, Permission, Public, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { LeaveService } from '../application/leave.service';
import { LEAVE } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Response = { status(code: number): void };

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/leave')
export class LeaveController {
  constructor(@Inject(LeaveService) private readonly service: LeaveService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  @Doc({ summary: 'Leave types', response: z.array(LeaveType) })
  @SignedIn() @Get('types')
  types(@Ctx() ctx: RequestContext) {
    return this.service.types(ctx);
  }

  @Doc({ summary: 'My balance per company and leave type', response: z.array(LeaveBalance) })
  @Permission(LEAVE.apply) @Get('balances/mine')
  balances(@Ctx() ctx: RequestContext) {
    return this.service.balancesMine(ctx);
  }

  /** 201 new; 200 with the stored request when the same publicId is sent again. */
  @Doc({ summary: 'Apply for leave on one of your jobs (days counted from the calendar)', response: LeaveRequestView, resend: true })
  @Permission(LEAVE.apply) @Post('requests')
  async apply(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ApplyLeaveRequest)) body: ApplyLeaveRequest, @Res({ passthrough: true }) res: Response) {
    const { request, created } = await this.service.apply(ctx, body);
    if (!created) res.status(200);
    return request;
  }

  @Doc({ summary: 'My leave requests', response: z.array(LeaveRequestView) })
  @Permission(LEAVE.apply) @Get('requests/mine')
  mine(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MyLeaveQuery)) q: MyLeaveQuery) {
    return this.service.mine(ctx, q);
  }

  @Doc({ summary: 'Leave waiting for my decision', response: z.array(LeaveRequestView) })
  @Permission(LEAVE.approve) @Get('requests/to-approve')
  toApprove(@Ctx() ctx: RequestContext) {
    return this.service.toApprove(ctx);
  }

  @Doc({ summary: 'Approve: takes the days from the balance and marks the work days (never your own)', response: LeaveRequestView })
  @Permission(LEAVE.approve) @Post('requests/:publicId/approve') @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.approve(ctx, publicId);
  }

  @Doc({ summary: 'Reject with a reason', response: LeaveRequestView })
  @Permission(LEAVE.approve) @Post('requests/:publicId/reject') @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(RejectLeaveRequest)) body: RejectLeaveRequest) {
    return this.service.reject(ctx, publicId, body);
  }

  /** The person themselves, or HR (checked by the service). */
  @Doc({ summary: 'Cancel (approved leave only before it starts; the days are given back)', response: LeaveRequestView })
  @Permission(LEAVE.apply) @Post('requests/:publicId/cancel') @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(CancelLeaveRequest)) body: CancelLeaveRequest) {
    return this.service.cancel(ctx, publicId, body);
  }

  /** 201 new; 200 with the stored entry when the same publicId is sent again. */
  @Doc({ summary: 'HR: an opening balance or an adjustment, with a reason', response: LeaveLedgerEntry, resend: true })
  @Permission(LEAVE.manage) @Post('ledger/adjustments')
  async adjust(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(LeaveAdjustmentRequest)) body: LeaveAdjustmentRequest, @Res({ passthrough: true }) res: Response) {
    const { entry, created } = await this.service.adjust(ctx, body);
    if (!created) res.status(200);
    return entry;
  }

  @Doc({ summary: 'Leave report: requests, and per person days taken in the period and current balance', response: LeaveReport, csv: true })
  @Permission(LEAVE.report) @Get('report')
  async report(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(LeaveReportQuery)) q: LeaveReportQuery,
    @Res({ passthrough: true }) res: { setHeader(k: string, v: string): void }) {
    const report = await this.service.report(ctx, q);
    const csv = q.format === 'csv' ? await this.service.reportCsv(ctx, report) : undefined;
    return respond(q.format, res, report, () => csv!);
  }
}
