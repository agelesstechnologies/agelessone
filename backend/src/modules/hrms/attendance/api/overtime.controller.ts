import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { CreateOvertimeRequest, ForwardRequest, MyOvertimeQuery, OvertimeRequestView, RejectOvertimeRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { OvertimeService } from '../application/overtime.service';
import { ATTENDANCE } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/attendance/overtime')
export class OvertimeController {
  constructor(@Inject(OvertimeService) private readonly service: OvertimeService) {}

  /** 201 new; 200 with the stored request when the same publicId is sent again. */
  @Doc({ summary: 'Ask for overtime on a day (future dates allowed: planned overtime)', response: OvertimeRequestView, resend: true })
  @Permission(ATTENDANCE.punch) @Post()
  async request(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateOvertimeRequest)) body: CreateOvertimeRequest,
    @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { request, created } = await this.service.request(ctx, body);
    if (!created) res.status(200);
    return request;
  }

  @Doc({ summary: 'Overtime requests about me or filed by me', response: z.array(OvertimeRequestView) })
  @Permission(ATTENDANCE.punch) @Get('mine')
  mine(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MyOvertimeQuery)) q: MyOvertimeQuery) {
    return this.service.mine(ctx, q);
  }

  @Doc({ summary: 'Overtime requests waiting for my decision', response: z.array(OvertimeRequestView) })
  @Permission(ATTENDANCE.approve) @Get('to-approve')
  toApprove(@Ctx() ctx: RequestContext) {
    return this.service.toApprove(ctx);
  }

  @Doc({ summary: 'Approve: the day\'s approved overtime = approved minutes, at most its extra time', response: OvertimeRequestView })
  @Permission(ATTENDANCE.approve) @Post(':publicId/approve') @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.approve(ctx, publicId);
  }

  @Doc({ summary: 'Reject with a reason', response: OvertimeRequestView })
  @Permission(ATTENDANCE.approve) @Post(':publicId/reject') @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(RejectOvertimeRequest)) body: RejectOvertimeRequest) {
    return this.service.reject(ctx, publicId, body);
  }

  @Doc({ summary: 'Forward to the CEO with a reason (whoever may decide it; it stays decidable by them too)', response: OvertimeRequestView })
  @Permission(ATTENDANCE.approve) @Post(':publicId/forward') @HttpCode(200)
  forward(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(ForwardRequest)) body: ForwardRequest) {
    return this.service.forward(ctx, publicId, body);
  }

  /** The person or whoever filed it (checked by the service). */
  @Doc({ summary: 'Cancel (also after approval, unless the day is locked)', response: OvertimeRequestView })
  @Permission(ATTENDANCE.punch) @Post(':publicId/cancel') @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.cancel(ctx, publicId);
  }
}
