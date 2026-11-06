import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  AdjustTimeRequest, AllocationQuery, DailyUpdate, DailyUpdateRequest, DayAllocation, MissingUpdate, MissingUpdatesQuery, RunningTicket,
  TicketPunchInRequest, TicketPunchOutRequest, TicketPunchResult,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { TicketTimeService } from '../application/ticket-time.service';
import { MAX_TICKET_FILE_BYTES, TicketUpload } from '../application/ticket-work.service';
import { TICKETS } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
const SEE = [TICKETS.view, TICKETS.work, TICKETS.manage] as [string, ...string[]];
const WORK = [TICKETS.work, TICKETS.manage] as [string, ...string[]];

/**
 * Ticket time and daily updates. Only: validate input, check permission, call one use case. Listed before
 * TicketsController in the module, so these paths are matched before /tickets/:publicId.
 */
@Controller('tickets')
export class TicketTimeController {
  constructor(@Inject(TicketTimeService) private readonly time: TicketTimeService) {}

  @Doc({ summary: 'Ticket punch-in: start a timer on one or more of my tickets (one transaction)', response: TicketPunchResult, resend: true,
    description: 'Only while punched in for the day (409 TICKETS_NOT_PUNCHED_IN). The first punch-in moves an assigned ticket to in progress.' })
  @Permission(TICKETS.work) @Post('punch-in')
  async punchIn(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(TicketPunchInRequest)) body: TicketPunchInRequest, @Res({ passthrough: true }) res: Created) {
    const { result, created } = await this.time.punchIn(ctx, body);
    if (!created) res.status(200);
    return result;
  }

  @Doc({ summary: 'Ticket punch-out: stop my timers on some tickets, or all', response: TicketPunchResult })
  @Permission(TICKETS.work) @Post('punch-out') @HttpCode(200)
  punchOut(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(TicketPunchOutRequest)) body: TicketPunchOutRequest) {
    return this.time.punchOut(ctx, body);
  }

  @Doc({ summary: 'My running ticket timers', response: z.array(RunningTicket) })
  @Permission(TICKETS.work) @Get('time/running')
  running(@Ctx() ctx: RequestContext) {
    return this.time.running(ctx);
  }

  @Doc({ summary: 'A person\'s ticket time on one day: calculated, adjusted, timelogs, attendance', response: DayAllocation,
    description: 'The person themselves; heads and supervisors of their tickets that day; HR, admin user and Management.' })
  @Permission(...SEE) @Get('time/allocations')
  allocation(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(AllocationQuery)) q: AllocationQuery) {
    return this.time.allocation(ctx, q);
  }

  @Doc({ summary: 'Adjust a person\'s daily ticket time between tickets (reason required; never your own)', response: DayAllocation })
  @Permission(TICKETS.timeAdjust) @Post('time/adjustments')
  adjust(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(AdjustTimeRequest)) body: AdjustTimeRequest) {
    return this.time.adjust(ctx, body);
  }

  @Doc({ summary: 'Who worked on a ticket without its daily update (default: yesterday)', response: z.array(MissingUpdate),
    description: 'Heads: their departments. HR, admin user, Management: all. Others: themselves.' })
  @Permission(...SEE) @Get('daily-updates/missing')
  missing(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MissingUpdatesQuery)) q: MissingUpdatesQuery) {
    return this.time.missingUpdates(ctx, q);
  }

  @Doc({ summary: 'Add my daily update: note, percent complete, up to 5 photos or files (one per ticket per day)', response: DailyUpdate,
    resend: true, multipart: 'files' })
  @Permission(...WORK) @Post(':publicId/updates')
  @UseInterceptors(FilesInterceptor('files', 5, { limits: { fileSize: MAX_TICKET_FILE_BYTES, files: 5 } }))
  async addUpdate(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(DailyUpdateRequest)) body: DailyUpdateRequest, @UploadedFiles() files: TicketUpload[] | undefined,
    @Res({ passthrough: true }) res: Created) {
    const { update, created } = await this.time.addDailyUpdate(ctx, publicId, body, files ?? []);
    if (!created) res.status(200);
    return update;
  }

  @Doc({ summary: 'A ticket\'s daily updates, newest first', response: z.array(DailyUpdate) })
  @Permission(...SEE) @Get(':publicId/updates')
  updates(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.time.dailyUpdates(ctx, publicId);
  }
}
