import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  IssuedLetter, IssueLetterRequest, LETTER_FIELDS, LetterDraft, LetterKind, LetterTemplate, SaveLetterTemplateRequest,
} from '@ageless/shared';
import { DB, Db } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireReadAll } from '../../../../platform/http/request-context';
import { letterPdf } from '../../../../platform/pdf';
import { todayIst } from '../../../../platform/time';
import { CoreFacade } from '../../../core/core.facade';
import { LettersRepository } from '../infrastructure/letters.repository';
import { DEFAULT_JOINING, fillLetter, longDate, unknownFields } from '../domain/letters';
import { LETTERS } from '../domain/permissions';

const KIND: LetterKind = 'joining';

/**
 * Joining letters: one template per company (HR and Management edit it), filled with a job's details, adjusted for the
 * person if needed, then issued: the exact text is kept (never changed) and downloaded as a PDF. Every issue is audited.
 */
@Injectable()
export class LettersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LettersRepository) private readonly repo: LettersRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /** The company's template, or the built-in one (isDefault) when none is saved yet. */
  async template(ctx: RequestContext, companyCode: string): Promise<LetterTemplate> {
    requireReadAll(ctx, LETTERS.manage);
    const company = await this.company(ctx, companyCode);
    const saved = await this.repo.template(company.id, KIND);
    return {
      company: company.code, kind: KIND, fields: [...LETTER_FIELDS],
      title: saved?.title ?? DEFAULT_JOINING.title, body: saved?.body ?? DEFAULT_JOINING.body, isDefault: !saved,
      updatedBy: saved ? { publicId: saved.editorPublicId, displayName: saved.editorName } : null,
      updatedAt: saved?.updatedAt.toISOString() ?? null,
    };
  }

  /** Save the company's template. A misspelt fill-in such as {{nmae}} is refused, naming it. */
  async saveTemplate(ctx: RequestContext, companyCode: string, req: SaveLetterTemplateRequest): Promise<LetterTemplate> {
    requireReadAll(ctx, LETTERS.manage);
    const company = await this.company(ctx, companyCode);
    const unknown = unknownFields(`${req.title}\n${req.body}`);
    if (unknown.length) {
      throw new AppError('HRMS_LETTER_UNKNOWN_FIELD', 400, `Unknown fill-in ${unknown.map((f) => `{{${f}}}`).join(', ')}`, { unknown, known: LETTER_FIELDS });
    }
    await this.db.transaction(async (tx) => {
      await this.repo.saveTemplate(tx, { tenantId: ctx.tenantId, legalEntityId: company.id, kind: KIND, title: req.title, body: req.body, updatedBy: ctx.personId });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'letter_template.saved', entity: 'letter_template',
        legalEntityId: company.id, summary: `Joining letter template of ${company.code} saved` });
    });
    return this.template(ctx, companyCode);
  }

  /** The template filled with this job's details, for HR to adjust before issuing. */
  async draft(ctx: RequestContext, employmentPublicId: string): Promise<LetterDraft> {
    requireReadAll(ctx, LETTERS.manage);
    const job = await this.job(ctx, employmentPublicId);
    const template = await this.repo.template(job.legalEntityId, KIND);
    const values = {
      name: job.displayName, fullName: job.fullName, employeeCode: job.employeeCode, designation: job.designation,
      department: job.department, company: job.companyName, joiningDate: longDate(job.joinedOn),
      engagementType: job.employmentType.replace(/_/g, ' '), manager: job.managerName, today: longDate(todayIst()),
    };
    return {
      kind: KIND, person: { publicId: job.personPublicId, displayName: job.displayName },
      employment: { publicId: job.publicId, company: job.companyCode, employeeCode: job.employeeCode },
      title: fillLetter(template?.title ?? DEFAULT_JOINING.title, values), body: fillLetter(template?.body ?? DEFAULT_JOINING.body, values),
    };
  }

  /** Keep this text as the issued letter (sent twice with the same publicId: stored once, the same answer). */
  async issue(ctx: RequestContext, employmentPublicId: string, req: IssueLetterRequest): Promise<{ letter: IssuedLetter; created: boolean }> {
    requireReadAll(ctx, LETTERS.manage);
    const job = await this.job(ctx, employmentPublicId);
    const publicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const tenant = await this.repo.issuedTenant(req.publicId);
      if (tenant === ctx.tenantId) return { letter: (await this.repo.issued(ctx.tenantId, req.publicId))!, created: false };
      if (tenant !== undefined) throw new AppError('HRMS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    await this.db.transaction(async (tx) => {
      await this.repo.insertIssued(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: job.legalEntityId, employmentId: job.id, personId: job.personId,
        kind: KIND, title: req.title, body: req.body, issuedBy: ctx.personId });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'letter.issued', entity: 'issued_letter',
        entityPublicId: publicId, subjectPersonId: job.personId, legalEntityId: job.legalEntityId,
        summary: `Joining letter issued to ${job.displayName} (${job.employeeCode})` });
    });
    return { letter: (await this.repo.issued(ctx.tenantId, publicId))!, created: true };
  }

  /** Letters issued for this job, newest first. */
  async issuedForJob(ctx: RequestContext, employmentPublicId: string): Promise<IssuedLetter[]> {
    requireReadAll(ctx, LETTERS.manage);
    const job = await this.job(ctx, employmentPublicId);
    return this.repo.issuedForJob(ctx.tenantId, job.id);
  }

  /** An issued letter as a PDF: the company name, the issue date, the title and the kept text. */
  async pdf(ctx: RequestContext, letterPublicId: string): Promise<{ name: string; data: Buffer }> {
    requireReadAll(ctx, LETTERS.manage);
    const letter = await this.repo.issued(ctx.tenantId, letterPublicId);
    if (!letter) throw new AppError('HRMS_LETTER_NOT_FOUND', 404, 'Letter not found');
    const company = await this.repo.findCompany(ctx.tenantId, letter.employment.company);
    const data = letterPdf({ heading: company?.name ?? letter.employment.company, date: longDate(todayIst(new Date(letter.issuedAt))),
      title: letter.title, body: letter.body });
    return { name: `joining-letter-${letter.employment.employeeCode}-${letter.issuedAt.slice(0, 10)}.pdf`, data };
  }

  private async company(ctx: RequestContext, code: string) {
    const company = await this.repo.findCompany(ctx.tenantId, code);
    if (!company) throw new AppError('HRMS_UNKNOWN_COMPANY', 400, `Unknown company ${code}`);
    return company;
  }

  private async job(ctx: RequestContext, employmentPublicId: string) {
    const job = await this.repo.job(this.db, ctx.tenantId, employmentPublicId);
    if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Job not found');
    return job;
  }
}
