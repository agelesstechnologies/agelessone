import { Inject, Injectable } from '@nestjs/common';
import { ExternalAttendanceStatus } from '@ageless/shared';
import { DB, Db } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { renderReport, ReportDocument, ReportImages } from '../../../platform/report-pdf';
import { readUpload } from '../../../platform/storage';
import { TicketRow, TicketsRepository } from '../infrastructure/tickets.repository';
import { TicketTimeRepository } from '../infrastructure/ticket-time.repository';
import { attendanceMinutes } from '../domain/external-attendance';
import { canReport } from '../domain/ticket-access';
import { buildTicketReport, ReportFacts } from '../domain/ticket-report';
import { TicketsService } from './tickets.service';
import { TicketTimeService } from './ticket-time.service';

/**
 * The full report of one ticket as a PDF: everything in it (details, people, checklist, time, updates, files with the
 * photos, sign-off, links, outside workers and their attendance, history). For the department head, the Manager who
 * created or supervises the ticket (tickets.report), and Management for any ticket. Each download is logged in the
 * ticket's history (report_downloaded).
 */
@Injectable()
export class TicketFullReportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TicketsRepository) private readonly repo: TicketsRepository,
    @Inject(TicketTimeRepository) private readonly timeRepo: TicketTimeRepository,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(TicketTimeService) private readonly time: TicketTimeService,
  ) {}

  /** The PDF (`<number>-report.pdf`). Unknown or not visible: 404; visible but not managed by the caller: 403. */
  async pdf(ctx: RequestContext, publicId: string): Promise<{ name: string; data: Buffer }> {
    const { t, caller, rel } = await this.tickets.load(this.db, ctx, publicId, 'view');
    if (!canReport(caller, rel)) {
      throw new AppError('TICKETS_FORBIDDEN', 403, 'Only the department head, the Manager who created or supervises this ticket, or Management can download its full report');
    }
    const report = buildTicketReport(await this.facts(ctx, t));
    const data = await renderReport(report, await this.images(report));
    await this.db.transaction((tx) => this.tickets.event(tx, ctx.personId, t, 'report_downloaded'));
    return { name: `${t.number}-report.pdf`, data };
  }

  /** Everything in the ticket, read once. */
  private async facts(ctx: RequestContext, t: TicketRow): Promise<ReportFacts> {
    const ticket = await this.tickets.detail(this.db, ctx, t.id);
    const [company, assignments, files, workers, attendance, adjustments, timelogs, dailyUpdates, me] = await Promise.all([
      this.repo.company(this.db, t.legalEntityId), this.repo.assigneeHistory(this.db, t.id), this.repo.attachments(this.db, t.id),
      this.repo.externalStaff(this.db, t.id), this.repo.externalAttendance(this.db, t.id, 'all'), this.timeRepo.ticketAdjustments(this.db, t.id),
      this.time.ticketTimelogs(ctx, t.publicId), this.time.dailyUpdates(ctx, t.publicId), this.repo.personRefs(this.db, [ctx.personId]),
    ]);
    const people = ticket.typeRules.fields.filter((x) => x.type === 'person').map((x) => ticket.details[x.key]).filter((v): v is string => typeof v === 'string');
    const personNames = await this.repo.personNames(this.db, t.tenantId, people);
    const iso = (d: Date | null) => d?.toISOString() ?? null;
    return {
      company, ticket, generatedBy: me.get(ctx.personId)?.displayName ?? '?', generatedAt: new Date().toISOString(),
      assignments: assignments.map((a) => ({ employmentPublicId: a.employmentPublicId, employeeCode: a.employeeCode, personPublicId: a.personPublicId,
        personName: a.personName, isPrimary: a.isPrimary, assignedAt: a.assignedAt.toISOString(), assignedBy: a.assignerName, endedAt: iso(a.endedAt), endedBy: a.enderName })),
      timelogs,
      adjustments: adjustments.map((a) => ({ workDate: a.workDate, personPublicId: a.personPublicId, personName: a.personName, minutes: a.minutes, reason: a.reason,
        adjustedBy: a.byName, adjustedAs: a.adjustedAs, at: a.createdAt.toISOString() })),
      dailyUpdates,
      files: files.map((x) => ({ publicId: x.publicId, kind: x.kind, fileType: x.fileType, file: x.filePath, uploadedBy: x.byName, uploadedAt: x.uploadedAt.toISOString() })),
      workers: workers.map((w) => ({ publicId: w.publicId, name: w.name, phone: w.phone, agency: w.agency, trade: w.trade, fromDate: w.fromDate, toDate: w.toDate,
        photo: w.photoPath, addedBy: w.addedByName, addedAt: w.addedAt.toISOString() })),
      attendance: attendance.map((a) => ({ publicId: a.publicId, staff: { publicId: a.staffPublicId, name: a.staffName }, workDate: a.workDate,
        status: a.status as ExternalAttendanceStatus, timeIn: iso(a.timeIn), timeOut: iso(a.timeOut), minutes: attendanceMinutes(a.timeIn, a.timeOut), note: a.note,
        recordedBy: { publicId: a.recorderPublicId, displayName: a.recorderName }, recordedAt: a.recordedAt.toISOString(),
        updatedBy: a.updaterPublicId && a.updaterName !== null ? { publicId: a.updaterPublicId, displayName: a.updaterName } : null, updatedAt: iso(a.updatedAt) })),
      personNames: Object.fromEntries(personNames),
    };
  }

  /** The bytes of every picture the report shows, one file at a time; a file missing on disk is null ("file not found"). */
  private async images(report: ReportDocument): Promise<ReportImages> {
    const images: ReportImages = new Map();
    for (const s of report.sections) {
      for (const b of s.blocks) {
        if (b.kind !== 'image' || b.file === null || images.has(b.file)) continue;
        images.set(b.file, await readUpload(b.file).catch(() => null));
      }
    }
    return images;
  }
}
