import { Inject, Injectable } from '@nestjs/common';
import {
  AddCertificateRequest, AddPersonSkillRequest, Certificate, CreateSkillRequest, ExpiringCertificates, ExpiringCertificatesQuery,
  PersonSkill, Skill, SkillsMatrix, SkillsMatrixQuery, SkillsQuery,
} from '@ageless/shared';
import { DB, Db, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireAll } from '../../../../platform/http/request-context';
import { CONTENT_TYPES, detectDocumentType, discardUpload, DocumentType, readUpload, saveUpload } from '../../../../platform/storage';
import { addDays, todayIst } from '../../../../platform/time';
import { SkillsRepository, Visibility } from '../infrastructure/skills.repository';
import { daysLeft, statusOn } from '../domain/certificates';
import { SKILLS } from '../domain/permissions';

/**
 * Use cases live here: open the transaction, call repositories and other facades, write the outbox event.
 * People add their own skills and certificates (or their manager / HR does); someone else verifies them — never the
 * person themselves. Certificates expire on their date: shown as expired at once, stored as expired by the daily job.
 */
@Injectable()
export class SkillsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SkillsRepository) private readonly repo: SkillsRepository,
  ) {}

  health() { return { module: 'hrms', sub: 'skills', ok: true }; }

  skills(ctx: RequestContext, q: SkillsQuery): Promise<Skill[]> {
    return this.repo.skills(ctx.tenantId, q.company, q.department);
  }

  async createSkill(ctx: RequestContext, req: CreateSkillRequest): Promise<Skill> {
    requireAll(ctx, SKILLS.manage);
    const company = await this.repo.findCompany(ctx.tenantId, req.company);
    if (!company) throw new AppError('HRMS_UNKNOWN_COMPANY', 400, `Unknown company ${req.company}`);
    const department = req.departmentCode ? await this.repo.findDepartment(company.id, req.departmentCode) : undefined;
    if (req.departmentCode && !department) throw new AppError('HRMS_UNKNOWN_DEPARTMENT', 400, `Unknown department ${req.departmentCode}`);
    try {
      const publicId = await this.repo.insertSkill({ tenantId: ctx.tenantId, legalEntityId: company.id, departmentId: department?.id ?? null, code: req.code, name: req.name });
      return (await this.repo.skills(ctx.tenantId, req.company)).find((s) => s.publicId === publicId)!;
    } catch (err) {
      if (violatedConstraint(err) === 'skills_company_code_unique') throw new AppError('HRMS_DUPLICATE_SKILL', 409, `${req.company} already has the skill ${req.code}`);
      throw err;
    }
  }

  /** Your own skill, a team member's (manager) or anyone's (HR). A changed level needs verifying again. */
  async addPersonSkill(ctx: RequestContext, personPublicId: string, req: AddPersonSkillRequest): Promise<PersonSkill> {
    const personId = await this.person(ctx, personPublicId);
    await this.checkScope(ctx, SKILLS.add, personId);
    const skill = await this.repo.findSkill(ctx.tenantId, req.skillPublicId);
    if (!skill) throw new AppError('HRMS_SKILL_NOT_FOUND', 404, 'Skill not found');
    const publicId = await this.repo.upsertPersonSkill({ tenantId: ctx.tenantId, personId, skillId: skill.id, level: req.level });
    return (await this.repo.personSkill(ctx.tenantId, publicId))!;
  }

  async verifyPersonSkill(ctx: RequestContext, publicId: string): Promise<PersonSkill> {
    await this.db.transaction(async (tx) => {
      const ps = await this.repo.lockPersonSkill(tx, ctx.tenantId, publicId);
      if (!ps) throw new AppError('HRMS_SKILL_NOT_FOUND', 404, 'Skill not found');
      await this.checkVerifier(ctx, ps.personId);
      await this.repo.verifyPersonSkill(tx, ps.id, ctx.personId);
    });
    return (await this.repo.personSkill(ctx.tenantId, publicId))!;
  }

  /** A certificate with an optional file (PDF, JPEG or PNG). One already past its date is stored as expired. */
  async addCertificate(ctx: RequestContext, personPublicId: string, req: AddCertificateRequest, file?: { buffer: Buffer }): Promise<Certificate> {
    const personId = await this.person(ctx, personPublicId);
    await this.checkScope(ctx, SKILLS.add, personId);
    let type: DocumentType | null = null;
    if (file) {
      type = detectDocumentType(file.buffer);
      if (!type) throw new AppError('HRMS_FILE_TYPE', 400, 'The certificate file must be a PDF, JPEG or PNG file');
    }
    const filePath = file && type ? await saveUpload('certificates', type, file.buffer) : null;
    try {
      const publicId = await this.repo.insertCertificate({
        tenantId: ctx.tenantId, personId, name: req.name, issuer: req.issuer, number: req.number, issuedOn: req.issuedOn, expiresOn: req.expiresOn,
        filePath, fileType: type, status: statusOn('review', req.expiresOn ?? null, todayIst()),
      });
      return (await this.repo.certificate(ctx.tenantId, publicId))!;
    } catch (err) {
      if (filePath) await discardUpload(filePath);
      throw err;
    }
  }

  /** Someone else (the manager or HR) confirms the certificate; an expired one cannot be verified. */
  async verifyCertificate(ctx: RequestContext, publicId: string): Promise<Certificate> {
    await this.db.transaction(async (tx) => {
      const c = await this.repo.lockCertificate(tx, ctx.tenantId, publicId);
      if (!c) throw new AppError('HRMS_CERTIFICATE_NOT_FOUND', 404, 'Certificate not found');
      await this.checkVerifier(ctx, c.personId);
      if (statusOn(c.status as 'review', c.expiresOn, todayIst()) === 'expired') throw new AppError('HRMS_CERTIFICATE_EXPIRED', 409, 'This certificate has expired');
      await this.repo.verifyCertificate(tx, c.id, ctx.personId);
    });
    return (await this.repo.certificate(ctx.tenantId, publicId))!;
  }

  /** The file: for the person, whoever may verify their certificates, or HR. */
  async certificateFile(ctx: RequestContext, publicId: string): Promise<{ data: Buffer; contentType: string }> {
    const c = await this.db.transaction((tx) => this.repo.lockCertificate(tx, ctx.tenantId, publicId));
    if (!c) throw new AppError('HRMS_CERTIFICATE_NOT_FOUND', 404, 'Certificate not found');
    const allowed = c.personId === ctx.personId || ctx.permissions[SKILLS.manage] === 'all' || await this.inScope(ctx, SKILLS.verify, c.personId);
    if (!allowed) throw new AppError('FORBIDDEN', 403, 'This certificate is outside what you may see');
    if (!c.filePath) throw new AppError('HRMS_NO_FILE', 404, 'No file stored for this certificate');
    return { data: await readUpload(c.filePath), contentType: CONTENT_TYPES[c.fileType as DocumentType] };
  }

  /** People (current jobs) with their skills and certificates; own / team / all by hrms.skills.view. */
  async matrix(ctx: RequestContext, q: SkillsMatrixQuery): Promise<SkillsMatrix> {
    const scope = ctx.permissions[SKILLS.view];
    const visibility: Visibility = scope === 'all' ? { scope: 'all' } : { scope: scope === 'team' ? 'team' : 'own', personId: ctx.personId };
    const jobs = await this.repo.jobs(ctx.tenantId, q.company, q.department, visibility);
    const personIds = [...new Set(jobs.map((j) => j.personId))];
    const skills = await this.repo.skillsOf(ctx.tenantId, personIds);
    const certs = await this.repo.certificatesOf(ctx.tenantId, personIds);
    const today = todayIst();
    const rows = jobs.map((j) => ({
      person: { publicId: j.personPublicId, displayName: j.personName },
      employment: { publicId: j.employmentPublicId, company: j.company, employeeCode: j.employeeCode,
        department: j.departmentCode ? { code: j.departmentCode, name: j.departmentName! } : null },
      skills: skills.filter((s) => s.personId === j.personId).map(({ personId: _p, ...s }) => s),
      certificates: certs.filter((c) => c.personId === j.personId).map(({ personId: _p, ...c }) => ({ ...c, status: statusOn(c.status, c.expiresOn, today) })),
    }));
    return { rows: q.skill ? rows.filter((r) => r.skills.some((s) => s.skill.code === q.skill)) : rows };
  }

  /** HR: certificates still valid that expire within the next days (worked out now, whether or not the job ran). */
  async expiring(ctx: RequestContext, q: ExpiringCertificatesQuery): Promise<ExpiringCertificates> {
    requireAll(ctx, SKILLS.manage);
    const today = todayIst();
    const until = addDays(today, q.days);
    const certs = await this.repo.expiring(ctx.tenantId, today, until);
    return { today, until, certificates: certs.map(({ personId: _p, ...c }) => ({ ...c, daysLeft: daysLeft(c.expiresOn!, today) })) };
  }

  /** The daily job (all tenants): stores certificates past their date as expired; counts those expiring within 30 days. */
  async runDaily(today = todayIst()): Promise<{ markedExpired: number; expiringWithin30Days: number }> {
    const markedExpired = await this.repo.markExpired(this.db, today);
    return { markedExpired, expiringWithin30Days: await this.repo.countExpiring(today, addDays(today, 30)) };
  }

  private async person(ctx: RequestContext, publicId: string): Promise<number> {
    const id = await this.repo.findPersonId(ctx.tenantId, publicId);
    if (!id) throw new AppError('HRMS_PERSON_NOT_FOUND', 404, 'Person not found');
    return id;
  }

  /** own: yourself; team: yourself and people you manage; all: anyone. */
  private async inScope(ctx: RequestContext, permission: string, personId: number): Promise<boolean> {
    const scope = ctx.permissions[permission];
    if (scope === 'all') return true;
    if (personId === ctx.personId) return scope === 'own' || scope === 'team';
    return scope === 'team' && this.repo.manages(ctx.personId, personId);
  }

  private async checkScope(ctx: RequestContext, permission: string, personId: number): Promise<void> {
    if (!(await this.inScope(ctx, permission, personId))) throw new AppError('FORBIDDEN', 403, 'This person is outside what you may change');
  }

  /** Never your own; the manager (team) or HR (all). */
  private async checkVerifier(ctx: RequestContext, personId: number): Promise<void> {
    if (personId === ctx.personId) throw new AppError('HRMS_SELF_VERIFICATION', 403, 'Nobody can verify their own skill or certificate');
    await this.checkScope(ctx, SKILLS.verify, personId);
  }
}
