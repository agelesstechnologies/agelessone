import { Inject, Injectable } from '@nestjs/common';
import {
  ApproveReassignRequest, ChecklistResultRequest, LinkTicketRequest, ReassignmentRequest, ReassignRequestsQuery, SignoffRequest, TicketDetail,
} from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { isManagement, RequestContext } from '../../../platform/http/request-context';
import { CONTENT_TYPES, detectDocumentType, discardUpload, DocumentType, readUpload, saveUpload } from '../../../platform/storage';
import { CoreFacade } from '../../core/core.facade';
import { TicketsRepository } from '../infrastructure/tickets.repository';
import { TicketsService, toReassign, Warning } from './tickets.service';

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
      return this.tickets.detail(tx, t.id);
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
        return this.tickets.detail(tx, t.id);
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
        return this.tickets.detail(tx, t.id);
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
    if (!a) throw new AppError('TICKETS_ATTACHMENT_NOT_FOUND', 404, 'Unknown attachment');
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
      return this.tickets.detail(tx, t.id);
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
        return this.tickets.detail(tx, t.id);
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
        return this.tickets.detail(tx, t.id);
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
    return this.tickets.detail(this.db, id, warnings);
  }

  async rejectReassign(ctx: RequestContext, requestPublicId: string, reason: string): Promise<TicketDetail> {
    return this.db.transaction(async (tx) => {
      const { r, t, as } = await this.decidable(tx, ctx, requestPublicId);
      await this.repo.decideReassign(tx, r.id, { status: 'rejected', decidedBy: ctx.personId, decidedAs: as, decidedAt: new Date(), decisionReason: reason });
      await this.tickets.event(tx, ctx.personId, t, 'reassign_rejected', { request: r.publicId, reason });
      return this.tickets.detail(tx, t.id);
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

  private fileType(file: TicketUpload | undefined, allowed: DocumentType[]): DocumentType {
    if (!file) throw new AppError('TICKETS_FILE_REQUIRED', 400, 'Attach the file (field file)');
    const type = detectDocumentType(file.buffer);
    if (!type || !allowed.includes(type)) throw new AppError('TICKETS_FILE_TYPE', 400, `Only ${allowed.join(', ').toUpperCase()} files are accepted here`);
    return type;
  }
}
