import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import {
  AsOfQuery, HoursQuery, HoursReport, MissingUpdatesReport, MissingUpdatesReportQuery, OnHoldReport, OverdueReport, TicketDashboard,
  TicketDashboardQuery, UtilisationQuery, UtilisationReport, WeeklyQuery, WeeklyReport,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { respond } from '../../../platform/csv';
import { TicketReportsService } from '../application/ticket-reports.service';
import { TICKETS } from '../domain/permissions';

type Reply = { setHeader(k: string, v: string): void };
const SEE = [TICKETS.view, TICKETS.work, TICKETS.manage] as [string, ...string[]];
const WHO = 'Department heads: their departments. HR, admin user and Management: all. Others: 403 TICKETS_FORBIDDEN. Time is allocated time, never raw timer time.';

/** Ticket reports (JSON, or CSV with format=csv) and dashboard numbers. Listed before TicketsController in the module. */
@Controller('tickets')
export class TicketReportsController {
  constructor(@Inject(TicketReportsService) private readonly reports: TicketReportsService) {}

  @Doc({ summary: 'Ticket hours by ticket, type, person, department or customer', response: HoursReport, csv: true, description: WHO })
  @Permission(...SEE) @Get('reports/hours')
  async hours(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(HoursQuery)) q: HoursQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.hours(ctx, q);
    return respond(q.format, res, r, () => this.reports.hoursCsv(r));
  }

  @Doc({ summary: 'Utilisation and unallocated time per person (ticket hours / attendance hours)', response: UtilisationReport, csv: true,
    description: `${WHO} Heads see the people of their departments.` })
  @Permission(...SEE) @Get('reports/utilisation')
  async utilisation(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(UtilisationQuery)) q: UtilisationQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.utilisation(ctx, q);
    return respond(q.format, res, r, () => this.reports.utilisationCsv(r));
  }

  @Doc({ summary: 'Overdue tickets (as of today)', response: OverdueReport, csv: true, description: WHO })
  @Permission(...SEE) @Get('reports/overdue')
  async overdue(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(AsOfQuery)) q: AsOfQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.overdue(ctx, q);
    return respond(q.format, res, r, () => this.reports.overdueCsv(r));
  }

  @Doc({ summary: 'Tickets on hold, with reasons', response: OnHoldReport, csv: true, description: WHO })
  @Permission(...SEE) @Get('reports/on-hold')
  async onHold(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(AsOfQuery)) q: AsOfQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.onHold(ctx, q);
    return respond(q.format, res, r, () => this.reports.onHoldCsv(r));
  }

  @Doc({ summary: 'Tickets created vs completed per week, by type', response: WeeklyReport, csv: true, description: WHO })
  @Permission(...SEE) @Get('reports/weekly')
  async weekly(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(WeeklyQuery)) q: WeeklyQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.weekly(ctx, q);
    return respond(q.format, res, r, () => this.reports.weeklyCsv(r));
  }

  @Doc({ summary: 'Missing daily updates per person', response: MissingUpdatesReport, csv: true, description: WHO })
  @Permission(...SEE) @Get('reports/missing-updates')
  async missingUpdates(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MissingUpdatesReportQuery)) q: MissingUpdatesReportQuery,
    @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.missingUpdates(ctx, q);
    return respond(q.format, res, r, () => this.reports.missingUpdatesCsv(r));
  }

  @Doc({ summary: 'Dashboard numbers: open tickets by type and priority, overdue, completed this month vs last', response: TicketDashboard, description: WHO })
  @Permission(...SEE) @Get('dashboard')
  dashboard(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(TicketDashboardQuery)) q: TicketDashboardQuery) {
    return this.reports.dashboard(ctx, q);
  }
}
