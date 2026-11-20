import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ClientResponseRequest, IssueTransmittalRequest, PersonRef, Revision, Transmittal, TransmittalListItem, TransmittalPurpose, TransmittalsQuery } from '@ageless/shared';
import { DB, Db, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { renderReport, ReportDocument } from '../../../platform/report-pdf';
import { readUpload } from '../../../platform/storage';
import { todayIst } from '../../../platform/time';
import { makeZip } from '../../../platform/zip';
import { CoreFacade } from '../../core/core.facade';
import { DesignRepository, TransmittalRow } from '../infrastructure/design.repository';
import { seriesNumber } from '../domain/numbers';
import { ISSUED, RevisionStatus, Stage, SUPERSEDED_BY_ISSUE } from '../domain/revisions';
import { issueProblem, Purpose, PURPOSE_LABEL } from '../domain/transmittals';
import { DesignAccess, requireManage, requireOpen } from './access.service';
import { DrawingsService } from './drawings.service';

const istDate = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

/**
 * Transmittals: QC-approved revisions issued to the client together (TR-0001 per company), with a PDF cover sheet and
 * a zip of the drawings made from the stored rows when asked for. Issuing a revision supersedes the drawing's earlier
 * issued one. The client's answer on each issued revision is recorded by the company. Designing head or Admin user.
 */
@Injectable()
export class TransmittalsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DesignRepository) private readonly repo: DesignRepository,
    @Inject(DesignAccess) private readonly access: DesignAccess,
    @Inject(DrawingsService) private readonly drawings: DrawingsService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async issue(ctx: RequestContext, jobPublicId: string, req: IssueTransmittalRequest): Promise<{ transmittal: Transmittal; created: boolean }> {
    const { job, access } = await this.access.job(ctx, jobPublicId);
    if (req.publicId) {
      const tenant = await this.repo.transmittalTenant(this.db, req.publicId);
      if (tenant === ctx.tenantId) return { transmittal: await this.get(ctx, req.publicId), created: false };
      if (tenant !== undefined) throw new AppError('DESIGN_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    requireManage(access);
    requireOpen(job);
    const numbering = await this.core.getPolicy(ctx.tenantId, 'design.numbering', job.legalEntityId, todayIst());
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        const lockedJob = await this.repo.lockJob(tx, job.id);
        requireOpen({ number: job.number, status: lockedJob.status });
        const found = await this.repo.revisions(tx, ctx.tenantId, { publicIds: req.revisionPublicIds });
        if (found.length !== req.revisionPublicIds.length) throw new AppError('DESIGN_REVISION_NOT_FOUND', 404, 'A revision to issue was not found');
        for (const r of [...found].sort((a, b) => a.id - b.id)) await this.repo.lockRevision(tx, r.id);
        const revisions = await this.repo.revisions(tx, ctx.tenantId, { publicIds: req.revisionPublicIds });   // as they are now, locked
        const candidates = await Promise.all(revisions.map(async (r) => ({
          label: `${r.drawingNumber} revision ${r.code}`, jobId: r.jobId, drawingId: r.drawingId, status: r.status as RevisionStatus, stage: r.stage as Stage,
          laterIssued: await this.repo.laterIssued(tx, r.drawingId, r.seq, ISSUED),
        })));
        const problem = issueProblem(job.id, req.purpose, candidates);
        if (problem) throw new AppError(problem.code, problem.code === 'DESIGN_REVISION_OTHER_JOB' ? 400 : 409, problem.message);
        const number = seriesNumber(numbering.transmittalPrefix, await this.repo.nextNumber(tx, ctx.tenantId, job.legalEntityId, 'transmittal'), numbering.transmittalDigits);
        const transmittalId = await this.repo.insertTransmittal(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: job.legalEntityId, jobId: job.id, number,
          purpose: req.purpose, recipient: req.recipient ?? job.receivedFromName, note: req.note ?? null, issuedBy: ctx.personId });
        await this.repo.insertTransmittalItems(tx, revisions.map((r) => ({ tenantId: ctx.tenantId, transmittalId, revisionId: r.id, legalEntityId: job.legalEntityId })));
        const now = new Date();
        const superseded: string[] = [];
        for (const r of revisions) {
          if (await this.repo.supersedeEarlier(tx, r.drawingId, r.seq, SUPERSEDED_BY_ISSUE, now)) superseded.push(r.drawingNumber);
          await this.repo.updateRevision(tx, r.id, { status: 'issued' });
        }
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.transmittal_issued', entity: 'transmittal', entityPublicId: publicId,
          legalEntityId: job.legalEntityId,
          summary: `Transmittal ${number} (${PURPOSE_LABEL[req.purpose]}) of design job ${job.number}: ${revisions.map((r) => `${r.drawingNumber} rev ${r.code}`).join(', ')}`,
          details: { number, purpose: req.purpose, revisions: revisions.map((r) => `${r.drawingNumber} rev ${r.code}`), supersededOn: superseded } });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'transmittals_public_id_unique') return this.issue(ctx, jobPublicId, req);
      if (violatedConstraint(err) === 'transmittal_items_revision_id_unique') throw new AppError('DESIGN_ALREADY_ISSUED', 409, 'A revision was issued at the same moment: reload and try again');
      throw err;
    }
    return { transmittal: await this.get(ctx, publicId), created: true };
  }

  /** The transmittals of the companies where the caller sees design work, and of the jobs whose tickets they work on. */
  async list(ctx: RequestContext, q: TransmittalsQuery): Promise<TransmittalListItem[]> {
    let rows: TransmittalRow[];
    if (q.job) {
      const { job } = await this.access.job(ctx, q.job);
      rows = await this.repo.transmittals(this.db, ctx.tenantId, { jobId: job.id });
    } else {
      const companies = (await this.repo.companies(this.db, ctx.tenantId)).filter((c) => !q.company || c.code === q.company);
      if (q.company && companies.length === 0) throw new AppError('DESIGN_UNKNOWN_COMPANY', 400, `Unknown company ${q.company}`);
      const companyIds: number[] = [];
      for (const c of companies) if ((await this.access.inCompany(ctx, c.id)).view) companyIds.push(c.id);
      rows = (await this.repo.transmittals(this.db, ctx.tenantId, { companyIds, jobIds: await this.repo.jobsOfAssignee(this.db, ctx.personId) }))
        .filter((t) => !q.company || t.company === q.company);
    }
    const people = await this.repo.persons(this.db, rows.map((t) => t.issuedBy));
    return rows.map((t) => ({ ...head(t, people), revisions: Number(t.revisions) }));
  }

  async get(ctx: RequestContext, publicId: string): Promise<Transmittal> {
    const t = await this.visible(ctx, publicId);
    const [items, people] = await Promise.all([this.repo.transmittalItems(this.db, t.id), this.repo.persons(this.db, [t.issuedBy])]);
    return { ...head(t, people), items: items.map((i) => ({ revisionPublicId: i.revisionPublicId, drawingPublicId: i.drawingPublicId, drawingNumber: i.drawingNumber,
      title: i.title, code: i.code, discipline: i.discipline, sheet: i.sheet, scale: i.scale, status: i.status as RevisionStatus })) };
  }

  /** The cover sheet: what was issued, to whom and why; exactly the transmittal's revisions. */
  async coverPdf(ctx: RequestContext, publicId: string): Promise<{ name: string; data: Buffer }> {
    const t = await this.visible(ctx, publicId);
    return { name: `${t.number}_cover.pdf`, data: await this.cover(t) };
  }

  /** The cover sheet and each issued revision's PDF in one zip. */
  async zip(ctx: RequestContext, publicId: string): Promise<{ name: string; data: Buffer }> {
    const t = await this.visible(ctx, publicId);
    const items = await this.repo.transmittalItems(this.db, t.id);
    const pdfs = (await this.repo.files(this.db, items.map((i) => i.revisionId))).filter((f) => f.kind === 'pdf');
    const entries = [{ name: `${t.number}_cover.pdf`, data: await this.cover(t), modified: t.issuedAt }];
    for (const f of pdfs) entries.push({ name: f.name, data: await readUpload(f.filePath), modified: f.uploadedAt });
    return { name: `${t.number}.zip`, data: makeZip(entries) };
  }

  /** What the client said about an issued revision: accepted, or returned with comments (a next revision is needed). */
  async respond(ctx: RequestContext, revisionPublicId: string, req: ClientResponseRequest): Promise<{ revision: Revision; created: boolean }> {
    const { revision, access } = await this.access.revision(ctx, { publicId: revisionPublicId });
    requireManage(access);
    const label = `${revision.drawingNumber} revision ${revision.code}`;
    const [existing] = await this.repo.responses(this.db, [revision.id]);
    if (existing) {
      if (existing.response === req.response && existing.respondedOn === req.respondedOn) return { revision: await this.drawings.revision(ctx, revisionPublicId), created: false };
      throw new AppError('DESIGN_ALREADY_ANSWERED', 409, `The client's response to ${label} is already recorded (${existing.response})`);
    }
    if (revision.status !== 'issued') throw new AppError('DESIGN_NOT_ISSUED', 409, `${label} is ${revision.status.replace('_', ' ')}: responses are recorded on issued revisions`);
    if (req.respondedOn > todayIst()) throw new AppError('DESIGN_FUTURE_DATE', 400, 'The response date cannot be in the future');
    const [where] = await this.repo.issuedIn(this.db, [revision.id]);
    if (where && req.respondedOn < todayIst(where.issuedAt)) throw new AppError('DESIGN_BEFORE_ISSUE', 400, `${label} was issued on ${todayIst(where.issuedAt)}: the response cannot be earlier`);
    try {
      await this.db.transaction(async (tx) => {
        if ((await this.repo.lockRevision(tx, revision.id))?.status !== 'issued') throw new AppError('DESIGN_NOT_ISSUED', 409, `${label} is no longer issued`);
        await this.repo.insertResponse(tx, { tenantId: ctx.tenantId, publicId: randomUUID(), legalEntityId: revision.legalEntityId, revisionId: revision.id,
          response: req.response, comments: req.comments ?? null, respondedOn: req.respondedOn, responderName: req.responderName, recordedBy: ctx.personId });
        await this.repo.updateRevision(tx, revision.id, { status: req.response });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: `design.client_${req.response}`, entity: 'drawing_revision',
          entityPublicId: revision.publicId, legalEntityId: revision.legalEntityId,
          summary: `Client ${req.response} ${label} (${req.responderName}, ${req.respondedOn})${req.comments ? `: ${req.comments}` : ''}`,
          details: { response: req.response, respondedOn: req.respondedOn } });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'client_responses_revision_id_unique') return this.respond(ctx, revisionPublicId, req);
      throw err;
    }
    return { revision: await this.drawings.revision(ctx, revisionPublicId), created: true };
  }

  private async visible(ctx: RequestContext, publicId: string): Promise<TransmittalRow> {
    const [t] = await this.repo.transmittals(this.db, ctx.tenantId, { publicId });
    if (!t) throw notFound();
    await this.access.jobById(ctx, t.jobId).catch(() => { throw notFound(); });
    return t;
  }

  private async cover(t: TransmittalRow): Promise<Buffer> {
    const [items, people] = await Promise.all([this.repo.transmittalItems(this.db, t.id), this.repo.persons(this.db, [t.issuedBy])]);
    const report: ReportDocument = {
      title: `Transmittal ${t.number}`,
      subtitle: `${t.companyName} - design job ${t.jobNumber} for ${t.customerName}`,
      footer: (page, pages) => `Transmittal ${t.number} - page ${page} of ${pages}`,
      sections: [
        { title: 'Transmittal', blocks: [{ kind: 'rows', rows: [
          ['Number', t.number], ['Date', istDate(t.issuedAt)], ['Purpose', PURPOSE_LABEL[t.purpose as Purpose]], ['From', t.companyName], ['To', t.recipient],
          ['Client', `${t.customerName} (${t.customerCode})`], ['Client project', t.clientProjectReference ?? '-'], ['Design job', t.jobNumber],
          ['Issued by', people.get(t.issuedBy)?.displayName ?? '-'], ...(t.note ? [['Note', t.note] as [string, string]] : []),
        ] }] },
        { title: `Drawings issued (${items.length})`, blocks: [{ kind: 'table',
          columns: [{ label: 'Drawing', width: 0.24 }, { label: 'Title', width: 0.36 }, { label: 'Rev', width: 0.08 }, { label: 'Discipline', width: 0.12 },
            { label: 'Sheet', width: 0.1 }, { label: 'Scale', width: 0.1 }],
          rows: items.map((i) => [i.drawingNumber, i.title, i.code, i.discipline, i.sheet ?? '-', i.scale ?? '-']) }] },
        { title: 'Acknowledgement', blocks: [
          { kind: 'note', text: 'Please confirm receipt, and accept or return each drawing with your comments.' },
          { kind: 'rows', rows: [['Received by', ''], ['Date', ''], ['Signature', '']] },
        ] },
      ],
    };
    return renderReport(report, new Map());
  }
}

const notFound = () => new AppError('DESIGN_TRANSMITTAL_NOT_FOUND', 404, 'Transmittal not found');

function head(t: TransmittalRow, people: Map<number, PersonRef>): Omit<Transmittal, 'items'> {
  return {
    publicId: t.publicId, number: t.number, company: t.company, job: { publicId: t.jobPublicId, number: t.jobNumber },
    customer: { publicId: t.customerPublicId, code: t.customerCode, name: t.customerName }, clientProjectReference: t.clientProjectReference,
    purpose: t.purpose as TransmittalPurpose, recipient: t.recipient, note: t.note, issuedBy: people.get(t.issuedBy)!, issuedAt: t.issuedAt.toISOString(),
  };
}
