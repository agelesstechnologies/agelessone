import { Inject, Injectable } from '@nestjs/common';
import { DB, Db } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { DesignRepository, DrawingRow, JobRow, RevisionRow } from '../infrastructure/design.repository';
import { isOpen, JobStatus } from '../domain/jobs';
import { DESIGN } from '../domain/permissions';

/** What the caller may do in one company's design work. */
export interface CompanyAccess {
  companyId: number;
  /** the company's Designing department (policy design.department_prefix); null: it takes no design jobs */
  departmentId: number | null;
  /** runs design jobs: the Designing head, or design.jobs.manage */
  manage: boolean;
  /** reviews revisions: design.qc */
  qc: boolean;
  /** sees every design job: manage, qc or design.view */
  view: boolean;
}
/** On one job: draw = manage or a current assignee of the job's tickets; view also for anyone ever assigned. */
export interface JobAccess extends CompanyAccess { draw: boolean }

/**
 * Who may do what in Design. A permission held with scope all counts in every company; with scope own or team, in the
 * companies the person holds a job in. The Designing head is the head of the job's department. Records the caller may
 * not see answer 404, as if they did not exist.
 */
@Injectable()
export class DesignAccess {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DesignRepository) private readonly repo: DesignRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async company(ctx: RequestContext, code: string): Promise<{ id: number; code: string; name: string }> {
    const c = await this.repo.company(this.db, ctx.tenantId, code);
    if (!c) throw new AppError('DESIGN_UNKNOWN_COMPANY', 400, `Unknown company ${code}`);
    return c;
  }

  async inCompany(ctx: RequestContext, companyId: number, departmentId?: number): Promise<CompanyAccess> {
    let dept: { id: number; headPersonId: number | null } | undefined;
    if (departmentId !== undefined) dept = { id: departmentId, headPersonId: await this.repo.departmentHead(this.db, departmentId) };
    else dept = await this.repo.department(this.db, companyId, await this.core.getPolicy(ctx.tenantId, 'design.department_prefix', companyId, todayIst()));
    const works = await this.repo.companiesOf(this.db, ctx.personId);
    const holds = (p: string) => ctx.permissions[p] === 'all' || (ctx.permissions[p] !== undefined && works.has(companyId));
    const manage = (!!dept && dept.headPersonId === ctx.personId) || holds(DESIGN.manage);
    const qc = holds(DESIGN.qc);
    return { companyId, departmentId: dept?.id ?? null, manage, qc, view: manage || qc || holds(DESIGN.view) };
  }

  async onJob(ctx: RequestContext, job: JobRow): Promise<JobAccess> {
    const c = await this.inCompany(ctx, job.legalEntityId, job.departmentId);
    const current = await this.repo.assigneesOfJob(this.db, job.id, true);
    const draw = c.manage || current.has(ctx.personId);
    const view = c.view || draw || (await this.repo.assigneesOfJob(this.db, job.id, false)).has(ctx.personId);
    return { ...c, draw, view };
  }

  /** The job if the caller may see it (404 otherwise). */
  async job(ctx: RequestContext, publicId: string): Promise<{ job: JobRow; access: JobAccess }> {
    const [job] = await this.repo.jobs(this.db, ctx.tenantId, { publicId });
    if (!job) throw jobNotFound();
    const access = await this.onJob(ctx, job);
    if (!access.view) throw jobNotFound();
    return { job, access };
  }

  async jobById(ctx: RequestContext, id: number): Promise<{ job: JobRow; access: JobAccess }> {
    const [job] = await this.repo.jobs(this.db, ctx.tenantId, { id });
    if (!job) throw jobNotFound();
    const access = await this.onJob(ctx, job);
    if (!access.view) throw jobNotFound();
    return { job, access };
  }

  async drawing(ctx: RequestContext, publicId: string): Promise<{ drawing: DrawingRow; job: JobRow; access: JobAccess }> {
    const [drawing] = await this.repo.drawings(this.db, ctx.tenantId, { publicId });
    if (!drawing) throw new AppError('DESIGN_DRAWING_NOT_FOUND', 404, 'Drawing not found');
    const { job, access } = await this.jobById(ctx, drawing.jobId).catch(() => { throw new AppError('DESIGN_DRAWING_NOT_FOUND', 404, 'Drawing not found'); });
    return { drawing, job, access };
  }

  async revision(ctx: RequestContext, f: { publicId: string } | { id: number }): Promise<{ revision: RevisionRow; job: JobRow; access: JobAccess }> {
    const [revision] = await this.repo.revisions(this.db, ctx.tenantId, f);
    if (!revision) throw revisionNotFound();
    const { job, access } = await this.jobById(ctx, revision.jobId).catch(() => { throw revisionNotFound(); });
    return { revision, job, access };
  }
}

export const jobNotFound = () => new AppError('DESIGN_JOB_NOT_FOUND', 404, 'Design job not found');
export const revisionNotFound = () => new AppError('DESIGN_REVISION_NOT_FOUND', 404, 'Revision not found');

export function requireManage(a: CompanyAccess): void {
  if (!a.manage) throw new AppError('DESIGN_FORBIDDEN', 403, 'Only the Designing head or an Admin user (design.jobs.manage) does this');
}
export function requireDraw(a: JobAccess): void {
  if (!a.draw) throw new AppError('DESIGN_FORBIDDEN', 403, 'Only people assigned to the job\'s tickets, the Designing head or an Admin user work on its drawings');
}
export function requireOpen(job: { number: string; status: string }): void {
  if (!isOpen(job.status as JobStatus)) throw new AppError('DESIGN_JOB_CLOSED', 409, `Design job ${job.number} is ${job.status}: it no longer changes`);
}
