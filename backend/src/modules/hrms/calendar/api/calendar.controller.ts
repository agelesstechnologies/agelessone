import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { CalendarQuery, CreateHolidayRequest, CreateWeeklyOffRequest, Holiday, HolidaysQuery, WeeklyOff, WeeklyOffsQuery, WorkCalendar } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, Public, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { CalendarService } from '../application/calendar.service';
import { CALENDAR } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Response = { status(code: number): void };

/** Only: validate input, check permission, call one use case. */
@Controller('hrms')
export class CalendarController {
  constructor(@Inject(CalendarService) private readonly service: CalendarService) {}
  @Public() @Get('calendar/health') health() { return this.service.health(); }

  /** Each date of one job: working, weekly_off or holiday. */
  @Doc({ summary: 'One job\'s days: working, weekly off or holiday (at most 366 days)', response: WorkCalendar })
  @Permission(CALENDAR.viewPeople) @Get('calendar')
  calendar(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(CalendarQuery)) q: CalendarQuery) {
    return this.service.calendar(ctx, q);
  }

  @Doc({ summary: 'Holidays of a year', response: z.array(Holiday) })
  @SignedIn() @Get('holidays')
  holidays(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(HolidaysQuery)) q: HolidaysQuery) {
    return this.service.holidays(ctx, q);
  }

  /** 201 new; 200 with the stored holiday when the same publicId is sent again. */
  @Doc({ summary: 'Add a holiday to a company\'s year (stored days are rebuilt)', response: Holiday, resend: true })
  @Permission(CALENDAR.manage) @Post('holidays')
  async addHoliday(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateHolidayRequest)) body: CreateHolidayRequest,
    @Res({ passthrough: true }) res: Response) {
    const { holiday, created } = await this.service.addHoliday(ctx, body);
    if (!created) res.status(200);
    return holiday;
  }

  @Doc({ summary: 'Remove a holiday still to come and not in an approved leave' })
  @Permission(CALENDAR.manage) @Delete('holidays/:publicId') @HttpCode(204)
  async deleteHoliday(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    await this.service.deleteHoliday(ctx, publicId);
  }

  @Doc({ summary: 'Weekly-off rules: company defaults and person overrides', response: z.array(WeeklyOff) })
  @Permission(CALENDAR.manage) @Get('weekly-offs')
  weeklyOffs(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(WeeklyOffsQuery)) q: WeeklyOffsQuery) {
    return this.service.weeklyOffs(ctx, q);
  }

  /** 201 new; 200 with the stored rule when the same publicId is sent again. */
  @Doc({ summary: 'Set a company\'s or a person\'s weekly off from a date', response: WeeklyOff, resend: true })
  @Permission(CALENDAR.manage) @Post('weekly-offs')
  async addWeeklyOff(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateWeeklyOffRequest)) body: CreateWeeklyOffRequest,
    @Res({ passthrough: true }) res: Response) {
    const { weeklyOff, created } = await this.service.addWeeklyOff(ctx, body);
    if (!created) res.status(200);
    return weeklyOff;
  }
}
