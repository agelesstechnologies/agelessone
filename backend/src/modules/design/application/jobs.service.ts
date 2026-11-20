import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AddJobAttachmentRequest, CreateDesignJobRequest, DesignAccessInfo, DesignJob, DesignJobDetail, DesignJobsQuery, DesignJobStatusRequest, LinkJobTicketRequest, PersonRef,
  RevisionStage, RevisionStatus, TransmittalPurpose, UpdateDesignJobRequest,
} from '@ageless/shared';
import { DB, Db, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { discardUpload, readUpload, saveUpload } from '../../../platform/storage';
import { todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { IntercompanyFacade } from '../../intercompany/intercompany.facade';
import { DesignRepository, JobRow } from '../infrastructure/design.repository';
import { contentTypeOf } from '../domain/files';
import { statusChange, JobStatus } from '../domain/jobs';
import { seriesNumber } from '../domain/numbers';
import { DesignAccess, JobAccess, requireManage, requireOpen } from './access.service';
import { DesignFiles, Upload } from './files.service';

/**
 * Design jobs: received from a client (a Core customer), run by the Designing head or an Admin user. Tickets of the
 * same company work on a job; when the client is another company of the group (AE), each linked ticket becomes
 * billable to it through Intercompany (the job is its "design request"). Every change is audited.
 */
@Injectable()
export class DesignJobsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DesignRepository) private readonly repo: DesignRepository,
    @Inject(DesignAccess) private readonly access: DesignAccess,
    @Inject(DesignFiles) private readonly files: DesignFiles,
    @Inject(CoreFacade) private readonly core: CoreFacade,
    @Inject(IntercompanyFacade) private readonly intercompany: IntercompanyFacade,
  ) {}

  health() { return { module: 'design', ok: true }; }

  /** What the caller may do in each company's design work, and how many jobs they work on through tickets. */
  async myAccess(ctx: RequestContext): Promise<DesignAccessInfo> {
    const companies: DesignAccessInfo['companies'] = [];
    for (const c of await this.repo.companies(this.db, ctx.tenantId)) {
      const a = await this.access.inCompany(ctx, c.id);
      companies.push({ company: c.code, name: c.name, enabled: a.departmentId !== null, manage: a.manage, qc: a.qc, view: a.view });
    }
    return { companies, assignedJobs: (await this.repo.jobsOfAssignee(this.db, ctx.personId)).length };
  }

  /** The jobs the caller may see: every job of the companies where they view design, plus the jobs whose tickets they work on. */
  async list(ctx: RequestContext, q: DesignJobsQuery): Promise<DesignJob[]> {
    const companies = (await this.repo.companies(this.db, ctx.tenantId)).filter((c) => !q.company || c.code === q.company);
    if (q.company && companies.length === 0) throw new AppError('DESIGN_UNKNOWN_COMPANY', 400, `Unknown company ${q.company}`);
    const companyIds: number[] = [];
    for (const c of companies) if ((await this.access.inCompany(ctx, c.id)).view) companyIds.push(c.id);
    const jobIds = await this.repo.jobsOfAssignee(this.db, ctx.personId);
    const rows = (await this.repo.jobs(this.db, ctx.tenantId, { companyIds, jobIds, status: q.status, customerPublicId: q.customer, q: q.q }))
      .filter((r) => !q.company || r.company === q.company);
    const people = await this.repo.persons(this.db, rows.map((r) => r.createdBy));
    return rows.map((r) => toJob(r, people));
  }

  async get(ctx: RequestContext, publicId: string): Promise<DesignJobDetail> {
    const { job, access } = await this.access.job(ctx, publicId);
    return this.detail(job, access);
  }

  /** A job received from a client, numbered from the company's series (DJ-025). The same publicId again: the stored job. */
  async create(ctx: RequestContext, req: CreateDesignJobRequest): Promise<{ job: DesignJobDetail; created: boolean }> {
    if (req.publicId) {
      const tenant = await this.repo.jobTenant(this.db, req.publicId);
      if (tenant === ctx.tenantId) return { job: await this.get(ctx, req.publicId), created: false };
      if (tenant !== undefined) throw new AppError('DESIGN_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const company = await this.access.company(ctx, req.company);
    const a = await this.access.inCompany(ctx, company.id);
    if (a.departmentId === null) {
      throw new AppError('DESIGN_NOT_ENABLED', 409, `${company.code} has no Designing department (policy design.department_prefix): it takes no design jobs`);
    }
    requireManage(a);
    const customer = await this.core.customer(this.db, ctx.tenantId, req.customerPublicId);
    if (!customer) throw new AppError('DESIGN_UNKNOWN_CUSTOMER', 400, 'Unknown customer');
    if (customer.status !== 'active') throw new AppError('DESIGN_CUSTOMER_INACTIVE', 409, `${customer.name} is inactive: it takes no new design jobs`);
    const numbering = await this.core.getPolicy(ctx.tenantId, 'design.numbering', company.id, todayIst());
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        const number = seriesNumber(numbering.jobPrefix, await this.repo.nextNumber(tx, ctx.tenantId, company.id, 'job'), numbering.jobDigits);
        await this.repo.insertJob(tx, {
          tenantId: ctx.tenantId, publicId, legalEntityId: company.id, departmentId: a.departmentId!, number, customerId: customer.id,
          clientProjectReference: req.clientProjectReference ?? null, site: req.site ?? null, scope: req.scope, requirements: req.requirements ?? null,
          dueDate: req.dueDate ?? null, receivedFromName: req.receivedFrom.name, receivedFromContact: req.receivedFrom.contact ?? null, createdBy: ctx.personId,
        });
        // the contact (a phone or an email) is never written to the audit log
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.job_created', entity: 'design_job', entityPublicId: publicId,
          legalEntityId: company.id, summary: `Design job ${number} received from ${customer.name}${req.clientProjectReference ? ` (${req.clientProjectReference})` : ''}`,
          details: { number, customer: customer.code, clientProjectReference: req.clientProjectReference ?? null, dueDate: req.dueDate ?? null } });
      });
    } catch (err) {
      const hit = violatedConstraint(err);
      if (hit === 'design_jobs_public_id_unique') return this.create(ctx, req);
      if (hit === 'design_jobs_company_number_unique') throw new AppError('DESIGN_NUMBER_TAKEN', 409, 'The next job number is already used: check policy design.numbering');
      throw err;
    }
    return { job: await this.get(ctx, publicId), created: true };
  }

  /** The job's details, while it is open. The client never changes. */
  async update(ctx: RequestContext, publicId: string, req: UpdateDesignJobRequest): Promise<DesignJobDetail> {
    const { job, access } = await this.access.job(ctx, publicId);
    requireManage(access);
    requireOpen(job);
    const patch = {
      ...(req.clientProjectReference !== undefined && { clientProjectReference: req.clientProjectReference }),
      ...(req.site !== undefined && { site: req.site }),
      ...(req.scope !== undefined && { scope: req.scope }),
      ...(req.requirements !== undefined && { requirements: req.requirements }),
      ...(req.dueDate !== undefined && { dueDate: req.dueDate }),
      ...(req.receivedFrom !== undefined && { receivedFromName: req.receivedFrom.name, receivedFromContact: req.receivedFrom.contact ?? null }),
    };
    await this.db.transaction(async (tx) => {
      const locked = await this.repo.lockJob(tx, job.id);
      requireOpen({ number: job.number, status: locked.status });
      await this.repo.updateJob(tx, job.id, { ...patch, updatedBy: ctx.personId, updatedAt: new Date() });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.job_changed', entity: 'design_job', entityPublicId: job.publicId,
        legalEntityId: job.legalEntityId, summary: `Design job ${job.number} changed: ${Object.keys(patch).join(', ')}`, details: { fields: Object.keys(patch) } });
    });
    return this.get(ctx, publicId);
  }

  /** received → accepted → in_design → closed; on hold (reason) and back; cancelled (reason). */
  async setStatus(ctx: RequestContext, publicId: string, req: DesignJobStatusRequest): Promise<DesignJobDetail> {
    const { job, access } = await this.access.job(ctx, publicId);
    requireManage(access);
    await this.db.transaction(async (tx) => {
      const locked = await this.repo.lockJob(tx, job.id);
      if (locked.status === req.status) return; // sent again: nothing changes
      const next = statusChange({ status: locked.status as JobStatus, resumeStatus: locked.resumeStatus as JobStatus | null }, req.status);
      if ('problem' in next) throw new AppError('DESIGN_BAD_STATUS_CHANGE', 409, next.problem);
      await this.repo.updateJob(tx, job.id, { status: next.status, resumeStatus: next.resumeStatus,
        holdReason: next.status === 'on_hold' ? req.reason! : null, cancelReason: next.status === 'cancelled' ? req.reason! : null,
        updatedBy: ctx.personId, updatedAt: new Date() });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.job_status', entity: 'design_job', entityPublicId: job.publicId,
        legalEntityId: job.legalEntityId, summary: `Design job ${job.number}: ${locked.status} → ${next.status}${req.reason ? `: ${req.reason}` : ''}`,
        details: { from: locked.status, to: next.status, reason: req.reason ?? null } });
    });
    return this.get(ctx, publicId);
  }

  /** A file the client sent (brief, survey, reference). The same publicId again: nothing new. */
  async addAttachment(ctx: RequestContext, publicId: string, req: AddJobAttachmentRequest, file: Upload | undefined): Promise<{ job: DesignJobDetail; created: boolean }> {
    const { job, access } = await this.access.job(ctx, publicId);
    requireManage(access);
    requireOpen(job);
    const attachmentId = req.publicId ?? randomUUID();
    if (req.publicId && await this.repo.attachment(this.db, ctx.tenantId, req.publicId)) return { job: await this.get(ctx, publicId), created: false };
    const ext = await this.files.accept(ctx.tenantId, job.legalEntityId, file, 'attachment');
    const path = await saveUpload('design-jobs', ext, file!.buffer);
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.lockJob(tx, job.id);
        const name = `${job.number}_attachment-${(await this.repo.countAttachments(tx, job.id)) + 1}.${ext}`;
        await this.repo.insertAttachment(tx, { tenantId: ctx.tenantId, publicId: attachmentId, legalEntityId: job.legalEntityId, jobId: job.id, name,
          description: req.description ?? null, filePath: path, fileType: ext, sizeBytes: file!.size, uploadedBy: ctx.personId });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.attachment_added', entity: 'design_job', entityPublicId: job.publicId,
          legalEntityId: job.legalEntityId, summary: `Design job ${job.number}: attachment ${name} added`, details: { name, fileType: ext, sizeBytes: file!.size } });
      });
    } catch (err) {
      await discardUpload(path);
      if (violatedConstraint(err) === 'job_attachments_public_id_unique') return { job: await this.get(ctx, publicId), created: false };
      throw err;
    }
    return { job: await this.get(ctx, publicId), created: true };
  }

  async attachmentFile(ctx: RequestContext, publicId: string): Promise<{ name: string; contentType: string; data: Buffer }> {
    const a = await this.repo.attachment(this.db, ctx.tenantId, publicId);
    if (!a) throw new AppError('DESIGN_FILE_NOT_FOUND', 404, 'File not found');
    await this.access.jobById(ctx, a.jobId).catch(() => { throw new AppError('DESIGN_FILE_NOT_FOUND', 404, 'File not found'); });
    return { name: a.name, contentType: contentTypeOf(a.fileType), data: await readUpload(a.filePath) };
  }

  /**
   * A ticket of the job's company works on the job (once; it never moves to another job). When the client is another
   * company of the group, the ticket becomes billable to it (Intercompany: the job is the design request).
   */
  async linkTicket(ctx: RequestContext, publicId: string, req: LinkJobTicketRequest): Promise<DesignJobDetail> {
    const { job, access } = await this.access.job(ctx, publicId);
    requireManage(access);
    requireOpen(job);
    const ticket = await this.repo.ticket(this.db, ctx.tenantId, req.ticketPublicId);
    if (!ticket) throw new AppError('DESIGN_TICKET_NOT_FOUND', 404, 'Ticket not found');
    if (ticket.legalEntityId !== job.legalEntityId) throw new AppError('DESIGN_TICKET_OTHER_COMPANY', 400, `Ticket ${ticket.number} is another company's: link tickets of ${job.company}`);
    if (ticket.status === 'cancelled') throw new AppError('DESIGN_TICKET_CANCELLED', 409, `Ticket ${ticket.number} is cancelled`);
    const linkedTo = await this.repo.jobOfTicket(this.db, ticket.id);
    if (linkedTo !== undefined && linkedTo !== job.id) throw new AppError('DESIGN_TICKET_ON_OTHER_JOB', 409, `Ticket ${ticket.number} already works on another design job`);
    const client = job.customerLegalEntityId !== null && job.customerLegalEntityId !== job.legalEntityId
      ? (await this.repo.companiesById(this.db, [job.customerLegalEntityId])).get(job.customerLegalEntityId) : undefined;
    try {
      await this.db.transaction(async (tx) => {
        const locked = await this.repo.lockJob(tx, job.id);
        requireOpen({ number: job.number, status: locked.status });
        if (linkedTo === undefined) {
          await this.repo.insertJobTicket(tx, { tenantId: ctx.tenantId, jobId: job.id, ticketId: ticket.id, legalEntityId: job.legalEntityId, linkedBy: ctx.personId });
          await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'design.ticket_linked', entity: 'design_job', entityPublicId: job.publicId,
            legalEntityId: job.legalEntityId, summary: `Ticket ${ticket.number} works on design job ${job.number}${client ? `: billable to ${client.code}` : ''}`,
            details: { ticket: ticket.number, billableTo: client?.code ?? null, serviceType: client ? req.serviceType : null } });
        }
        if (client) {
          await this.intercompany.linkTicketToWork(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, ticketPublicId: ticket.publicId,
            company: client.code, kind: 'design_request', publicId: job.publicId, serviceType: req.serviceType });
        }
      });
    } catch (err) {
      if (violatedConstraint(err) === 'job_tickets_ticket_id_unique') return this.linkTicket(ctx, publicId, req); // linked twice at once
      throw err;
    }
    return this.get(ctx, publicId);
  }

  private async detail(job: JobRow, access: JobAccess): Promise<DesignJobDetail> {
    const [attachments, tickets, drawings, transmittals] = await Promise.all([
      this.repo.attachments(this.db, job.id), this.repo.jobTickets(this.db, job.id),
      this.repo.drawings(this.db, job.tenantId, { jobId: job.id }), this.repo.transmittals(this.db, job.tenantId, { jobId: job.id }),
    ]);
    const latest = new Map((await this.repo.latestRevisions(this.db, drawings.map((d) => d.id))).map((r) => [r.drawingId, r]));
    const minutes = await this.repo.ticketMinutes(this.db, job.id);
    const ticketMinutes = (id: number) => Math.max(0, minutes.get(id) ?? 0);
    const people = await this.repo.persons(this.db, [job.createdBy, ...attachments.map((a) => a.uploadedBy), ...tickets.map((t) => t.linkedBy),
      ...transmittals.map((t) => t.issuedBy)]);
    return {
      ...toJob(job, people),
      requirements: job.requirements,
      attachments: attachments.map((a) => ({ publicId: a.publicId, name: a.name, description: a.description, fileType: a.fileType, sizeBytes: a.sizeBytes,
        uploadedBy: people.get(a.uploadedBy)!, uploadedAt: a.uploadedAt.toISOString() })),
      tickets: tickets.map((t) => ({ publicId: t.publicId, number: t.number, title: t.title, status: t.status, billableTo: t.billable ? t.billableTo : null,
        minutes: ticketMinutes(t.ticketId), linkedBy: people.get(t.linkedBy)!, linkedAt: t.linkedAt.toISOString() })),
      minutes: tickets.reduce((sum, t) => sum + ticketMinutes(t.ticketId), 0),
      drawings: drawings.map((d) => {
        const r = latest.get(d.id);
        return { publicId: d.publicId, number: d.number, title: d.title, discipline: d.discipline,
          current: r ? { publicId: r.publicId, code: r.code, stage: r.stage as RevisionStage, status: r.status as RevisionStatus } : null };
      }),
      transmittals: transmittals.map((t) => ({ publicId: t.publicId, number: t.number, purpose: t.purpose as TransmittalPurpose, revisions: Number(t.revisions),
        issuedBy: people.get(t.issuedBy)!, issuedAt: t.issuedAt.toISOString() })),
      actions: { manage: access.manage, draw: access.draw, qc: access.qc },
    };
  }
}

export function toJob(r: JobRow, people: Map<number, PersonRef>): DesignJob {
  return {
    publicId: r.publicId, number: r.number, company: r.company, customer: { publicId: r.customerPublicId, code: r.customerCode, name: r.customerName },
    clientProjectReference: r.clientProjectReference, site: r.site, scope: r.scope, dueDate: r.dueDate, status: r.status as DesignJob['status'],
    holdReason: r.holdReason, cancelReason: r.cancelReason, resumeStatus: r.resumeStatus as DesignJob['resumeStatus'],
    receivedFrom: { name: r.receivedFromName, contact: r.receivedFromContact },
    clientProjectPublicId: r.clientProjectPublicId, drawings: Number(r.drawings), createdBy: people.get(r.createdBy)!,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt?.toISOString() ?? null,
  };
}
