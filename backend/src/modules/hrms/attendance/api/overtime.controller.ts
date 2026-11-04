import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { CreateOvertimeRequest, MyOvertimeQuery, RejectOvertimeRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../../platform/http/request-context';
import { OvertimeService } from '../application/overtime.service';
import { ATTENDANCE } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/attendance/overtime')
export class OvertimeController {
  constructor(@Inject(OvertimeService) private readonly service: OvertimeService) {}

  /** 201 new; 200 with the stored request when the same publicId is sent again. */
  @Permission(ATTENDANCE.punch) @Post()
  async request(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateOvertimeRequest)) body: CreateOvertimeRequest,
    @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { request, created } = await this.service.request(ctx, body);
    if (!created) res.status(200);
    return request;
  }

  @Permission(ATTENDANCE.punch) @Get('mine')
  mine(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MyOvertimeQuery)) q: MyOvertimeQuery) {
    return this.service.mine(ctx, q);
  }

  @Permission(ATTENDANCE.approve) @Get('to-approve')
  toApprove(@Ctx() ctx: RequestContext) {
    return this.service.toApprove(ctx);
  }

  @Permission(ATTENDANCE.approve) @Post(':publicId/approve') @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.approve(ctx, publicId);
  }

  @Permission(ATTENDANCE.approve) @Post(':publicId/reject') @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(RejectOvertimeRequest)) body: RejectOvertimeRequest) {
    return this.service.reject(ctx, publicId, body);
  }

  /** The person or whoever filed it (checked by the service). */
  @Permission(ATTENDANCE.punch) @Post(':publicId/cancel') @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.cancel(ctx, publicId);
  }
}
