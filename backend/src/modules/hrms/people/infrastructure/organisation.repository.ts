import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { Department, Designation, Position, PositionStatus } from '@ageless/shared';
import { DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { departments, designations, employments, positions } from '../schema';

/** Writes only hrms.departments and hrms.positions; reads companies, designations, jobs and people. */
@Injectable()
export class OrganisationRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findCompany(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: legalEntities.id }).from(legalEntities).where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row;
  }

  async findPersonId(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: persons.id }).from(persons).where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, publicId)));
    return row?.id;
  }

  // ---- departments ----

  async departments(tenantId: number, company?: string): Promise<Department[]> {
    const rows = await this.departmentView().where(and(eq(departments.tenantId, tenantId), company ? eq(legalEntities.code, company) : undefined))
      .orderBy(asc(legalEntities.code), asc(departments.name));
    return rows.map(toDepartment);
  }

  async department(tenantId: number, publicId: string): Promise<Department | undefined> {
    const [row] = await this.departmentView().where(and(eq(departments.tenantId, tenantId), eq(departments.publicId, publicId)));
    return row && toDepartment(row);
  }

  async findDepartment(tenantId: number, legalEntityId: number, codePrefix: string) {
    const [row] = await this.db.select({ id: departments.id }).from(departments)
      .where(and(eq(departments.tenantId, tenantId), eq(departments.legalEntityId, legalEntityId), eq(departments.codePrefix, codePrefix)));
    return row;
  }

  async insertDepartment(v: { tenantId: number; legalEntityId: number; name: string; codePrefix: string }): Promise<string> {
    const [row] = await this.db.insert(departments).values(v).returning({ publicId: departments.publicId });
    return row.publicId;
  }

  async updateDepartment(tenantId: number, publicId: string, patch: { name?: string; headPersonId?: number | null }): Promise<boolean> {
    const rows = await this.db.update(departments).set(patch)
      .where(and(eq(departments.tenantId, tenantId), eq(departments.publicId, publicId))).returning({ id: departments.id });
    return rows.length > 0;
  }

  // ---- designations ----

  async designations(tenantId: number, company?: string): Promise<Designation[]> {
    return this.db.select({ publicId: designations.publicId, company: legalEntities.code, name: designations.name })
      .from(designations).innerJoin(legalEntities, eq(legalEntities.id, designations.legalEntityId))
      .where(and(eq(designations.tenantId, tenantId), company ? eq(legalEntities.code, company) : undefined))
      .orderBy(asc(legalEntities.code), asc(designations.name));
  }

  async findDesignation(legalEntityId: number, name: string) {
    const [row] = await this.db.select({ id: designations.id }).from(designations)
      .where(and(eq(designations.legalEntityId, legalEntityId), eq(designations.name, name)));
    return row;
  }

  // ---- positions ----

  async positions(tenantId: number, f: { company?: string; department?: string; status?: PositionStatus }): Promise<Position[]> {
    const rows = await this.positionView().where(and(eq(positions.tenantId, tenantId),
      f.company ? eq(legalEntities.code, f.company) : undefined, f.department ? eq(departments.codePrefix, f.department) : undefined,
      f.status ? eq(positions.status, f.status) : undefined))
      .orderBy(asc(legalEntities.code), asc(departments.name), desc(positions.createdAt));
    return rows.map(toPosition);
  }

  async position(tenantId: number, publicId: string): Promise<Position | undefined> {
    const [row] = await this.positionView().where(and(eq(positions.tenantId, tenantId), eq(positions.publicId, publicId)));
    return row && toPosition(row);
  }

  async findPositionTenant(publicId: string) {
    const [row] = await this.db.select({ tenantId: positions.tenantId }).from(positions).where(eq(positions.publicId, publicId));
    return row?.tenantId;
  }

  async insertPosition(v: { tenantId: number; publicId: string; legalEntityId: number; departmentId: number; designationId: number;
    status: string; notes?: string; createdBy: number }): Promise<void> {
    await this.db.insert(positions).values(v);
  }

  async lockPosition(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: positions.id, legalEntityId: positions.legalEntityId, status: positions.status })
      .from(positions).where(and(eq(positions.tenantId, tenantId), eq(positions.publicId, publicId))).for('update');
    return row;
  }

  async findEmployment(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: employments.id, legalEntityId: employments.legalEntityId, status: employments.status })
      .from(employments).where(and(eq(employments.tenantId, tenantId), eq(employments.publicId, publicId)));
    return row;
  }

  async setPositionStatus(tx: Tx, id: number, status: 'planned' | 'open'): Promise<void> {
    await tx.update(positions).set({ status }).where(eq(positions.id, id));
  }

  async fillPosition(tx: Tx, id: number, employmentId: number): Promise<void> {
    await tx.update(positions).set({ status: 'filled', filledByEmploymentId: employmentId, filledAt: new Date() }).where(eq(positions.id, id));
  }

  private departmentView() {
    return this.db.select({
      publicId: departments.publicId, company: legalEntities.code, name: departments.name, codePrefix: departments.codePrefix,
      headPublicId: persons.publicId, headName: persons.displayName,
    }).from(departments)
      .innerJoin(legalEntities, eq(legalEntities.id, departments.legalEntityId))
      .leftJoin(persons, eq(persons.id, departments.headPersonId))
      .$dynamic();
  }

  private positionView() {
    return this.db.select({
      publicId: positions.publicId, company: legalEntities.code, departmentCode: departments.codePrefix, departmentName: departments.name,
      designation: designations.name, status: positions.status, notes: positions.notes,
      employmentPublicId: employments.publicId, employeeCode: employments.employeeCode,
      personPublicId: persons.publicId, personName: persons.displayName, filledAt: positions.filledAt, createdAt: positions.createdAt,
    }).from(positions)
      .innerJoin(legalEntities, eq(legalEntities.id, positions.legalEntityId))
      .innerJoin(departments, eq(departments.id, positions.departmentId))
      .innerJoin(designations, eq(designations.id, positions.designationId))
      .leftJoin(employments, eq(employments.id, positions.filledByEmploymentId))
      .leftJoin(persons, eq(persons.id, employments.personId))
      .$dynamic();
  }
}

function toDepartment(r: { publicId: string; company: string; name: string; codePrefix: string; headPublicId: string | null; headName: string | null }): Department {
  return { publicId: r.publicId, company: r.company, name: r.name, codePrefix: r.codePrefix,
    head: r.headPublicId ? { publicId: r.headPublicId, displayName: r.headName! } : null };
}

function toPosition(r: { publicId: string; company: string; departmentCode: string; departmentName: string; designation: string; status: string;
  notes: string | null; employmentPublicId: string | null; employeeCode: string | null; personPublicId: string | null; personName: string | null;
  filledAt: Date | null; createdAt: Date }): Position {
  return {
    publicId: r.publicId, company: r.company, department: { code: r.departmentCode, name: r.departmentName }, designation: r.designation,
    status: r.status as PositionStatus, notes: r.notes,
    filledBy: r.employmentPublicId ? { employmentPublicId: r.employmentPublicId, employeeCode: r.employeeCode!, person: { publicId: r.personPublicId!, displayName: r.personName! } } : null,
    filledAt: r.filledAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
  };
}
