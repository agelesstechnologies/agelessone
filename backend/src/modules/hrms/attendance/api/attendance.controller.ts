import { Body, Controller, Get, HttpCode, Inject, Post, Query, Res } from '@nestjs/common';
import { AttendanceHistoryQuery, AttendanceRegisterQuery, PunchRequest, RebuildWorkDaysRequest, WorkHoursQuery } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, Public, RequestContext } from '../../../../platform/http/request-context';
import { AttendanceService } from '../application/attendance.service';
import { ATTENDANCE } from '../domain/permissions';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/attendance')
export class AttendanceController {
  constructor(@Inject(AttendanceService) private readonly service: AttendanceService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  /** 201 for a new punch; 200 with the stored punch when the same publicId is sent again. */
  @Permission(ATTENDANCE.punch) @Post('punches')
  async punch(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(PunchRequest)) body: PunchRequest,
    @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { punch, created } = await this.service.punch(ctx, body);
    if (!created) res.status(200);
    return punch;
  }

  @Permission(ATTENDANCE.punch) @Get('today')
  today(@Ctx() ctx: RequestContext) {
    return this.service.today(ctx);
  }

  @Permission(ATTENDANCE.punch) @Get('history')
  history(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(AttendanceHistoryQuery)) q: AttendanceHistoryQuery) {
    return this.service.history(ctx, q);
  }

  @Permission(ATTENDANCE.view) @Get('register')
  register(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(AttendanceRegisterQuery)) q: AttendanceRegisterQuery) {
    return this.service.register(ctx, q);
  }

  @Permission(ATTENDANCE.view) @Get('work-hours')
  workHours(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(WorkHoursQuery)) q: WorkHoursQuery) {
    return this.service.workHours(ctx, q);
  }

  @Permission(ATTENDANCE.rebuild) @Post('rebuild') @HttpCode(200)
  rebuild(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(RebuildWorkDaysRequest)) body: RebuildWorkDaysRequest) {
    return this.service.rebuild(ctx, body);
  }
}
