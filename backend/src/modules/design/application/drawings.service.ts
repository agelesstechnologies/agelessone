import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AddRevisionFileRequest, CreateDrawingRequest, CreateRevisionRequest, Drawing, Revision, RevisionStage, RevisionStatus, TransmittalPurpose, UpdateDrawingRequest,
  UpdateRevisionRequest,
} from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { discardUpload, readUpload, saveUpload } from '../../../platform/storage';
import { todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { DesignRepository, JobRow, RevisionRow } from '../infrastructure/design.repository';
import { contentTypeOf } from '../domain/files';
import { drawingNumber, revisionFileName } from '../domain/numbers';
import { IN_PROGRESS, nextRevisionCode, Stage } from '../domain/revisions';
import { DesignAccess, requireDraw, requireOpen } from './access.service';
import { DesignFiles, Upload } from './files.service';

/**
 * Drawings of a design job, their revisions and files. People assigned to the job's tickets, the Designing head and
 * Admin users work on them; a revision is submitted once its PDF is attached, and from then on never changes (the
 * database refuses it too). Every change is audited.
 */
@Injectable()
export class DrawingsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DesignRepository) private readonly repo: DesignRepository,
    @Inject(DesignAccess) private readonly access: DesignAccess,
    @Inject(DesignFiles) private readonly files: DesignFiles,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  // ---- drawings ----

  /** A drawing numbered <job>-<discipline>-<seq> (DJ-025-MEC-001). The same publicId again: the stored drawing. */
  async createDrawing(ctx: RequestContext, jobPublicId: string, req: CreateDrawingRequest): Promise<{ drawing: Drawing; created: boolean }> {
    const { job, access } = await this.access.job(ctx, jobPublicId);
    if (req.publicId) {
      const tenant = await this.repo.drawingTenant(this.db, req.publicId);
      if (tenant === ctx.tenantId) return { drawing: await this.drawing(ctx, req.publicId), created: false };
      if (tenant !== undefined) throw new AppError('DESIGN_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    requireDraw(access);
    requireOpen(job);
    const disciplines = await this.core.getPolicy(ctx.tenantId, 'design.disciplines', job.legalEntityId, todayIst());
    if (!disciplines.includes(req.discipline)) {
      throw new AppError('DESIGN_UNKNOWN_DISCIPLINE', 400, `${req.discipline} is not a discipline: use ${disciplines.join(', ')} (policy design.disciplines)`);
    }
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        const locked = await this.repo.lockJob(tx, job.id);   // one drawing number at a time per job
        requireOpen({ number: job.number, status: locked.status });
        const seq = (await this.repo.maxDrawingSeq(tx, job.id, req.discipline)) + 1;
        if (seq > 999) throw new AppError('DESIGN_TOO_MANY_DRAWINGS', 409, `Design job ${job.number} has 999 ${req.discipline} drawings`);
        const number = drawingNumber(job.number, req.discipline, seq);
        await this.repo.insertDrawing(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: job.legalEntityId, jobId: job.id, discipline: req.discipline, seq,
          number, title: req.title, createdBy: ctx.personId });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.drawing_created', entity: 'drawing', entityPublicId: publicId,
          legalEntityId: job.legalEntityId, summary: `Drawing ${number} (${req.title}) added to design job ${job.number}`, details: { number, discipline: req.discipline } });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'drawings_public_id_unique') return this.createDrawing(ctx, jobPublicId, req);
      throw err;
    }
    return { drawing: await this.drawing(ctx, publicId), created: true };
  }

  async drawing(ctx: RequestContext, publicId: string): Promise<Drawing> {
    const { drawing } = await this.access.drawing(ctx, publicId);
    const revisions = await this.repo.revisions(this.db, ctx.tenantId, { drawingIds: [drawing.id] });
    const people = await this.repo.persons(this.db, [drawing.createdBy]);
    return {
      publicId: drawing.publicId, number: drawing.number, title: drawing.title, discipline: drawing.discipline, company: drawing.company,
      job: { publicId: drawing.jobPublicId, number: drawing.jobNumber }, createdBy: people.get(drawing.createdBy)!, createdAt: drawing.createdAt.toISOString(),
      revisions: await this.views(revisions),
    };
  }

  /** The title, until a revision of the drawing is submitted (the title block of a submitted revision keeps its own). */
  async updateDrawing(ctx: RequestContext, publicId: string, req: UpdateDrawingRequest): Promise<Drawing> {
    const { drawing, job, access } = await this.access.drawing(ctx, publicId);
    requireDraw(access);
    requireOpen(job);
    if (drawing.title === req.title) return this.drawing(ctx, publicId);
    await this.db.transaction(async (tx) => {
      await this.repo.lockDrawing(tx, drawing.id);
      const revisions = await this.repo.revisions(tx, ctx.tenantId, { drawingIds: [drawing.id] });
      if (revisions.some((r) => r.status !== 'draft')) throw new AppError('DESIGN_DRAWING_TITLE_LOCKED', 409, `A revision of ${drawing.number} is submitted: its title no longer changes`);
      await this.repo.updateDrawing(tx, drawing.id, { title: req.title, updatedBy: ctx.personId, updatedAt: new Date() });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.drawing_changed', entity: 'drawing', entityPublicId: publicId,
        legalEntityId: drawing.legalEntityId, summary: `Drawing ${drawing.number} renamed: ${req.title}`, details: { before: drawing.title, after: req.title } });
    });
    return this.drawing(ctx, publicId);
  }

  // ---- revisions ----

  /**
   * The drawing's next revision (a draft): code from its stage, title block defaulting to the drawing's title and the
   * job's client project reference. Refused while another revision of the drawing is a draft or submitted.
   */
  async createRevision(ctx: RequestContext, drawingPublicId: string, req: CreateRevisionRequest): Promise<{ revision: Revision; created: boolean }> {
    const { drawing, job, access } = await this.access.drawing(ctx, drawingPublicId);
    if (req.publicId) {
      const tenant = await this.repo.revisionTenant(this.db, req.publicId);
      if (tenant === ctx.tenantId) return { revision: await this.revision(ctx, req.publicId), created: false };
      if (tenant !== undefined) throw new AppError('DESIGN_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    requireDraw(access);
    requireOpen(job);
    const drawnBy = await this.drawnBy(ctx, job, req.drawnByPublicId);
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.lockDrawing(tx, drawing.id);
        const existing = await this.repo.revisions(tx, ctx.tenantId, { drawingIds: [drawing.id] });
        const open = existing.find((r) => IN_PROGRESS.includes(r.status as RevisionStatus));
        if (open) throw new AppError('DESIGN_REVISION_OPEN', 409, `Revision ${open.code} of ${drawing.number} is still ${open.status}: finish it first`);
        const next = nextRevisionCode(req.stage, existing.map((r) => ({ stage: r.stage as Stage, code: r.code })));
        if ('problem' in next) throw new AppError('DESIGN_REVISION_CODE', 409, next.problem);
        const seq = Math.max(0, ...existing.map((r) => r.seq)) + 1;
        await this.repo.insertRevision(tx, {
          tenantId: ctx.tenantId, publicId, legalEntityId: drawing.legalEntityId, drawingId: drawing.id, seq, stage: req.stage, code: next.code,
          title: req.title ?? drawing.title, changeNote: req.changeNote,
          clientProjectReference: req.clientProjectReference !== undefined ? req.clientProjectReference : job.clientProjectReference,
          drawnByPersonId: drawnBy, scale: req.scale ?? null, sheet: req.sheet ?? null, createdBy: ctx.personId,
        });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.revision_created', entity: 'drawing_revision', entityPublicId: publicId,
          legalEntityId: drawing.legalEntityId, summary: `Drawing ${drawing.number} revision ${next.code} (${req.stage}) started: ${req.changeNote}`,
          details: { drawing: drawing.number, code: next.code, stage: req.stage } });
      });
    } catch (err) {
      const hit = violatedConstraint(err);
      if (hit === 'drawing_revisions_public_id_unique') return this.createRevision(ctx, drawingPublicId, req);
      if (hit === 'drawing_revisions_one_open') throw new AppError('DESIGN_REVISION_OPEN', 409, `Another revision of ${drawing.number} is still in progress`);
      throw err;
    }
    return { revision: await this.revision(ctx, publicId), created: true };
  }

  async revision(ctx: RequestContext, publicId: string): Promise<Revision> {
    const { revision } = await this.access.revision(ctx, { publicId });
    return (await this.views([revision]))[0];
  }

  /** Only a draft changes: a submitted revision never does (DESIGN_REVISION_LOCKED). */
  async updateRevision(ctx: RequestContext, publicId: string, req: UpdateRevisionRequest): Promise<Revision> {
    const { revision, job, access } = await this.access.revision(ctx, { publicId });
    requireDraw(access);
    requireOpen(job);
    const drawnBy = req.drawnByPublicId ? await this.drawnBy(ctx, job, req.drawnByPublicId) : undefined;
    const patch = {
      ...(req.changeNote !== undefined && { changeNote: req.changeNote }), ...(req.title !== undefined && { title: req.title }),
      ...(req.clientProjectReference !== undefined && { clientProjectReference: req.clientProjectReference }),
      ...(req.scale !== undefined && { scale: req.scale }), ...(req.sheet !== undefined && { sheet: req.sheet }),
      ...(drawnBy !== undefined && { drawnByPersonId: drawnBy }),
    };
    await this.lockedWrite(async (tx) => {
      await this.requireDraft(tx, revision);
      await this.repo.updateRevision(tx, revision.id, { ...patch, updatedAt: new Date() });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.revision_changed', entity: 'drawing_revision', entityPublicId: publicId,
        legalEntityId: revision.legalEntityId, summary: `Drawing ${revision.drawingNumber} revision ${revision.code} changed: ${Object.keys(patch).join(', ')}`,
        details: { fields: Object.keys(patch) } });
    });
    return this.revision(ctx, publicId);
  }

  /** A file of a draft revision: the PDF (a new one replaces the old), source files, the bill of materials. */
  async addFile(ctx: RequestContext, publicId: string, req: AddRevisionFileRequest, file: Upload | undefined): Promise<{ revision: Revision; created: boolean }> {
    const { revision, job, access } = await this.access.revision(ctx, { publicId });
    if (req.publicId && await this.repo.fileTenant(this.db, req.publicId) === ctx.tenantId) return { revision: await this.revision(ctx, publicId), created: false };
    requireDraw(access);
    requireOpen(job);
    if (revision.status !== 'draft') throw locked(revision);
    const ext = await this.files.accept(ctx.tenantId, revision.legalEntityId, file, req.kind === 'pdf' ? 'drawing_pdf' : req.kind);
    const path = await saveUpload('design-drawings', ext, file!.buffer);
    try {
      await this.lockedWrite(async (tx) => {
        await this.requireDraft(tx, revision);
        if (req.kind === 'pdf') {
          const old = await this.repo.currentPdf(tx, revision.id);
          if (old) await this.repo.removeFile(tx, old.id, ctx.personId);
        }
        const name = revisionFileName(revision.drawingNumber, revision.code, req.kind, (await this.repo.countFiles(tx, revision.id, req.kind)) + 1, ext);
        await this.repo.insertFile(tx, { tenantId: ctx.tenantId, publicId: req.publicId ?? randomUUID(), legalEntityId: revision.legalEntityId, revisionId: revision.id,
          kind: req.kind, name, filePath: path, fileType: ext, sizeBytes: file!.size, uploadedBy: ctx.personId });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.file_added', entity: 'drawing_revision', entityPublicId: publicId,
          legalEntityId: revision.legalEntityId, summary: `${name} added to drawing ${revision.drawingNumber} revision ${revision.code}`,
          details: { kind: req.kind, name, fileType: ext, sizeBytes: file!.size } });
      });
    } catch (err) {
      await discardUpload(path);
      if (violatedConstraint(err) === 'revision_files_public_id_unique') return { revision: await this.revision(ctx, publicId), created: false };
      throw err;
    }
    return { revision: await this.revision(ctx, publicId), created: true };
  }

  /** Takes a file off a draft revision (kept as history, never deleted). */
  async removeFile(ctx: RequestContext, filePublicId: string): Promise<Revision> {
    const f = await this.repo.file(this.db, ctx.tenantId, filePublicId);
    if (!f) throw fileNotFound();
    const { revision, job, access } = await this.access.revision(ctx, { id: f.revisionId }).catch(() => { throw fileNotFound(); });
    requireDraw(access);
    requireOpen(job);
    if (!f.removedAt) {
      await this.lockedWrite(async (tx) => {
        await this.requireDraft(tx, revision);
        await this.repo.removeFile(tx, f.id, ctx.personId);
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.file_removed', entity: 'drawing_revision', entityPublicId: revision.publicId,
          legalEntityId: revision.legalEntityId, summary: `${f.name} taken off drawing ${revision.drawingNumber} revision ${revision.code}`, details: { name: f.name } });
      });
    }
    return this.revision(ctx, revision.publicId);
  }

  async fileDownload(ctx: RequestContext, filePublicId: string): Promise<{ name: string; contentType: string; data: Buffer }> {
    const f = await this.repo.file(this.db, ctx.tenantId, filePublicId);
    if (!f) throw fileNotFound();
    await this.access.revision(ctx, { id: f.revisionId }).catch(() => { throw fileNotFound(); });
    return { name: f.name, contentType: contentTypeOf(f.fileType), data: await readUpload(f.filePath) };
  }

  /** Submits a draft for QC: its PDF must be attached. From now on it never changes. Sent again: nothing changes. */
  async submit(ctx: RequestContext, publicId: string): Promise<Revision> {
    const { revision, job, access } = await this.access.revision(ctx, { publicId });
    requireDraw(access);
    requireOpen(job);
    await this.db.transaction(async (tx) => {
      const r = await this.repo.lockRevision(tx, revision.id);
      if (r?.status === 'submitted') return;
      if (r?.status !== 'draft') throw locked(revision);
      if (!await this.repo.currentPdf(tx, revision.id)) throw new AppError('DESIGN_PDF_REQUIRED', 409, `Attach the PDF of ${revision.drawingNumber} revision ${revision.code} before submitting it`);
      await this.repo.updateRevision(tx, revision.id, { status: 'submitted', submittedBy: ctx.personId, submittedAt: new Date() });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.revision_submitted', entity: 'drawing_revision', entityPublicId: publicId,
        legalEntityId: revision.legalEntityId, summary: `Drawing ${revision.drawingNumber} revision ${revision.code} submitted for QC`, details: { drawing: revision.drawingNumber, code: revision.code } });
    });
    return this.revision(ctx, publicId);
  }

  // ---- views ----

  /** Revisions as the API answers them: files, QC decision, where issued, the client's response. */
  async views(revisions: RevisionRow[], conn: Conn = this.db): Promise<Revision[]> {
    const ids = revisions.map((r) => r.id);
    const [files, reviews, issued, responses] = await Promise.all([this.repo.files(conn, ids), this.repo.qcReviews(conn, ids), this.repo.issuedIn(conn, ids), this.repo.responses(conn, ids)]);
    const qcFiles = await this.repo.qcFiles(conn, reviews.map((q) => q.id));
    const people = await this.repo.persons(conn, [...revisions.flatMap((r) => [r.createdBy, r.drawnByPersonId, r.submittedBy]), ...files.map((f) => f.uploadedBy),
      ...reviews.map((q) => q.reviewerPersonId), ...responses.map((x) => x.recordedBy)]);
    return revisions.map((r) => {
      const qc = reviews.find((q) => q.revisionId === r.id);
      const where = issued.find((i) => i.revisionId === r.id);
      const answer = responses.find((x) => x.revisionId === r.id);
      return {
        publicId: r.publicId, drawingPublicId: r.drawingPublicId, drawingNumber: r.drawingNumber, seq: r.seq, code: r.code, stage: r.stage as RevisionStage,
        title: r.title, changeNote: r.changeNote,
        titleBlock: { clientProjectReference: r.clientProjectReference, drawnBy: people.get(r.drawnByPersonId)!, scale: r.scale, sheet: r.sheet },
        status: r.status as RevisionStatus,
        files: files.filter((f) => f.revisionId === r.id).map((f) => ({ publicId: f.publicId, kind: f.kind as 'pdf', name: f.name, fileType: f.fileType,
          sizeBytes: f.sizeBytes, uploadedBy: people.get(f.uploadedBy)!, uploadedAt: f.uploadedAt.toISOString() })),
        qc: qc ? { publicId: qc.publicId, reviewer: people.get(qc.reviewerPersonId)!, decision: qc.decision as 'approved', comments: qc.comments,
          checklist: qc.checklist as { item: string; passed: boolean; note: string | null }[],
          files: qcFiles.filter((f) => f.reviewId === qc.id).map((f) => ({ publicId: f.publicId, name: f.name, fileType: f.fileType })),
          decidedAt: qc.decidedAt.toISOString() } : null,
        issuedIn: where ? { publicId: where.publicId, number: where.number, purpose: where.purpose as TransmittalPurpose, issuedAt: where.issuedAt.toISOString() } : null,
        response: answer ? { response: answer.response as 'accepted', comments: answer.comments, respondedOn: answer.respondedOn, responderName: answer.responderName,
          recordedBy: people.get(answer.recordedBy)!, recordedAt: answer.recordedAt.toISOString() } : null,
        createdBy: people.get(r.createdBy)!, createdAt: r.createdAt.toISOString(),
        submittedBy: r.submittedBy ? people.get(r.submittedBy)! : null, submittedAt: r.submittedAt?.toISOString() ?? null, supersededAt: r.supersededAt?.toISOString() ?? null,
      };
    });
  }

  // ---- helpers ----

  /** Who drew it: a person with a job in the job's company; the caller when not named. */
  private async drawnBy(ctx: RequestContext, job: JobRow, publicId: string | undefined): Promise<number> {
    if (!publicId) return ctx.personId;
    const p = await this.repo.personByPublicId(this.db, ctx.tenantId, publicId);
    if (!p || !(await this.repo.companiesOf(this.db, p.id)).has(job.legalEntityId)) {
      throw new AppError('DESIGN_UNKNOWN_PERSON', 400, `"Drawn by" must be a person with a job in ${job.company}`);
    }
    return p.id;
  }

  private async requireDraft(tx: Tx, revision: RevisionRow): Promise<void> {
    if ((await this.repo.lockRevision(tx, revision.id))?.status !== 'draft') throw locked(revision);
  }

  /** A write to a draft; the database's own refusal of a submitted revision becomes DESIGN_REVISION_LOCKED. */
  private async lockedWrite(fn: (tx: Tx) => Promise<void>): Promise<void> {
    try {
      await this.db.transaction(fn);
    } catch (err) {
      const hit = violatedConstraint(err, '23001');
      if (hit === 'drawing_revisions_submitted_immutable' || hit === 'revision_files_draft_only') {
        throw new AppError('DESIGN_REVISION_LOCKED', 409, 'A submitted revision never changes: start a new revision');
      }
      throw err;
    }
  }
}

const locked = (r: { drawingNumber: string; code: string; status: string }) =>
  new AppError('DESIGN_REVISION_LOCKED', 409, `${r.drawingNumber} revision ${r.code} is ${r.status.replace('_', ' ')}: a submitted revision never changes; start a new revision`);
const fileNotFound = () => new AppError('DESIGN_FILE_NOT_FOUND', 404, 'File not found');
