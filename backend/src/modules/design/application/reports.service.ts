import { Inject, Injectable } from '@nestjs/common';
import {
  AwaitingResponseReport, DesignHoursQuery, DesignHoursReport, DesignJobStatus, DesignQueueQuery, DrawingsReport, DrawingsReportQuery, QcByDisciplineQuery,
  QcByDisciplineReport, QcQueueReport, RevisionStage, RevisionStatus, TransmittalPurpose,
} from '@ageless/shared';
import { DB, Db } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { toCsv } from '../../../platform/csv';
import { todayIst } from '../../../platform/time';
import { DesignRepository } from '../infrastructure/design.repository';
import { DesignReportsRepository } from '../infrastructure/reports.repository';
import { PURPOSE_LABEL, Purpose } from '../domain/transmittals';
import { DesignAccess } from './access.service';

const DAY = 86_400_000;
const daysSince = (d: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - d.getTime()) / DAY));
type Csv = { name: string; body: string };

/**
 * Design reports of one company (JSON, or CSV with format=csv): drawings by job and status, revisions waiting for QC,
 * issued and awaiting the client's response, QC pass / fail by discipline, hours per design job from ticket time.
 * For those who see the company's design work (Designing head, Admin user, Design QC, design.view).
 */
@Injectable()
export class DesignReportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DesignRepository) private readonly repo: DesignRepository,
    @Inject(DesignReportsRepository) private readonly reports: DesignReportsRepository,
    @Inject(DesignAccess) private readonly access: DesignAccess,
  ) {}

  async drawings(ctx: RequestContext, q: DrawingsReportQuery): Promise<DrawingsReport> {
    const company = await this.company(ctx, q.company);
    const rows = await this.reports.drawings(this.db, company.id, { jobPublicId: q.job, discipline: q.discipline });
    const latest = new Map((await this.repo.latestRevisions(this.db, rows.map((r) => r.drawingId))).map((r) => [r.drawingId, r]));
    const out = rows.map((r) => {
      const rev = latest.get(r.drawingId);
      return { job: { publicId: r.jobPublicId, number: r.jobNumber }, customer: r.customer,
        drawing: { publicId: r.drawingPublicId, number: r.drawingNumber, title: r.title, discipline: r.discipline },
        revision: rev ? { publicId: rev.publicId, code: rev.code, stage: rev.stage as RevisionStage, status: rev.status as RevisionStatus } : null };
    }).filter((r) => !q.status || (r.revision?.status ?? 'no_revision') === q.status);
    const byStatus: Record<string, number> = {};
    for (const r of out) byStatus[r.revision?.status ?? 'no_revision'] = (byStatus[r.revision?.status ?? 'no_revision'] ?? 0) + 1;
    return { company: company.code, rows: out, byStatus };
  }

  drawingsCsv(r: DrawingsReport): Csv {
    return { name: `design-drawings-${r.company}.csv`, body: toCsv(about('Drawings by job and status', r.company),
      ['Design job', 'Client', 'Drawing', 'Title', 'Discipline', 'Revision', 'Stage', 'Status'],
      r.rows.map((x) => [x.job.number, x.customer, x.drawing.number, x.drawing.title, x.drawing.discipline, x.revision?.code ?? '', x.revision?.stage ?? '',
        x.revision?.status ?? 'no revision'])) };
  }

  async qcQueue(ctx: RequestContext, q: DesignQueueQuery): Promise<QcQueueReport> {
    const company = await this.company(ctx, q.company);
    const rows = await this.reports.revisionsIn(this.db, company.id, 'submitted');
    const people = await this.repo.persons(this.db, rows.map((r) => r.submittedBy));
    const now = new Date();
    return { company: company.code, asOf: now.toISOString(), rows: rows.map((r) => ({
      job: { publicId: r.jobPublicId, number: r.jobNumber }, drawing: { publicId: r.drawingPublicId, number: r.drawingNumber, title: r.title },
      revision: { publicId: r.revisionPublicId, code: r.code }, submittedBy: people.get(r.submittedBy!)!, submittedAt: r.submittedAt!.toISOString(),
      waitingDays: daysSince(r.submittedAt!, now) })) };
  }

  qcQueueCsv(r: QcQueueReport): Csv {
    return { name: `design-qc-queue-${r.company}.csv`, body: toCsv(about('Revisions waiting for QC', r.company),
      ['Design job', 'Drawing', 'Title', 'Revision', 'Submitted by', 'Submitted on', 'Days waiting'],
      r.rows.map((x) => [x.job.number, x.drawing.number, x.drawing.title, x.revision.code, x.submittedBy.displayName, todayIst(new Date(x.submittedAt)), x.waitingDays])) };
  }

  async awaitingResponse(ctx: RequestContext, q: DesignQueueQuery): Promise<AwaitingResponseReport> {
    const company = await this.company(ctx, q.company);
    const rows = await this.reports.awaitingResponse(this.db, company.id);
    const now = new Date();
    return { company: company.code, asOf: now.toISOString(), rows: rows.map((r) => ({
      job: { publicId: r.jobPublicId, number: r.jobNumber }, drawing: { publicId: r.drawingPublicId, number: r.drawingNumber, title: r.title },
      revision: { publicId: r.revisionPublicId, code: r.code },
      transmittal: { publicId: r.transmittalPublicId, number: r.transmittalNumber, purpose: r.purpose as TransmittalPurpose },
      recipient: r.recipient, issuedAt: r.issuedAt.toISOString(), waitingDays: daysSince(r.issuedAt, now) })) };
  }

  awaitingResponseCsv(r: AwaitingResponseReport): Csv {
    return { name: `design-awaiting-response-${r.company}.csv`, body: toCsv(about('Issued and awaiting the client\'s response', r.company),
      ['Design job', 'Drawing', 'Title', 'Revision', 'Transmittal', 'Purpose', 'Issued to', 'Issued on', 'Days waiting'],
      r.rows.map((x) => [x.job.number, x.drawing.number, x.drawing.title, x.revision.code, x.transmittal.number, PURPOSE_LABEL[x.transmittal.purpose as Purpose],
        x.recipient, todayIst(new Date(x.issuedAt)), x.waitingDays])) };
  }

  async qcByDiscipline(ctx: RequestContext, q: QcByDisciplineQuery): Promise<QcByDisciplineReport> {
    const company = await this.company(ctx, q.company);
    const counts = new Map<string, { approved: number; changesNeeded: number }>();
    for (const r of await this.reports.qcByDiscipline(this.db, company.id, q.from, q.to)) {
      const c = counts.get(r.discipline) ?? { approved: 0, changesNeeded: 0 };
      if (r.decision === 'approved') c.approved += Number(r.n); else c.changesNeeded += Number(r.n);
      counts.set(r.discipline, c);
    }
    return { company: company.code, from: q.from, to: q.to, rows: [...counts].map(([discipline, c]) => {
      const reviews = c.approved + c.changesNeeded;
      return { discipline, reviews, approved: c.approved, changesNeeded: c.changesNeeded, passPercent: Math.round((c.approved / reviews) * 1000) / 10 };
    }) };
  }

  qcByDisciplineCsv(r: QcByDisciplineReport): Csv {
    return { name: `design-qc-by-discipline-${r.company}-${r.from}-${r.to}.csv`, body: toCsv([...about('QC pass and fail by discipline', r.company), ['From', r.from], ['To', r.to]],
      ['Discipline', 'Reviews', 'Approved', 'Changes needed', 'Pass %'], r.rows.map((x) => [x.discipline, x.reviews, x.approved, x.changesNeeded, x.passPercent])) };
  }

  async hours(ctx: RequestContext, q: DesignHoursQuery): Promise<DesignHoursReport> {
    const company = await this.company(ctx, q.company);
    const jobs = await this.reports.jobs(this.db, company.id, q.job);
    const ids = jobs.map((j) => j.id);
    const [tickets, minutes] = await Promise.all([this.reports.ticketsPerJob(this.db, ids), this.reports.minutesPerJob(this.db, ids, q.from, q.to)]);
    const rows = jobs.map((j) => {
      const m = Math.max(0, minutes.get(j.id) ?? 0);
      return { job: { publicId: j.publicId, number: j.number }, customer: j.customer, status: j.status as DesignJobStatus, tickets: tickets.get(j.id) ?? 0,
        minutes: m, hours: Math.round((m / 60) * 100) / 100 };
    });
    return { company: company.code, from: q.from ?? null, to: q.to ?? null, rows, totalMinutes: rows.reduce((t, r) => t + r.minutes, 0) };
  }

  hoursCsv(r: DesignHoursReport): Csv {
    return { name: `design-hours-${r.company}.csv`, body: toCsv([...about('Hours per design job (ticket time)', r.company), ['From', r.from ?? 'start'], ['To', r.to ?? 'today']],
      ['Design job', 'Client', 'Status', 'Tickets', 'Hours'], r.rows.map((x) => [x.job.number, x.customer, x.status, x.tickets, x.hours])) };
  }

  private async company(ctx: RequestContext, code: string): Promise<{ id: number; code: string }> {
    const company = await this.access.company(ctx, code);
    if (!(await this.access.inCompany(ctx, company.id)).view) throw new AppError('DESIGN_FORBIDDEN', 403, `You do not see ${company.code}'s design work`);
    return company;
  }
}

const about = (report: string, company: string): [string, string][] => [['Report', report], ['Company', company], ['Produced', todayIst()]];
