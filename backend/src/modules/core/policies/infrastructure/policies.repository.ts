import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { Policy } from '@ageless/shared';
import { DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons, policies } from '../../schema';

/** Writes only core.policies (insert only). */
@Injectable()
export class PoliciesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findCompany(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: legalEntities.id }).from(legalEntities).where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row;
  }

  /** Versions of one key, for the group and (if given) one company, already effective on the date. */
  async effectiveVersions(tenantId: number, key: string, companyId: number | null, date: string) {
    return this.db.select({ id: policies.id, legalEntityId: policies.legalEntityId, version: policies.version, effectiveFrom: policies.effectiveFrom, value: policies.value })
      .from(policies).where(and(eq(policies.tenantId, tenantId), eq(policies.policyKey, key), lte(policies.effectiveFrom, date),
        companyId === null ? isNull(policies.legalEntityId) : or(isNull(policies.legalEntityId), eq(policies.legalEntityId, companyId))));
  }

  async list(tenantId: number, key?: string, companyId?: number): Promise<Policy[]> {
    return this.view().where(and(eq(policies.tenantId, tenantId), key ? eq(policies.policyKey, key) : undefined,
      companyId !== undefined ? eq(policies.legalEntityId, companyId) : undefined))
      .orderBy(policies.policyKey, sql`${legalEntities.code} NULLS FIRST`, desc(policies.version))
      .then((rows) => rows.map(toPolicy));
  }

  async policy(id: number | string): Promise<Policy | undefined> {
    const [row] = await this.view().where(typeof id === 'number' ? eq(policies.id, id) : eq(policies.publicId, id));
    return row && toPolicy(row);
  }

  async findTenant(publicId: string) {
    const [row] = await this.db.select({ tenantId: policies.tenantId }).from(policies).where(eq(policies.publicId, publicId));
    return row?.tenantId;
  }

  /** The next version number for one key of the group or one company; the lock keeps two at once from taking the same. */
  async nextVersion(tx: Tx, tenantId: number, key: string, companyId: number | null): Promise<number> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`policy:${tenantId}:${key}:${companyId ?? 'group'}`}))`);
    const [row] = await tx.select({ max: sql<number>`coalesce(max(${policies.version}), 0)`.mapWith(Number) }).from(policies)
      .where(and(eq(policies.tenantId, tenantId), eq(policies.policyKey, key),
        companyId === null ? isNull(policies.legalEntityId) : eq(policies.legalEntityId, companyId)));
    return row.max + 1;
  }

  async insert(tx: Tx, v: { tenantId: number; publicId: string; legalEntityId: number | null; policyKey: string; value: unknown; version: number; effectiveFrom: string; approvedBy: number }) {
    await tx.insert(policies).values(v);
  }

  private view() {
    return this.db.select({
      publicId: policies.publicId, key: policies.policyKey, company: legalEntities.code, value: policies.value, version: policies.version,
      effectiveFrom: policies.effectiveFrom, approverPublicId: persons.publicId, approverName: persons.displayName, createdAt: policies.createdAt,
    }).from(policies)
      .leftJoin(legalEntities, eq(legalEntities.id, policies.legalEntityId))
      .innerJoin(persons, eq(persons.id, policies.approvedBy))
      .$dynamic();
  }
}

function toPolicy(r: { publicId: string; key: string; company: string | null; value: unknown; version: number; effectiveFrom: string;
  approverPublicId: string; approverName: string; createdAt: Date }): Policy {
  return {
    publicId: r.publicId, key: r.key, company: r.company, value: r.value, version: r.version, effectiveFrom: r.effectiveFrom,
    approvedBy: { publicId: r.approverPublicId, displayName: r.approverName }, createdAt: r.createdAt.toISOString(),
  };
}
