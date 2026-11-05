import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CreateDepartmentRequest, CreatePositionRequest, Department, DepartmentsQuery, Designation, DesignationsQuery, FillPositionRequest,
  Position, PositionsQuery, PositionStatusRequest, UpdateDepartmentRequest,
} from '@ageless/shared';
import { DB, Db, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireAll, requireReadAll } from '../../../../platform/http/request-context';
import { OrganisationRepository } from '../infrastructure/organisation.repository';
import { PEOPLE } from '../domain/permissions';

/** Use cases live here: a company's departments (with their heads), designations and positions. */
@Injectable()
export class OrganisationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OrganisationRepository) private readonly repo: OrganisationRepository,
  ) {}

  departments(ctx: RequestContext, q: DepartmentsQuery): Promise<Department[]> {
    return this.repo.departments(ctx.tenantId, q.company);
  }

  async createDepartment(ctx: RequestContext, req: CreateDepartmentRequest): Promise<Department> {
    requireAll(ctx, PEOPLE.manageEmployments);
    const legalEntityId = await this.companyId(ctx, req.company);
    try {
      const publicId = await this.repo.insertDepartment({ tenantId: ctx.tenantId, legalEntityId, name: req.name, codePrefix: req.codePrefix });
      return (await this.repo.department(ctx.tenantId, publicId))!;
    } catch (err) {
      const c = violatedConstraint(err);
      if (c === 'departments_company_prefix_unique' || c === 'departments_company_name_unique') {
        throw new AppError('HRMS_DUPLICATE_DEPARTMENT', 409, 'This company already has a department with that name or code prefix');
      }
      throw err;
    }
  }

  /** Rename, or set / clear the head (the approver after the manager). */
  async updateDepartment(ctx: RequestContext, publicId: string, req: UpdateDepartmentRequest): Promise<Department> {
    requireAll(ctx, PEOPLE.manageEmployments);
    const patch: { name?: string; headPersonId?: number | null } = {};
    if (req.name !== undefined) patch.name = req.name;
    if (req.headPublicId !== undefined) {
      patch.headPersonId = req.headPublicId === null ? null : await this.repo.findPersonId(ctx.tenantId, req.headPublicId) ?? null;
      if (req.headPublicId !== null && patch.headPersonId === null) throw new AppError('HRMS_PERSON_NOT_FOUND', 404, 'Department head not found');
    }
    if (!(await this.repo.updateDepartment(ctx.tenantId, publicId, patch))) throw new AppError('HRMS_DEPARTMENT_NOT_FOUND', 404, 'Department not found');
    return (await this.repo.department(ctx.tenantId, publicId))!;
  }

  designations(ctx: RequestContext, q: DesignationsQuery): Promise<Designation[]> {
    return this.repo.designations(ctx.tenantId, q.company);
  }

  positions(ctx: RequestContext, q: PositionsQuery): Promise<Position[]> {
    requireReadAll(ctx, PEOPLE.managePositions);
    return this.repo.positions(ctx.tenantId, q);
  }

  /** A planned or open position. The same publicId again returns the stored one. */
  async createPosition(ctx: RequestContext, req: CreatePositionRequest): Promise<{ position: Position; created: boolean }> {
    requireAll(ctx, PEOPLE.managePositions);
    if (req.publicId) {
      const tenant = await this.repo.findPositionTenant(req.publicId);
      if (tenant === ctx.tenantId) return { position: (await this.repo.position(ctx.tenantId, req.publicId))!, created: false };
      if (tenant !== undefined) throw new AppError('HRMS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const legalEntityId = await this.companyId(ctx, req.company);
    const department = await this.repo.findDepartment(ctx.tenantId, legalEntityId, req.departmentCode);
    if (!department) throw new AppError('HRMS_UNKNOWN_DEPARTMENT', 400, `Unknown department ${req.departmentCode} in ${req.company}`);
    const designation = await this.repo.findDesignation(legalEntityId, req.designation);
    if (!designation) throw new AppError('HRMS_UNKNOWN_DESIGNATION', 400, `Unknown designation ${req.designation} in ${req.company}`);
    const publicId = req.publicId ?? randomUUID();
    await this.repo.insertPosition({
      tenantId: ctx.tenantId, publicId, legalEntityId, departmentId: department.id, designationId: designation.id,
      status: req.status, notes: req.notes, createdBy: ctx.personId,
    });
    return { position: (await this.repo.position(ctx.tenantId, publicId))!, created: true };
  }

  /** Between planned and open; a filled position stays filled. */
  async setPositionStatus(ctx: RequestContext, publicId: string, req: PositionStatusRequest): Promise<Position> {
    requireAll(ctx, PEOPLE.managePositions);
    await this.db.transaction(async (tx) => {
      const p = await this.lockPosition(tx, ctx, publicId);
      if (p.status === 'filled') throw new AppError('HRMS_POSITION_FILLED', 409, 'This position is already filled');
      await this.repo.setPositionStatus(tx, p.id, req.status);
    });
    return (await this.repo.position(ctx.tenantId, publicId))!;
  }

  /** Filled by the employment of the person hired — a joining or active job in the same company. */
  async fillPosition(ctx: RequestContext, publicId: string, req: FillPositionRequest): Promise<Position> {
    requireAll(ctx, PEOPLE.managePositions);
    await this.db.transaction(async (tx) => {
      const p = await this.lockPosition(tx, ctx, publicId);
      if (p.status === 'filled') throw new AppError('HRMS_POSITION_FILLED', 409, 'This position is already filled');
      const job = await this.repo.findEmployment(tx, ctx.tenantId, req.employmentPublicId);
      if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
      if (job.legalEntityId !== p.legalEntityId) throw new AppError('HRMS_OTHER_COMPANY', 400, 'The employment is in another company');
      if (job.status !== 'joining' && job.status !== 'active') throw new AppError('HRMS_EMPLOYMENT_NOT_ACTIVE', 409, 'This job has ended');
      await this.repo.fillPosition(tx, p.id, job.id);
    });
    return (await this.repo.position(ctx.tenantId, publicId))!;
  }

  private async lockPosition(tx: Parameters<OrganisationRepository['lockPosition']>[0], ctx: RequestContext, publicId: string) {
    const p = await this.repo.lockPosition(tx, ctx.tenantId, publicId);
    if (!p) throw new AppError('HRMS_POSITION_NOT_FOUND', 404, 'Position not found');
    return p;
  }

  private async companyId(ctx: RequestContext, code: string): Promise<number> {
    const company = await this.repo.findCompany(ctx.tenantId, code);
    if (!company) throw new AppError('HRMS_UNKNOWN_COMPANY', 400, `Unknown company ${code}`);
    return company.id;
  }
}
