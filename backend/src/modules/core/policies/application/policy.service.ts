import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CreatePolicyRequest, PoliciesQuery, Policy, PolicyInForce, PolicyInForceQuery, POLICIES, PolicyKey } from '@ageless/shared';
import { DB, Db, violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext, requireAll } from '../../../../platform/http/request-context';
import { PoliciesRepository } from '../infrastructure/policies.repository';
import { versionInForce } from '../domain/in-force';

export const MANAGE_POLICIES = 'core.policies.manage';

/** Company policies: versions are only ever added; other modules read them through CoreFacade.getPolicy. */
@Injectable()
export class PolicyService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PoliciesRepository) private readonly repo: PoliciesRepository,
  ) {}

  /**
   * The value in force on `date` for one company (null: the group), or `fallback` when no version is in force yet.
   * The company's own newest version comes before the group default.
   */
  async get<T>(tenantId: number, key: string, companyId: number | null, date: string, fallback: T): Promise<T> {
    const found = versionInForce(await this.repo.effectiveVersions(tenantId, key, companyId, date), companyId, date);
    return found ? (found.value as T) : fallback;
  }

  async list(ctx: RequestContext, q: PoliciesQuery): Promise<Policy[]> {
    requireAll(ctx, MANAGE_POLICIES);
    return this.repo.list(ctx.tenantId, q.key, q.company ? (await this.company(ctx, q.company)) : undefined);
  }

  async inForce(ctx: RequestContext, q: PolicyInForceQuery): Promise<PolicyInForce> {
    requireAll(ctx, MANAGE_POLICIES);
    const companyId = q.company ? await this.company(ctx, q.company) : null;
    const found = versionInForce(await this.repo.effectiveVersions(ctx.tenantId, q.key, companyId, q.date), companyId, q.date);
    const source = found ? (await this.repo.policy(found.id))! : null;
    return { key: q.key, company: q.company ?? null, date: q.date, value: source ? source.value : POLICIES[q.key as PolicyKey].default, source };
  }

  /** A new version (numbered after the newest of that key for the group or that company). Same publicId again: the stored one. */
  async create(ctx: RequestContext, req: CreatePolicyRequest): Promise<{ policy: Policy; created: boolean }> {
    requireAll(ctx, MANAGE_POLICIES);
    if (req.publicId) {
      const tenant = await this.repo.findTenant(req.publicId);
      if (tenant === ctx.tenantId) return { policy: (await this.repo.policy(req.publicId))!, created: false };
      if (tenant !== undefined) throw new AppError('CORE_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const companyId = req.company ? await this.company(ctx, req.company) : null;
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        const version = await this.repo.nextVersion(tx, ctx.tenantId, req.key, companyId);
        await this.repo.insert(tx, {
          tenantId: ctx.tenantId, publicId, legalEntityId: companyId, policyKey: req.key, value: req.value, version,
          effectiveFrom: req.effectiveFrom, approvedBy: ctx.personId,
        });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'policies_public_id_unique') return this.create(ctx, req); // the same request twice at once
      throw err;
    }
    return { policy: (await this.repo.policy(publicId))!, created: true };
  }

  private async company(ctx: RequestContext, code: string): Promise<number> {
    const company = await this.repo.findCompany(ctx.tenantId, code);
    if (!company) throw new AppError('CORE_UNKNOWN_COMPANY', 400, `Unknown company ${code}`);
    return company.id;
  }
}
