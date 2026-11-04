import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { CreateCorrectionRequest, MyCorrectionsQuery, RejectCorrectionRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../../platform/http/request-context';
import { CorrectionsService } from '../application/corrections.service';
import { ATTENDANCE } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/attendance/corrections')
export class CorrectionsController {
  constructor(@Inject(CorrectionsService) private readonly service: CorrectionsService) {}

  /** 201 new; 200 with the stored correction when the same publicId is sent again. */
  @Permission(ATTENDANCE.punch) @Post()
  async request(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateCorrectionRequest)) body: CreateCorrectionRequest,
    @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { correction, created } = await this.service.request(ctx, body);
    if (!created) res.status(200);
    return correction;
  }

  @Permission(ATTENDANCE.punch) @Get('mine')
  mine(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MyCorrectionsQuery)) q: MyCorrectionsQuery) {
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
    @Body(new ZodValidationPipe(RejectCorrectionRequest)) body: RejectCorrectionRequest) {
    return this.service.reject(ctx, publicId, body);
  }

  /** The person or whoever filed it (checked by the service). */
  @Permission(ATTENDANCE.punch) @Post(':publicId/cancel') @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.cancel(ctx, publicId);
  }
}
