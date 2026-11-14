import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RecordStatus, CreateUnitRequest, Unit, UnitsQuery, UpdateUnitRequest } from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { units } from '../schema';
import { CatalogRepository, UnitRow } from '../infrastructure/catalog.repository';
import { INVENTORY, INVENTORY_READ } from '../domain/permissions';
import { CompanyAccess } from './company-access.service';
import { isResentCreate, personRef } from './support';

/**
 * The units each company counts in. The code never changes; decimals change only while no item uses the unit (quantities
 * already written in it would no longer fit). Inactive units take no new items; their items keep them.
 */
@Injectable()
export class UnitsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CatalogRepository) private readonly repo: CatalogRepository,
    @Inject(CompanyAccess) private readonly access: CompanyAccess,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async list(ctx: RequestContext, q: UnitsQuery): Promise<Unit[]> {
    const companies = await this.access.forList(ctx, INVENTORY_READ, q.company);
    return (await this.repo.listUnits(ctx.tenantId, companies.map((c) => c.id), q.status)).map(toUnit);
  }

  async get(ctx: RequestContext, publicId: string): Promise<Unit> {
    return toUnit(await this.visible(this.db, ctx, publicId));
  }

  /** The same publicId again answers the stored unit (created: false). */
  async create(ctx: RequestContext, req: CreateUnitRequest): Promise<{ unit: Unit; created: boolean }> {
    if (await this.access.alreadyStored(ctx, units, req.publicId)) return { unit: await this.get(ctx, req.publicId as string), created: false };
    const company = await this.access.require(ctx, [INVENTORY.items], req.company);
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.insertUnit(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: company.id, code: req.code, name: req.name,
          decimals: req.decimals, createdBy: ctx.personId });
        await this.audit(tx, ctx, 'inventory.unit.created', publicId, company.id, `Added unit ${req.code} (${req.name}) to ${company.code}`,
          { code: req.code, decimals: req.decimals });
      });
    } catch (err) {
      if (isResentCreate(err)) return { unit: await this.get(ctx, publicId), created: false };
      throw refuse(err) ?? err;
    }
    return { unit: await this.get(ctx, publicId), created: true };
  }

  /** Sending what is already stored changes nothing. */
  async update(ctx: RequestContext, publicId: string, req: UpdateUnitRequest): Promise<Unit> {
    return this.db.transaction(async (tx) => {
      const unit = await this.visible(tx, ctx, publicId, true);
      await this.access.requireChange(ctx, INVENTORY.items, unit.legalEntityId, unit.company);
      const patch: { name?: string; decimals?: number; status?: RecordStatus } = {};
      if (req.name !== undefined && req.name !== unit.name) patch.name = req.name;
      if (req.status !== undefined && req.status !== unit.status) patch.status = req.status;
      if (req.decimals !== undefined && req.decimals !== unit.decimals) {
        if (await this.repo.unitInUse(tx, unit.id)) {
          throw new AppError('INVENTORY_UNIT_IN_USE', 409, `Items already use ${unit.code}, so its decimals can no longer change; add a new unit instead`);
        }
        patch.decimals = req.decimals;
      }
      const changed = Object.keys(patch);
      if (changed.length === 0) return toUnit(unit);
      await this.repo.updateUnit(tx, unit.id, patch);
      const [action, verb] = changed.length === 1 && patch.status !== undefined
        ? (patch.status === 'active' ? ['inventory.unit.reactivated', 'Reactivated'] : ['inventory.unit.deactivated', 'Deactivated'])
        : ['inventory.unit.updated', 'Changed'];
      await this.audit(tx, ctx, action, publicId, unit.legalEntityId, `${verb} unit ${unit.code} of ${unit.company}`, { code: unit.code, changed, ...patch });
      return toUnit(await this.visible(tx, ctx, publicId));
    });
  }

  /** A unit of a company the caller reaches; anything else is unknown (404), so other companies' records stay unseen. */
  private async visible(conn: Conn, ctx: RequestContext, publicId: string, lock = false): Promise<UnitRow> {
    const row = await this.repo.unit(conn, ctx.tenantId, publicId, lock);
    if (!row || !(await this.access.mayUse(ctx, INVENTORY_READ, row.legalEntityId))) throw new AppError('INVENTORY_UNIT_NOT_FOUND', 404, 'Unknown unit');
    return row;
  }

  private audit(tx: Tx, ctx: RequestContext, action: string, publicId: string, legalEntityId: number, summary: string, details: Record<string, unknown>) {
    return this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action, entity: 'inventory_unit', entityPublicId: publicId, legalEntityId, summary, details });
  }
}

function refuse(err: unknown): AppError | undefined {
  if (violatedConstraint(err) === 'units_company_code_unique') return new AppError('INVENTORY_DUPLICATE_UNIT_CODE', 409, 'This company already has a unit with that code');
  return undefined;
}

export function toUnit(r: UnitRow): Unit {
  return { publicId: r.publicId, company: r.company, code: r.code, name: r.name, decimals: r.decimals, status: r.status,
    createdBy: personRef(r.createdByPublicId, r.createdByName), createdAt: r.createdAt.toISOString() };
}
