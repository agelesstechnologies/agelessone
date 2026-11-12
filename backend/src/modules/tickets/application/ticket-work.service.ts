import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AddExternalStaffRequest, ApproveReassignRequest, ChecklistResultRequest, EndExternalStaffRequest, ExternalAttendance, ExternalAttendanceQuery,
  ExternalAttendanceStatus, ExternalStaff, LinkTicketRequest, ReassignmentRequest, ReassignRequestsQuery, RecordExternalAttendanceRequest, SignoffRequest,
  TicketDetail,
} from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { isManagement, RequestContext } from '../../../platform/http/request-context';
import { CONTENT_TYPES, detectDocumentType, discardUpload, DocumentType, readUpload, saveUpload } from '../../../platform/storage';
import { todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { TicketsRepository } from '../infrastructure/tickets.repository';
import {
  ATTENDANCE_MAX_DAYS, attendanceDateProblem, attendanceMinutes, attendanceRange, AttendanceDateProblem, istClock, sameAttendance,
} from '../domain/external-attendance';
import { canRecordExternalAttendance } from '../domain/ticket-access';
import { Loaded, TicketsService, toReassign, Warning } from './tickets.service';

/** The uploaded file as the multipart parser hands it over (kept in memory, at most MAX_TICKET_FILE_BYTES). */
export interface TicketUpload { buffer: Buffer; size: number }
export const MAX_TICKET_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Work done on a ticket: checklist answers, photos and files, the customer's sign-off, daily updates, the head's
 * approval, links between tickets, and reassignment requests. Every change writes a timeline event.
 */
@Injectable()
export class TicketWorkService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TicketsRepository) private readonly repo: TicketsRepository,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /** An answer for one item of the type version's checklist; answering again adds a newer answer. */
  async checklist(ctx: RequestContext, publicId: string, req: ChecklistResultRequest): Promise<TicketDetail> {
    return this.db.transaction(async (tx) => {
      const { t } = await this.tickets.load(tx, ctx, publicId, 'work', true);
      this.tickets.requireUnfinished(t);
      const type = await this.repo.typeVersion(tx, t.typeId);
      if (!(type.checklistItems as string[]).includes(req.item)) {
        throw new AppError('TICKETS_UNKNOWN_CHECKLIST_ITEM', 400, `"${req.item}" is not on this ticket's checklist`, { items: type.checklistItems });
      }
      await this.repo.insertChecklist(tx, { tenantId: t.tenantId, ticketId: t.id, legalEntityId: t.legalEntityId, item: req.item, result: req.result,
        note: req.note ?? null, checkedBy: ctx.personId });
      await this.tickets.event(tx, ctx.personId, t, 'checklist_answered', { item: req.item, result: req.result });
      return this.tickets.detail(tx, ctx, t.id);
    });
  }

  /** A photo (JPEG or PNG) or file (also PDF), told apart by its bytes. */
  async attach(ctx: RequestContext, publicId: string, kind: 'photo' | 'file', file: TicketUpload | undefined): Promise<TicketDetail> {
    const type = this.fileType(file, kind === 'photo' ? ['jpg', 'png'] : ['jpg', 'png', 'pdf']);
    // check access before writing anything to disk
    const { t: before } = await this.tickets.load(this.db, ctx, publicId, 'work');
    this.tickets.requireUnfinished(before);
    const path = await saveUpload('tickets', type, file!.buffer);
    try {
      return await this.db.transaction(async (tx) => {
        const { t } = await this.tickets.load(tx, ctx, publicId, 'work', true);
        this.tickets.requireUnfinished(t);
        const a = await this.repo.insertAttachment(tx, { tenantId: t.tenantId, ticketId: t.id, legalEntityId: t.legalEntityId, kind, filePath: path,
          fileType: type, uploadedBy: ctx.personId });
        await this.tickets.event(tx, ctx.personId, t, 'attachment_added', { kind, attachment: a.publicId });
        return this.tickets.detail(tx, ctx, t.id);
      });
    } catch (err) {
      await discardUpload(path);
      throw err;
    }
  }

  /** The customer's sign-off: signer's name (and role) plus a photo of the signed sheet, saved together. */
  async signoff(ctx: RequestContext, publicId: string, req: SignoffRequest, photo: TicketUpload | undefined): Promise<TicketDetail> {
    if (!photo) throw new AppError('TICKETS_PHOTO_REQUIRED', 400, 'Attach a photo of the signed sheet (field photo)');
    const type = this.fileType(photo, ['jpg', 'png']);
    const { t: before } = await this.tickets.load(this.db, ctx, publicId, 'work');
    this.tickets.requireUnfinished(before);
    const path = await saveUpload('tickets', type, photo.buffer);
    try {
      return await this.db.transaction(async (tx) => {
        const { t } = await this.tickets.load(tx, ctx, publicId, 'work', true);
        this.tickets.requireUnfinished(t);
        const a = await this.repo.insertAttachment(tx, { tenantId: t.tenantId, ticketId: t.id, legalEntityId: t.legalEntityId, kind: 'signoff',
          filePath: path, fileType: type, uploadedBy: ctx.personId });
        await this.repo.insertSignoff(tx, { tenantId: t.tenantId, ticketId: t.id, legalEntityId: t.legalEntityId, signerName: req.signerName,
          signerRole: req.signerRole ?? null, signedAt: req.signedAt ? new Date(req.signedAt) : new Date(), photoAttachmentId: a.id, recordedBy: ctx.personId });
        await this.tickets.event(tx, ctx.personId, t, 'signoff_added', { signerName: req.signerName, photo: a.publicId });
        return this.tickets.detail(tx, ctx, t.id);
      });
    } catch (err) {
      await discardUpload(path);
      throw err;
    }
  }

  /** The bytes of an attachment, for anyone who may see the ticket. */
  async download(ctx: RequestContext, publicId: string, attachmentPublicId: string): Promise<{ type: string; name: string; data: Buffer }> {
    const { t } = await this.tickets.load(this.db, ctx, publicId, 'view');
    const a = (await this.repo.attachments(this.db, t.id)).find((x) => x.publicId === attachmentPublicId);
    if (!a) throw new AppError('TICKETS_ATTACHMENT_NOT_FOUND', 404, 'This file is not attached to the ticket (it may have been replaced).');
    return { type: CONTENT_TYPES[a.fileType as DocumentType], name: `${t.number}-${a.kind}.${a.fileType}`, data: await readUpload(a.filePath) };
  }

  /**
   * The department head's approval (head_approval_required): the head of the ticket's department, its supervisor, or
   * Management — never someone assigned to the ticket (nobody approves their own work).
   */
  async headApprove(ctx: RequestContext, publicId: string): Promise<TicketDetail> {
    return this.db.transaction(async (tx) => {
      const { t, rel, caller } = await this.tickets.load(tx, ctx, publicId, 'view', true);
      if (!caller.management && !((rel.headsDepartment || rel.supervises) && caller.manage !== undefined)) {
        throw new AppError('TICKETS_FORBIDDEN', 403, 'Only the department head, the supervisor or Management approves a ticket');
      }
      if (rel.assignee) throw new AppError('TICKETS_SELF_APPROVAL', 403, 'You are assigned to this ticket: someone else must approve it');
      this.tickets.requireUnfinished(t);
      if (t.headApprovedAt === null) {
        await this.repo.updateTicket(tx, t.id, { headApprovedBy: ctx.personId, headApprovedAt: new Date() });
        await this.tickets.event(tx, ctx.personId, t, 'head_approved');
      }
      return this.tickets.detail(tx, ctx, t.id);
    });
  }

  /**
   * This ticket follows (or is rework of) another of the same company; `follows` also needs the same project (both
   * without a project counts as the same, until projects exist).
   */
  async link(ctx: RequestContext, publicId: string, req: LinkTicketRequest): Promise<TicketDetail> {
    try {
      return await this.db.transaction(async (tx) => {
        const { t } = await this.tickets.load(tx, ctx, publicId, 'manage', true);
        const to = await this.repo.findTicket(tx, ctx.tenantId, req.toTicketPublicId);
        if (!to) throw new AppError('TICKETS_NOT_FOUND', 404, 'Unknown ticket to link to');
        if (to.id === t.id) throw new AppError('TICKETS_LINK_SELF', 400, 'A ticket cannot be linked to itself');
        if (to.legalEntityId !== t.legalEntityId) throw new AppError('TICKETS_LINK_OTHER_COMPANY', 400, 'Linked tickets must belong to the same company');
        if (req.kind === 'follows' && to.projectId !== t.projectId) throw new AppError('TICKETS_LINK_OTHER_PROJECT', 400, 'A ticket follows only a ticket of the same project');
        await this.repo.insertLink(tx, { tenantId: t.tenantId, fromTicketId: t.id, toTicketId: to.id, legalEntityId: t.legalEntityId, kind: req.kind, createdBy: ctx.personId });
        await this.tickets.event(tx, ctx.personId, t, 'linked', { kind: req.kind, to: to.number });
        await this.tickets.event(tx, ctx.personId, to, 'linked', { kind: req.kind, from: t.number });
        return this.tickets.detail(tx, ctx, t.id);
      });
    } catch (err) {
      if (violatedConstraint(err) === 'ticket_links_unique') throw new AppError('TICKETS_DUPLICATE_LINK', 409, 'These tickets are already linked that way');
      throw err;
    }
  }

  // ---- reassignment ----

  /**
   * An assignee asks to be taken off the ticket. The ticket's supervisor decides; when the supervisor is the one asking,
   * the next approver (their manager, department head, HR, CEO — never themselves) does.
   */
  async requestReassign(ctx: RequestContext, publicId: string, reason: string): Promise<TicketDetail> {
    try {
      return await this.db.transaction(async (tx) => {
        const { t } = await this.tickets.load(tx, ctx, publicId, 'view', true);
        this.tickets.requireUnfinished(t);
        const mine = (await this.repo.currentAssignees(tx, t.id)).find((a) => a.personId === ctx.personId);
        if (!mine) throw new AppError('TICKETS_NOT_ASSIGNEE', 403, 'Only an assignee of this ticket can ask to be reassigned');
        let approverId: number | null = t.supervisorPersonId;
        if (approverId === ctx.personId) {
          const job = (await this.repo.employmentById(tx, mine.employmentId))!;
          approverId = await this.core.approverFor(ctx.tenantId, [ctx.personId],
            { managerId: job.managerPersonId, departmentHeadId: await this.repo.departmentHead(tx, job.departmentId) });
        }
        const requestId = await this.repo.insertReassign(tx, { tenantId: t.tenantId, ticketId: t.id, legalEntityId: t.legalEntityId,
          fromEmploymentId: mine.employmentId, requestedBy: ctx.personId, reason, approverPersonId: approverId });
        await this.tickets.event(tx, ctx.personId, t, 'reassign_requested', { request: requestId, reason });
        return this.tickets.detail(tx, ctx, t.id);
      });
    } catch (err) {
      if (violatedConstraint(err) === 'reassign_requests_one_pending') throw new AppError('TICKETS_REASSIGN_PENDING', 409, 'You already asked to be reassigned on this ticket');
      throw err;
    }
  }

  /** Requests I decide (Management: every pending one). */
  async reassignRequests(ctx: RequestContext, q: ReassignRequestsQuery): Promise<ReassignmentRequest[]> {
    const rows = await this.repo.reassignRequests(this.db, ctx.tenantId, { approverId: isManagement(ctx) ? null : ctx.personId, status: q.status });
    return rows.map(toReassign);
  }

  /**
   * The approver (or Management) picks who takes over. The new person must be a valid assignee (same company, active,
   * not on leave on the scheduled date); a missing skill is a warning. An approver never picks themselves — only
   * Management may. The new person takes the asker's place (primary if the asker was).
   */
  async approveReassign(ctx: RequestContext, requestPublicId: string, req: ApproveReassignRequest): Promise<TicketDetail> {
    let warnings: Warning[] = [];
    const id = await this.db.transaction(async (tx) => {
      const { r, t, as } = await this.decidable(tx, ctx, requestPublicId);
      const current = await this.repo.currentAssignees(tx, t.id);
      const leaving = current.find((a) => a.employmentId === r.fromEmploymentId);
      const job = await this.repo.findEmployment(tx, ctx.tenantId, req.newEmploymentPublicId);
      if (job && job.personId === ctx.personId && !isManagement(ctx)) {
        throw new AppError('TICKETS_SELF_REASSIGN', 403, 'You cannot reassign a ticket to yourself; ask Management');
      }
      if (job && current.some((a) => a.employmentId === job.id)) throw new AppError('TICKETS_ALREADY_ASSIGNED', 409, 'That person is already on this ticket');
      const planned = await this.tickets.prepareAssignees(ctx, t, [{ employmentPublicId: req.newEmploymentPublicId, isPrimary: true }], new Set(), tx);
      warnings = planned.warnings;
      const replacement = { ...planned.rows[0], isPrimary: leaving?.isPrimary ?? false };
      const rows = current.filter((a) => a.employmentId !== r.fromEmploymentId)
        .map((a) => ({ employmentId: a.employmentId, employmentPublicId: a.employmentPublicId, personId: a.personId, isPrimary: a.isPrimary }));
      rows.push(replacement);
      if (!rows.some((x) => x.isPrimary)) rows[0].isPrimary = true;
      await this.repo.decideReassign(tx, r.id, { status: 'approved', newEmploymentId: replacement.employmentId, decidedBy: ctx.personId, decidedAs: as, decidedAt: new Date() });
      await this.tickets.applyAssignees(tx, ctx.personId, t, rows);
      await this.tickets.event(tx, ctx.personId, t, 'reassign_approved', { request: r.publicId, to: replacement.employmentPublicId, decidedAs: as });
      return t.id;
    });
    return this.tickets.detail(this.db, ctx, id, warnings);
  }

  async rejectReassign(ctx: RequestContext, requestPublicId: string, reason: string): Promise<TicketDetail> {
    return this.db.transaction(async (tx) => {
      const { r, t, as } = await this.decidable(tx, ctx, requestPublicId);
      await this.repo.decideReassign(tx, r.id, { status: 'rejected', decidedBy: ctx.personId, decidedAs: as, decidedAt: new Date(), decisionReason: reason });
      await this.tickets.event(tx, ctx.personId, t, 'reassign_rejected', { request: r.publicId, reason });
      return this.tickets.detail(tx, ctx, t.id);
    });
  }

  // ---- helpers ----

  /** A pending request the caller may decide: its approver, or Management; never the person who asked. */
  private async decidable(tx: Tx, ctx: RequestContext, publicId: string) {
    const r = await this.repo.findReassign(tx, ctx.tenantId, publicId);
    if (!r) throw new AppError('TICKETS_REASSIGN_NOT_FOUND', 404, 'Unknown reassignment request');
    if (r.requestedBy === ctx.personId) throw new AppError('TICKETS_SELF_APPROVAL', 403, 'Nobody decides their own request');
    const named = r.approverPersonId === ctx.personId;
    if (!named && !isManagement(ctx)) throw new AppError('TICKETS_FORBIDDEN', 403, 'Only the named approver or Management decides this request');
    if (r.status !== 'pending') throw new AppError('TICKETS_REASSIGN_DECIDED', 409, `This request is already ${r.status}`);
    const t = await this.repo.ticketById(tx, r.ticketId);
    this.tickets.requireUnfinished(t);
    return { r, t, as: (named ? 'approver' : 'management') as 'approver' | 'management' };
  }

  // ---- external staff (outside workers on the ticket) ----

  /** The ticket's outside workers (anyone who may see the ticket), with whether the caller may record their attendance. */
  async externalStaff(ctx: RequestContext, publicId: string): Promise<ExternalStaff[]> {
    const loaded = await this.tickets.load(this.db, ctx, publicId, 'view');
    return (await this.repo.externalStaff(this.db, loaded.t.id))
      .map((r) => toExternal(r, loaded.t.status !== 'cancelled' && this.mayRecordAttendance(ctx, loaded, r)));
  }

  /**
   * Add an outside worker: the on-site supervisor, a manager or the department head; an optional photo (JPEG, PNG).
   * Sent twice with the same publicId: stored once. Not on a finished ticket.
   */
  async addExternalStaff(ctx: RequestContext, publicId: string, req: AddExternalStaffRequest, photo: TicketUpload | undefined): Promise<ExternalStaff[]> {
    const id = req.publicId ?? randomUUID();
    if (req.publicId) {
      const tenant = await this.repo.externalStaffTenant(req.publicId);
      if (tenant === ctx.tenantId) return this.externalStaff(ctx, publicId);
      if (tenant !== undefined) throw new AppError('TICKETS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const type = photo ? this.fileType(photo, ['jpg', 'png']) : undefined;
    const { t: before } = await this.tickets.load(this.db, ctx, publicId, 'site');
    this.tickets.requireUnfinished(before);
    const path = photo && type ? await saveUpload('tickets', type, photo.buffer) : undefined;
    try {
      await this.db.transaction(async (tx) => {
        const { t } = await this.tickets.load(tx, ctx, publicId, 'site', true);
        await this.repo.insertExternalStaff(tx, {
          tenantId: t.tenantId, publicId: id, ticketId: t.id, legalEntityId: t.legalEntityId, name: req.name, phone: req.phone ?? null,
          agency: req.agency ?? null, trade: req.trade ?? null, fromDate: req.fromDate, toDate: req.toDate ?? null,
          photoPath: path ?? null, photoType: path ? type! : null, addedBy: ctx.personId,
        });
        await this.tickets.event(tx, ctx.personId, t, 'external_staff_added', { externalStaff: id });
      });
    } catch (err) {
      if (path) await discardUpload(path);
      throw err;
    }
    return this.externalStaff(ctx, publicId);
  }

  /** Their last day on site. */
  async endExternalStaff(ctx: RequestContext, publicId: string, staffPublicId: string, req: EndExternalStaffRequest): Promise<ExternalStaff[]> {
    await this.db.transaction(async (tx) => {
      const { t } = await this.tickets.load(tx, ctx, publicId, 'site', true);
      const row = (await this.repo.externalStaff(tx, t.id)).find((x) => x.publicId === staffPublicId);
      if (!row) throw new AppError('TICKETS_EXTERNAL_STAFF_NOT_FOUND', 404, 'Unknown external staff');
      if (req.toDate < row.fromDate) throw new AppError('TICKETS_EXTERNAL_STAFF_DATES', 400, 'The last day is before the first');
      await this.repo.endExternalStaff(tx, row.id, req.toDate);
      await this.tickets.event(tx, ctx.personId, t, 'external_staff_ended', { externalStaff: staffPublicId, toDate: req.toDate });
    });
    return this.externalStaff(ctx, publicId);
  }

  // ---- their daily attendance ----

  /** The outside workers' attendance on this ticket between two dates (default the last 31 days): anyone who may see the ticket. */
  async externalAttendance(ctx: RequestContext, publicId: string, q: ExternalAttendanceQuery): Promise<ExternalAttendance[]> {
    const { t } = await this.tickets.load(this.db, ctx, publicId, 'view');
    const range = attendanceRange(q, todayIst());
    if (!range) throw new AppError('TICKETS_EXTERNAL_ATTENDANCE_RANGE', 400, `Ask for at most ${ATTENDANCE_MAX_DAYS} days at a time, with from before to`);
    return (await this.repo.externalAttendance(this.db, t.id, range)).map(toAttendance);
  }

  /**
   * Record one outside worker's attendance for one work date, or correct the day already recorded. Who: the person who
   * added the worker while they still run this ticket's site work, or the ticket's managers and Management. Which days:
   * within the worker's days on site, not after today, at most tickets.external_attendance.backdate_days (policy) back;
   * not on a cancelled ticket (a completed one is fine, so the last day can be filled in). The same day sent again
   * unchanged (a resend) is stored once; a change logs the previous values in the ticket's timeline.
   */
  async recordExternalAttendance(ctx: RequestContext, publicId: string, staffPublicId: string, req: RecordExternalAttendanceRequest): Promise<ExternalAttendance> {
    try {
      const { ticketId, id } = await this.db.transaction(async (tx) => {
        const loaded = await this.tickets.load(tx, ctx, publicId, 'view', true);
        const { t } = loaded;
        const worker = (await this.repo.externalStaff(tx, t.id)).find((x) => x.publicId === staffPublicId);
        if (!worker) throw new AppError('TICKETS_EXTERNAL_STAFF_NOT_FOUND', 404, 'Unknown external staff on this ticket');
        const used = await this.repo.externalAttendanceByPublicId(tx, req.publicId);
        if (used && (used.tenantId !== ctx.tenantId || used.externalStaffId !== worker.id || used.workDate !== req.workDate)) {
          throw new AppError('TICKETS_DUPLICATE_ID', 409, 'This publicId is already used for another attendance record');
        }
        if (!this.mayRecordAttendance(ctx, loaded, worker)) {
          throw new AppError('TICKETS_FORBIDDEN', 403, "Only the person who added this worker, or the ticket's manager, can record their attendance");
        }
        const values = { status: req.status, timeIn: req.timeIn ? istClock(req.workDate, req.timeIn) : null,
          timeOut: req.timeOut ? istClock(req.workDate, req.timeOut) : null, note: req.note ?? null };
        const day = await this.repo.externalAttendanceDay(tx, worker.id, req.workDate);
        if (day && sameAttendance(day, values)) return { ticketId: t.id, id: day.id };     // sent again: nothing changes
        if (t.status === 'cancelled') {
          throw new AppError('TICKETS_EXTERNAL_ATTENDANCE_TICKET_CANCELLED', 409, `Ticket ${t.number} is cancelled: attendance can no longer be recorded`);
        }
        const today = todayIst();
        const backdateDays = await this.core.getPolicy(ctx.tenantId, 'tickets.external_attendance.backdate_days', t.legalEntityId, today);
        const problem = attendanceDateProblem(req.workDate, worker, today, backdateDays);
        if (problem) throw new AppError(`TICKETS_EXTERNAL_ATTENDANCE_${problem}`, 400, dateMessage(problem, worker, backdateDays));
        const shown = (v: { status: string; timeIn: Date | null; timeOut: Date | null }) =>
          ({ status: v.status, timeIn: v.timeIn?.toISOString() ?? null, timeOut: v.timeOut?.toISOString() ?? null });
        if (day) {
          await this.repo.updateExternalAttendance(tx, day.id, { ...values, updatedBy: ctx.personId, updatedAt: new Date() });
          await this.tickets.event(tx, ctx.personId, t, 'external_attendance_changed',
            { externalStaff: worker.publicId, attendance: day.publicId, workDate: req.workDate, from: shown(day), to: shown(values) });
          return { ticketId: t.id, id: day.id };
        }
        const newId = await this.repo.insertExternalAttendance(tx, { tenantId: t.tenantId, publicId: req.publicId, ticketId: t.id,
          legalEntityId: t.legalEntityId, externalStaffId: worker.id, workDate: req.workDate, ...values, recordedBy: ctx.personId });
        await this.tickets.event(tx, ctx.personId, t, 'external_attendance_recorded',
          { externalStaff: worker.publicId, attendance: req.publicId, workDate: req.workDate, ...shown(values) });
        return { ticketId: t.id, id: newId };
      });
      return toAttendance((await this.repo.externalAttendance(this.db, ticketId, { id }))[0]);
    } catch (err) {
      const c = violatedConstraint(err);
      if (c === 'ticket_external_attendance_public_id_unique') throw new AppError('TICKETS_DUPLICATE_ID', 409, 'This publicId is already used for another attendance record');
      if (c === 'ticket_external_attendance_one_per_day') throw new AppError('TICKETS_EXTERNAL_ATTENDANCE_CONFLICT', 409, 'This day was just recorded by someone else: reload and try again');
      throw err;
    }
  }

  /** The person who added the worker while they still run the site work, or the ticket's managers (see ticket-access). */
  private mayRecordAttendance(ctx: RequestContext, { caller, rel }: Loaded, worker: { addedById: number }): boolean {
    return canRecordExternalAttendance(caller, rel, worker.addedById === ctx.personId);
  }

  async externalStaffPhoto(ctx: RequestContext, publicId: string, staffPublicId: string): Promise<{ type: string; name: string; data: Buffer }> {
    const { t } = await this.tickets.load(this.db, ctx, publicId, 'view');
    const row = (await this.repo.externalStaff(this.db, t.id)).find((x) => x.publicId === staffPublicId);
    if (!row?.photoPath) throw new AppError('TICKETS_EXTERNAL_STAFF_NOT_FOUND', 404, 'No photo was added for this worker.');
    return { type: CONTENT_TYPES[row.photoType as DocumentType], name: `${t.number}-external-${row.name.replace(/[^A-Za-z0-9]+/g, '-')}.${row.photoType}`,
      data: await readUpload(row.photoPath) };
  }

  private fileType(file: TicketUpload | undefined, allowed: DocumentType[]): DocumentType {
    if (!file) throw new AppError('TICKETS_FILE_REQUIRED', 400, 'Attach the file (field file)');
    const type = detectDocumentType(file.buffer);
    if (!type || !allowed.includes(type)) throw new AppError('TICKETS_FILE_TYPE', 400, `Only ${allowed.join(', ').toUpperCase()} files are accepted here`);
    return type;
  }
}

type ExternalRow = Awaited<ReturnType<TicketsRepository['externalStaff']>>[number];
function toExternal(r: ExternalRow, canRecordAttendance: boolean): ExternalStaff {
  return {
    publicId: r.publicId, name: r.name, phone: r.phone, agency: r.agency, trade: r.trade, fromDate: r.fromDate, toDate: r.toDate,
    hasPhoto: r.photoPath !== null, addedBy: { publicId: r.addedByPublicId, displayName: r.addedByName }, addedAt: r.addedAt.toISOString(),
    canRecordAttendance,
  };
}

type AttendanceRow = Awaited<ReturnType<TicketsRepository['externalAttendance']>>[number];
function toAttendance(r: AttendanceRow): ExternalAttendance {
  return {
    publicId: r.publicId, staff: { publicId: r.staffPublicId, name: r.staffName }, workDate: r.workDate, status: r.status as ExternalAttendanceStatus,
    timeIn: r.timeIn?.toISOString() ?? null, timeOut: r.timeOut?.toISOString() ?? null, minutes: attendanceMinutes(r.timeIn, r.timeOut), note: r.note,
    recordedBy: { publicId: r.recorderPublicId, displayName: r.recorderName }, recordedAt: r.recordedAt.toISOString(),
    updatedBy: r.updaterPublicId && r.updaterName !== null ? { publicId: r.updaterPublicId, displayName: r.updaterName } : null,
    updatedAt: r.updatedAt?.toISOString() ?? null,
  };
}

/** The message for a work date that cannot be recorded. */
function dateMessage(problem: AttendanceDateProblem, worker: { name: string; fromDate: string; toDate: string | null }, backdateDays: number): string {
  switch (problem) {
    case 'FUTURE': return 'Attendance is for today or an earlier day, not a future date';
    case 'BEFORE_START': return `${worker.name} started on this site on ${worker.fromDate}: pick that day or later`;
    case 'AFTER_END': return `${worker.name}'s last day on this site was ${worker.toDate}: pick that day or earlier`;
    case 'TOO_OLD': return backdateDays === 0 ? 'Attendance can be recorded for today only'
      : `Attendance can be recorded or corrected up to ${backdateDays} day${backdateDays === 1 ? '' : 's'} back`;
  }
}
