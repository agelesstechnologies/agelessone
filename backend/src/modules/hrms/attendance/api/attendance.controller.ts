import { Body, Controller, Get, HttpCode, Inject, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { AttendanceHistoryQuery, AttendanceRegister, AttendanceRegisterQuery, HistoryRow, Punch, PunchRequest, RebuildResult, RebuildWorkDaysRequest, TodayAttendance, WorkHours, WorkHoursQuery } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { respond } from '../../../../platform/csv';
import { Ctx, Permission, Public, RequestContext } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { AttendanceService } from '../application/attendance.service';
import { ATTENDANCE } from '../domain/permissions';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/attendance')
export class AttendanceController {
  constructor(@Inject(AttendanceService) private readonly service: AttendanceService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  /** 201 for a new punch; 200 with the stored punch when the same publicId is sent again. */
  @Doc({ summary: 'Punch in or out on one of your jobs', response: Punch, resend: true, description: 'In and out alternate per person across all jobs (HRMS_PUNCH_ORDER). A punch-in after a forgotten punch-out first closes it 8 hours after its punch-in (policy). Refused in a locked month (HRMS_MONTH_LOCKED).' })
  @Permission(ATTENDANCE.punch) @Post('punches')
  async punch(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(PunchRequest)) body: PunchRequest,
    @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { punch, created } = await this.service.punch(ctx, body);
    if (!created) res.status(200);
    return punch;
  }

  @Doc({ summary: 'Am I punched in, since when, minutes today, last missed-punch day', response: TodayAttendance })
  @Permission(ATTENDANCE.punch) @Get('today')
  today(@Ctx() ctx: RequestContext) {
    return this.service.today(ctx);
  }

  @Doc({ summary: 'My work days with their punches (at most 93 days); today is live', response: z.array(HistoryRow) })
  @Permission(ATTENDANCE.punch) @Get('history')
  history(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(AttendanceHistoryQuery)) q: AttendanceHistoryQuery) {
    return this.service.history(ctx, q);
  }

  @Doc({ summary: 'Everyone\'s day on one date (team or all)', response: AttendanceRegister })
  @Permission(ATTENDANCE.view) @Get('register')
  register(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(AttendanceRegisterQuery)) q: AttendanceRegisterQuery) {
    return this.service.register(ctx, q);
  }

  @Doc({ summary: 'Work hours per job over a period: days, leave, absence, worked / extra / approved overtime', response: WorkHours, csv: true })
  @Permission(ATTENDANCE.view) @Get('work-hours')
  async workHours(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(WorkHoursQuery)) q: WorkHoursQuery,
    @Res({ passthrough: true }) res: { setHeader(k: string, v: string): void }) {
    const report = await this.service.workHours(ctx, q);
    return respond(q.format, res, report, () => this.service.workHoursCsv(report));
  }

  @Doc({ summary: 'Recalculate stored work days from punches (locked days skipped)', response: RebuildResult })
  @Permission(ATTENDANCE.rebuild) @Post('rebuild') @HttpCode(200)
  rebuild(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(RebuildWorkDaysRequest)) body: RebuildWorkDaysRequest) {
    return this.service.rebuild(ctx, body);
  }
}
