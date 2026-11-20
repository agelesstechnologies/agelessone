import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import {
  AwaitingResponseReport, DesignHoursQuery, DesignHoursReport, DesignQueueQuery, DrawingsReport, DrawingsReportQuery, QcByDisciplineQuery, QcByDisciplineReport, QcQueueReport,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { respond } from '../../../platform/csv';
import { Ctx, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { DesignReportsService } from '../application/reports.service';

type Reply = { setHeader(k: string, v: string): void };
const WHO = 'Those who see the company\'s design work: the Designing head, Admin users, Design QC, design.view (others 403).';

/** Design reports: JSON, or CSV with format=csv. */
@Controller('design/reports')
export class DesignReportsController {
  constructor(@Inject(DesignReportsService) private readonly reports: DesignReportsService) {}

  @Doc({ summary: 'Drawings by job and status (each drawing\'s current revision)', response: DrawingsReport, csv: true, description: WHO })
  @SignedIn() @Get('drawings')
  async drawings(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DrawingsReportQuery)) q: DrawingsReportQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.drawings(ctx, q);
    return respond(q.format, res, r, () => this.reports.drawingsCsv(r));
  }

  @Doc({ summary: 'Revisions waiting for QC, oldest first, with days waiting', response: QcQueueReport, csv: true, description: WHO })
  @SignedIn() @Get('qc-queue')
  async qcQueue(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DesignQueueQuery)) q: DesignQueueQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.qcQueue(ctx, q);
    return respond(q.format, res, r, () => this.reports.qcQueueCsv(r));
  }

  @Doc({ summary: 'Issued revisions awaiting the client\'s response, with days waiting', response: AwaitingResponseReport, csv: true, description: WHO })
  @SignedIn() @Get('awaiting-response')
  async awaitingResponse(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DesignQueueQuery)) q: DesignQueueQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.awaitingResponse(ctx, q);
    return respond(q.format, res, r, () => this.reports.awaitingResponseCsv(r));
  }

  @Doc({ summary: 'QC pass and fail by discipline between two dates', response: QcByDisciplineReport, csv: true, description: WHO })
  @SignedIn() @Get('qc-by-discipline')
  async qcByDiscipline(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(QcByDisciplineQuery)) q: QcByDisciplineQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.qcByDiscipline(ctx, q);
    return respond(q.format, res, r, () => this.reports.qcByDisciplineCsv(r));
  }

  @Doc({ summary: 'Hours per design job: the ticket time of its tickets (allocations plus the heads\' adjustments)', response: DesignHoursReport, csv: true, description: WHO })
  @SignedIn() @Get('hours')
  async hours(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DesignHoursQuery)) q: DesignHoursQuery, @Res({ passthrough: true }) res: Reply) {
    const r = await this.reports.hours(ctx, q);
    return respond(q.format, res, r, () => this.reports.hoursCsv(r));
  }
}
