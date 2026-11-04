import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { ApplyLeaveRequest, CancelLeaveRequest, LeaveAdjustmentRequest, LeaveReportQuery, MyLeaveQuery, RejectLeaveRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, Public, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { LeaveService } from '../application/leave.service';
import { LEAVE } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Response = { status(code: number): void };

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/leave')
export class LeaveController {
  constructor(@Inject(LeaveService) private readonly service: LeaveService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  @SignedIn() @Get('types')
  types(@Ctx() ctx: RequestContext) {
    return this.service.types(ctx);
  }

  @Permission(LEAVE.apply) @Get('balances/mine')
  balances(@Ctx() ctx: RequestContext) {
    return this.service.balancesMine(ctx);
  }

  /** 201 new; 200 with the stored request when the same publicId is sent again. */
  @Permission(LEAVE.apply) @Post('requests')
  async apply(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ApplyLeaveRequest)) body: ApplyLeaveRequest, @Res({ passthrough: true }) res: Response) {
    const { request, created } = await this.service.apply(ctx, body);
    if (!created) res.status(200);
    return request;
  }

  @Permission(LEAVE.apply) @Get('requests/mine')
  mine(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MyLeaveQuery)) q: MyLeaveQuery) {
    return this.service.mine(ctx, q);
  }

  @Permission(LEAVE.approve) @Get('requests/to-approve')
  toApprove(@Ctx() ctx: RequestContext) {
    return this.service.toApprove(ctx);
  }

  @Permission(LEAVE.approve) @Post('requests/:publicId/approve') @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.approve(ctx, publicId);
  }

  @Permission(LEAVE.approve) @Post('requests/:publicId/reject') @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(RejectLeaveRequest)) body: RejectLeaveRequest) {
    return this.service.reject(ctx, publicId, body);
  }

  /** The person themselves, or HR (checked by the service). */
  @Permission(LEAVE.apply) @Post('requests/:publicId/cancel') @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(CancelLeaveRequest)) body: CancelLeaveRequest) {
    return this.service.cancel(ctx, publicId, body);
  }

  /** 201 new; 200 with the stored entry when the same publicId is sent again. */
  @Permission(LEAVE.manage) @Post('ledger/adjustments')
  async adjust(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(LeaveAdjustmentRequest)) body: LeaveAdjustmentRequest, @Res({ passthrough: true }) res: Response) {
    const { entry, created } = await this.service.adjust(ctx, body);
    if (!created) res.status(200);
    return entry;
  }

  @Permission(LEAVE.report) @Get('report')
  report(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(LeaveReportQuery)) q: LeaveReportQuery) {
    return this.service.report(ctx, q);
  }
}
