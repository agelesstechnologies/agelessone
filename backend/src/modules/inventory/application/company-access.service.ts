import { Inject, Injectable } from '@nestjs/common';
import { PgTable } from 'drizzle-orm/pg-core';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { Company, InventoryRepository } from '../infrastructure/inventory.repository';
import { LocationReach, locationReach, mayUseCompany, reachableCompanies, Scope } from '../domain/access';
import { responsibleLocations } from '../domain/locations';

/** What the location checks need of each location. */
export interface LocationFacts { id: number; legalEntityId: number; parentId: number | null; custodianEmploymentId: number | null }

/**
 * Keeps the companies apart: a person reaches a company's inventory with scope all (Management), or with a narrower scope
 * while they have a current job in that company. Inside a company, scope own narrows locations to the ones the person is
 * responsible for. Every inventory use case asks here first.
 */
@Injectable()
export class CompanyAccess {
  constructor(@Inject(InventoryRepository) private readonly repo: InventoryRepository) {}

  /** The companies the caller reaches with any of these permissions. */
  async reachable(ctx: RequestContext, permissions: string[]): Promise<Company[]> {
    const scopes = this.scopes(ctx, permissions);
    const all = await this.repo.companies(ctx.tenantId);
    const worked = scopes.includes('all') ? [] : await this.repo.companiesWorkedIn(ctx.personId);
    const ids = reachableCompanies(scopes, all.map((c) => c.id), worked);
    return all.filter((c) => ids.includes(c.id));
  }

  /** The company with this code, when the caller may use it with one of these permissions (400 unknown, 403 not theirs). */
  async require(ctx: RequestContext, permissions: string[], code: string): Promise<Company> {
    const company = (await this.repo.companies(ctx.tenantId)).find((c) => c.code === code);
    if (!company) throw new AppError('INVENTORY_UNKNOWN_COMPANY', 400, `Unknown company ${code}`);
    if (!(await this.mayUse(ctx, permissions, company.id))) throw notYours(code);
    return company;
  }

  /** For lists: the company asked for (checked as in require), else every company the caller reaches. */
  async forList(ctx: RequestContext, permissions: string[], code: string | undefined): Promise<Company[]> {
    return code === undefined ? this.reachable(ctx, permissions) : [await this.require(ctx, permissions, code)];
  }

  async mayUse(ctx: RequestContext, permissions: string[], legalEntityId: number): Promise<boolean> {
    const scopes = this.scopes(ctx, permissions);
    if (scopes.includes('all')) return true;
    return mayUseCompany(scopes, (await this.repo.companiesWorkedIn(ctx.personId)).includes(legalEntityId));
  }

  /**
   * The locations (ids) of `rows` the caller reaches with any of these permissions: every location of a company with
   * scope all, or team in a company they work in; with own only the ones they are responsible for (custodian, or the
   * custodian a rack or bin falls back to). `rows` must hold all locations of the companies involved.
   */
  async reachableLocations(ctx: RequestContext, permissions: string[], rows: LocationFacts[]): Promise<Set<number>> {
    const scopes = this.scopes(ctx, permissions);
    const worked = scopes.includes('all') ? [] : await this.repo.companiesWorkedIn(ctx.personId);
    const reach = new Map<number, LocationReach>();
    for (const r of rows) if (!reach.has(r.legalEntityId)) reach.set(r.legalEntityId, locationReach(scopes, worked.includes(r.legalEntityId)));
    const needsJobs = [...reach.values()].includes('responsible');
    const mine = needsJobs ? responsibleLocations(rows, await this.repo.currentJobIds(ctx.personId)) : new Set<number>();
    return new Set(rows.filter((r) => reach.get(r.legalEntityId) === 'every' || (reach.get(r.legalEntityId) === 'responsible' && mine.has(r.id))).map((r) => r.id));
  }

  /** Whether the caller reaches every location of the company (scope team there, or all) with one of these permissions. */
  async reachesEveryLocation(ctx: RequestContext, permissions: string[], legalEntityId: number): Promise<boolean> {
    const scopes = this.scopes(ctx, permissions);
    if (scopes.includes('all')) return true;
    return locationReach(scopes, (await this.repo.companiesWorkedIn(ctx.personId)).includes(legalEntityId)) === 'every';
  }

  /** Refuses with 403 when the caller may not change a record of this company. */
  async requireChange(ctx: RequestContext, permission: string, legalEntityId: number, company: string): Promise<void> {
    if (!(await this.mayUse(ctx, [permission], legalEntityId))) throw notYours(company);
  }

  /**
   * A create sent again with the same publicId: true when the record is already stored in the caller's tenant (answer it),
   * false when the id is new; 409 when another tenant uses it.
   */
  async alreadyStored(ctx: RequestContext, table: PgTable, publicId: string | undefined): Promise<boolean> {
    if (publicId === undefined) return false;
    const tenant = await this.repo.tenantOf(table, publicId);
    if (tenant !== undefined && tenant !== ctx.tenantId) throw new AppError('INVENTORY_DUPLICATE_ID', 409, 'This publicId is already used');
    return tenant === ctx.tenantId;
  }

  private scopes(ctx: RequestContext, permissions: string[]): Scope[] {
    return permissions.map((p) => ctx.permissions[p]);
  }
}

const notYours = (company: string) =>
  new AppError('INVENTORY_NOT_YOUR_COMPANY', 403, `You can use only the inventory of a company you work in (${company} is not one)`);
