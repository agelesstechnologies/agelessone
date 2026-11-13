import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import {
  IcBalanceQuery, IcBalanceReport, IcBilledReport, IcDashboard, IcDisputesReport, IcMarginReport, IcReceiverCostReport, IcReportQuery, IcUnbilledReport,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { respond } from '../../../platform/csv';
import { Ctx, Permission, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { IcReportsService } from '../application/reports.service';
import { INTERCOMPANY } from '../domain/permissions';

type Reply = { setHeader(k: string, v: string): void };
const ROWS = 'Rows of the agreements you see: the two company heads named on an agreement, or the CEO (scope all) for every one.';
const CEO = 'The CEO only (intercompany.view or manage, scope all); others 403.';

/** Intercompany reports (JSON, or CSV with format=csv) and the CEO's dashboard cards. */
@Controller('intercompany')
export class IcReportsController {
  constructor(@Inject(IcReportsService) private readonly reports: IcReportsService) {}

  @Doc({ summary: 'Billed hours and amounts: the lines of statements past draft', response: IcBilledReport, csv: true, description: ROWS })
  @SignedIn() @Get('reports/billed')
  async billed(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(IcReportQuery)) q: IcReportQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.billed(ctx, q);
    return respond(q.format, res, r, () => this.reports.billedCsv(r));
  }

  @Doc({ summary: 'Unbilled billable hours: ticket time in months with no statement past draft', response: IcUnbilledReport, csv: true, description: ROWS })
  @SignedIn() @Get('reports/unbilled')
  async unbilled(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(IcReportQuery)) q: IcReportQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.unbilled(ctx, q);
    return respond(q.format, res, r, () => this.reports.unbilledCsv(r));
  }

  @Doc({ summary: 'Disputed lines and how the provider answered', response: IcDisputesReport, csv: true, description: ROWS })
  @SignedIn() @Get('reports/disputes')
  async disputes(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(IcReportQuery)) q: IcReportQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.disputes(ctx, q);
    return respond(q.format, res, r, () => this.reports.disputesCsv(r));
  }

  @Doc({ summary: 'Margin: billed against cost (payroll cost of the hours, passed-on costs at cost)', response: IcMarginReport, csv: true, description: CEO })
  @Permission(INTERCOMPANY.view, INTERCOMPANY.manage) @Get('reports/margin')
  async margin(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(IcReportQuery)) q: IcReportQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.margin(ctx, q);
    return respond(q.format, res, r, () => this.reports.marginCsv(r));
  }

  @Doc({ summary: 'The receiver\'s cost by project: hours, labour, passed-on costs, credits', response: IcReceiverCostReport, csv: true, description: ROWS })
  @SignedIn() @Get('reports/receiver-cost')
  async receiverCost(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(IcReportQuery)) q: IcReportQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.receiverCost(ctx, q);
    return respond(q.format, res, r, () => this.reports.receiverCostCsv(r));
  }

  @Doc({ summary: 'Intercompany balance: invoices not yet paid, their due dates and days overdue; what each receiver owes each provider',
    response: IcBalanceReport, csv: true, description: ROWS })
  @SignedIn() @Get('reports/balance')
  async balance(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(IcBalanceQuery)) q: IcBalanceQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.balance(ctx, q);
    return respond(q.format, res, r, () => this.reports.balanceCsv(r));
  }

  @Doc({ summary: 'CEO dashboard cards: billed this month, unbilled hours, intercompany balance', response: IcDashboard, description: CEO })
  @Permission(INTERCOMPANY.view, INTERCOMPANY.manage) @Get('dashboard')
  dashboard(@Ctx() ctx: RequestContext) {
    return this.reports.dashboard(ctx);
  }
}
