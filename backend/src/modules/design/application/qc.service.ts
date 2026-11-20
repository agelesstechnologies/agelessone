import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { QcChecklist, QcChecklistQuery, QcReviewRequest, Revision } from '@ageless/shared';
import { DB, Db, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { discardUpload, readUpload, saveUpload } from '../../../platform/storage';
import { todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { DesignRepository } from '../infrastructure/design.repository';
import { contentTypeOf } from '../domain/files';
import { checklistProblem, storedChecklist } from '../domain/qc';
import { DesignAccess } from './access.service';
import { DrawingsService } from './drawings.service';
import { DesignFiles, Upload } from './files.service';

const MAX_MARKUPS = 5;

/**
 * QC of submitted revisions (Design QC, design.qc). The reviewer is never the revision's author nor an assignee of the
 * job's tickets (checked here, and by the database). Every checklist item is answered; approved only when all pass;
 * changes needed with comments and, if useful, marked-up files. One decision per revision; audited.
 */
@Injectable()
export class QcService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DesignRepository) private readonly repo: DesignRepository,
    @Inject(DesignAccess) private readonly access: DesignAccess,
    @Inject(DesignFiles) private readonly files: DesignFiles,
    @Inject(DrawingsService) private readonly drawings: DrawingsService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /** The checklist in force today (policy design.qc_checklist). Anyone who sees the company's design work. */
  async checklist(ctx: RequestContext, q: QcChecklistQuery): Promise<QcChecklist> {
    const company = await this.access.company(ctx, q.company);
    if (!(await this.access.inCompany(ctx, company.id)).view) throw new AppError('DESIGN_FORBIDDEN', 403, `You do not see ${company.code}'s design work`);
    return { company: company.code, items: await this.core.getPolicy(ctx.tenantId, 'design.qc_checklist', company.id, todayIst()) };
  }

  async review(ctx: RequestContext, revisionPublicId: string, req: QcReviewRequest, uploads: Upload[]): Promise<{ revision: Revision; created: boolean }> {
    const { revision, job, access } = await this.access.revision(ctx, { publicId: revisionPublicId });
    if (req.publicId) {
      const found = await this.repo.qcOfPublicId(this.db, req.publicId);
      if (found && found.tenantId === ctx.tenantId && found.revisionId === revision.id) return { revision: await this.drawings.revision(ctx, revisionPublicId), created: false };
      if (found) throw new AppError('DESIGN_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    if (!access.qc) throw new AppError('DESIGN_FORBIDDEN', 403, 'Only Design QC (design.qc) reviews revisions');
    const label = `${revision.drawingNumber} revision ${revision.code}`;
    if ([revision.drawnByPersonId, revision.createdBy, revision.submittedBy].includes(ctx.personId)) {
      throw new AppError('DESIGN_QC_NOT_INDEPENDENT', 403, `You drew or submitted ${label}: someone else reviews it`);
    }
    if ((await this.repo.assigneesOfJob(this.db, job.id, false)).has(ctx.personId)) {
      throw new AppError('DESIGN_QC_NOT_INDEPENDENT', 403, `You are assigned to a ticket of design job ${job.number}: QC is done by someone not working on it`);
    }
    if (revision.status !== 'submitted') throw new AppError('DESIGN_NOT_SUBMITTED', 409, `${label} is ${revision.status.replace('_', ' ')}: only submitted revisions are reviewed`);
    const items = await this.core.getPolicy(ctx.tenantId, 'design.qc_checklist', job.legalEntityId, todayIst());
    const problem = checklistProblem(items, req.checklist, req.decision);
    if (problem) throw new AppError('DESIGN_CHECKLIST', 400, problem);
    if (uploads.length > MAX_MARKUPS) throw new AppError('DESIGN_TOO_MANY_FILES', 400, `Up to ${MAX_MARKUPS} mark-up files`);
    const types: string[] = [];
    for (const f of uploads) types.push(await this.files.accept(ctx.tenantId, job.legalEntityId, f, 'markup'));
    const paths: string[] = [];
    try {
      for (let i = 0; i < uploads.length; i++) paths.push(await saveUpload('design-qc', types[i], uploads[i].buffer));
      await this.db.transaction(async (tx) => {
        const r = await this.repo.lockRevision(tx, revision.id);
        if (r?.status !== 'submitted') throw new AppError('DESIGN_NOT_SUBMITTED', 409, `${label} is ${r?.status ?? 'gone'}: only submitted revisions are reviewed`);
        const reviewId = await this.repo.insertQc(tx, { tenantId: ctx.tenantId, publicId: req.publicId ?? randomUUID(), legalEntityId: revision.legalEntityId,
          revisionId: revision.id, reviewerPersonId: ctx.personId, decision: req.decision, comments: req.comments ?? null, checklist: storedChecklist(items, req.checklist) });
        for (let i = 0; i < paths.length; i++) {
          await this.repo.insertQcFile(tx, { tenantId: ctx.tenantId, publicId: randomUUID(), legalEntityId: revision.legalEntityId, reviewId,
            name: `${revision.drawingNumber}_${revision.code}_qc-${i + 1}.${types[i]}`, filePath: paths[i], fileType: types[i], sizeBytes: uploads[i].size });
        }
        await this.repo.updateRevision(tx, revision.id, { status: req.decision === 'approved' ? 'qc_approved' : 'changes_needed' });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: `design.qc_${req.decision}`, entity: 'drawing_revision',
          entityPublicId: revision.publicId, legalEntityId: revision.legalEntityId,
          summary: `QC of ${label}: ${req.decision === 'approved' ? 'approved' : `changes needed: ${req.comments}`}`,
          details: { decision: req.decision, failed: req.checklist.filter((a) => !a.passed).map((a) => a.item), markups: paths.length } });
      });
    } catch (err) {
      await Promise.all(paths.map((p) => discardUpload(p)));
      if (violatedConstraint(err, '23514') === 'qc_reviews_reviewer_independent') {
        throw new AppError('DESIGN_QC_NOT_INDEPENDENT', 403, `QC of ${label} must be done by someone who neither drew it nor works on design job ${job.number}`);
      }
      const hit = violatedConstraint(err);
      if (hit === 'qc_reviews_revision_id_unique') throw new AppError('DESIGN_NOT_SUBMITTED', 409, `${label} has already been reviewed`);
      if (hit === 'qc_reviews_public_id_unique') return this.review(ctx, revisionPublicId, req, uploads);
      throw err;
    }
    return { revision: await this.drawings.revision(ctx, revisionPublicId), created: true };
  }

  async markupFile(ctx: RequestContext, publicId: string): Promise<{ name: string; contentType: string; data: Buffer }> {
    const f = await this.repo.qcFile(this.db, ctx.tenantId, publicId);
    if (!f) throw new AppError('DESIGN_FILE_NOT_FOUND', 404, 'File not found');
    await this.access.revision(ctx, { id: f.revisionId }).catch(() => { throw new AppError('DESIGN_FILE_NOT_FOUND', 404, 'File not found'); });
    return { name: f.name, contentType: contentTypeOf(f.fileType), data: await readUpload(f.filePath) };
  }
}
