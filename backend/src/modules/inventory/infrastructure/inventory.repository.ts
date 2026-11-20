import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { Conn, DB, Db } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { employments } from '../../hrms/people/schema';

export interface Company { id: number; code: string }

/** A current job: the person works there now (joining has not started yet; exited has ended). */
export const CURRENT_JOB = ['active', 'notice'];

/** Lookups every inventory area shares: companies, jobs, and who already uses a public id. Writes nothing. */
@Injectable()
export class InventoryRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  companies(tenantId: number): Promise<Company[]> {
    return this.db.select({ id: legalEntities.id, code: legalEntities.code }).from(legalEntities)
      .where(eq(legalEntities.tenantId, tenantId)).orderBy(asc(legalEntities.code));
  }

  /** The companies the person has a current job in. */
  async companiesWorkedIn(personId: number): Promise<number[]> {
    const rows = await this.db.selectDistinct({ id: employments.legalEntityId }).from(employments)
      .where(and(eq(employments.personId, personId), inArray(employments.status, CURRENT_JOB)));
    return rows.map((r) => r.id);
  }

  /** The person's current jobs (custodianship is stored as a job). */
  async currentJobIds(personId: number): Promise<number[]> {
    const rows = await this.db.select({ id: employments.id }).from(employments)
      .where(and(eq(employments.personId, personId), inArray(employments.status, CURRENT_JOB)));
    return rows.map((r) => r.id);
  }

  /** Whether the person exists in the tenant, and their current job in the company (if any). */
  async currentJob(conn: Conn, tenantId: number, personPublicId: string, legalEntityId: number): Promise<{ personExists: boolean; jobId: number | null }> {
    const [person] = await conn.select({ id: persons.id }).from(persons).where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, personPublicId)));
    if (!person) return { personExists: false, jobId: null };
    const [job] = await conn.select({ id: employments.id }).from(employments).where(and(eq(employments.personId, person.id),
      eq(employments.legalEntityId, legalEntityId), inArray(employments.status, CURRENT_JOB)));
    return { personExists: true, jobId: job?.id ?? null };
  }

  /** A company's jobs by employee code (for the custodian column of a locations CSV). */
  async companyJobs(conn: Conn, legalEntityId: number): Promise<{ id: number; employeeCode: string; current: boolean }[]> {
    const rows = await conn.select({ id: employments.id, employeeCode: employments.employeeCode, status: employments.status })
      .from(employments).where(eq(employments.legalEntityId, legalEntityId));
    return rows.map((r) => ({ id: r.id, employeeCode: r.employeeCode, current: CURRENT_JOB.includes(r.status) }));
  }

  /** The tenant whose record already has this public id in an inventory table, if any (a resent create, or a clash). */
  async tenantOf(table: PgTable, publicId: string): Promise<number | undefined> {
    const res = await this.db.execute<{ tenant_id: string }>(sql`SELECT tenant_id FROM ${table} WHERE public_id = ${publicId} LIMIT 1`);
    return res.rows[0] ? Number(res.rows[0].tenant_id) : undefined;
  }
}
