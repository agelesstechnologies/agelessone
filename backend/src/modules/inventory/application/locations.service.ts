import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CreateLocationRequest, Custodian, Location, LocationsQuery, RecordStatus, UpdateLocationRequest } from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { locations } from '../schema';
import { InventoryRepository } from '../infrastructure/inventory.repository';
import { LocationRow, LocationsRepository } from '../infrastructure/locations.repository';
import { needsCustodian, placementProblem, responsibleFor } from '../domain/locations';
import { INVENTORY, INVENTORY_READ } from '../domain/permissions';
import { CompanyAccess } from './company-access.service';
import { isResentCreate, maybePersonRef, personRef } from './support';

/**
 * Each company's store locations: stores with racks and bins, work areas, testing spaces, transit, quarantine and scrap.
 * The custodian is a person with a current job in the location's company (stored as that job, so it can never be another
 * company's); racks and bins may fall back to their parent's. Type and parent never change. Locations become inactive,
 * never deleted: a location with active racks or bins inside stays active.
 */
@Injectable()
export class LocationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LocationsRepository) private readonly repo: LocationsRepository,
    @Inject(InventoryRepository) private readonly base: InventoryRepository,
    @Inject(CompanyAccess) private readonly access: CompanyAccess,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async list(ctx: RequestContext, q: LocationsQuery): Promise<Location[]> {
    const companies = await this.access.forList(ctx, INVENTORY_READ, q.company);
    const rows = await this.repo.list(this.db, ctx.tenantId, companies.map((c) => c.id));
    const reach = await this.access.reachableLocations(ctx, INVENTORY_READ, rows);
    const view = toLocations(rows);
    return rows.filter((r) => reach.has(r.id) && (q.type === undefined || r.type === q.type) && (q.status === undefined || r.status === q.status))
      .map((r) => view(r));
  }

  async get(ctx: RequestContext, publicId: string): Promise<Location> {
    const { row, all } = await this.visible(this.db, ctx, publicId);
    return toLocations(all)(row);
  }

  /** The same publicId again answers the stored location (created: false). */
  async create(ctx: RequestContext, req: CreateLocationRequest): Promise<{ location: Location; created: boolean }> {
    if (await this.access.alreadyStored(ctx, locations, req.publicId)) return { location: await this.get(ctx, req.publicId as string), created: false };
    const company = await this.access.require(ctx, [INVENTORY.locations], req.company);
    if (!(await this.access.reachesEveryLocation(ctx, [INVENTORY.locations], company.id))) throw addNeedsTeam();
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        let parent: LocationRow | undefined;
        if (req.parentPublicId) {
          parent = await this.repo.get(tx, ctx.tenantId, req.parentPublicId);
          if (!parent || parent.legalEntityId !== company.id) throw new AppError('INVENTORY_UNKNOWN_PARENT', 400, `That parent location does not belong to ${company.code}`);
          if (parent.status !== 'active') throw new AppError('INVENTORY_PARENT_INACTIVE', 409, `The location ${parent.code} is inactive`);
        }
        const placement = placementProblem(req.type, parent?.type ?? null);
        if (placement) throw new AppError('INVENTORY_LOCATION_PLACEMENT', 400, capitalise(placement));
        const custodianId = req.custodianPersonPublicId ? await this.custodianJob(tx, ctx, company.id, company.code, req.custodianPersonPublicId) : null;
        if (custodianId === null && needsCustodian(req.type)) {
          throw new AppError('INVENTORY_CUSTODIAN_NEEDED', 400, 'Choose the custodian: the person responsible for this location');
        }
        await this.repo.insert(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: company.id, type: req.type, code: req.code, name: req.name,
          parentId: parent?.id ?? null, custodianEmploymentId: custodianId, createdBy: ctx.personId });
        await this.audit(tx, ctx, 'inventory.location.created', publicId, company.id, `Added location ${req.code} (${req.name}) to ${company.code}`,
          { code: req.code, type: req.type, parent: parent?.code ?? null });
      });
    } catch (err) {
      if (isResentCreate(err)) return { location: await this.get(ctx, publicId), created: false };
      throw refuse(err) ?? err;
    }
    return { location: await this.get(ctx, publicId), created: true };
  }

  /** Sending what is already stored changes nothing. */
  async update(ctx: RequestContext, publicId: string, req: UpdateLocationRequest): Promise<Location> {
    return this.db.transaction(async (tx) => {
      const { row: loc, all } = await this.visible(tx, ctx, publicId, true);
      if (!(await this.access.reachableLocations(ctx, [INVENTORY.locations], all)).has(loc.id)) {
        throw new AppError('INVENTORY_NOT_YOUR_LOCATION', 403, `You can change only the locations you look after (${loc.code} is not one)`);
      }
      const patch: { name?: string; custodianEmploymentId?: number | null; status?: RecordStatus } = {};
      if (req.name !== undefined && req.name !== loc.name) patch.name = req.name;
      if (req.custodianPersonPublicId !== undefined && req.custodianPersonPublicId !== loc.custodianPublicId) {
        if (req.custodianPersonPublicId === null) {
          if (needsCustodian(loc.type)) throw new AppError('INVENTORY_CUSTODIAN_NEEDED', 400, 'This location needs a custodian; only racks and bins can leave it to their parent');
          patch.custodianEmploymentId = null;
        } else {
          patch.custodianEmploymentId = await this.custodianJob(tx, ctx, loc.legalEntityId, loc.company, req.custodianPersonPublicId);
        }
      }
      if (req.status !== undefined && req.status !== loc.status) {
        if (req.status === 'inactive' && await this.repo.hasActiveChildren(tx, loc.id)) {
          throw new AppError('INVENTORY_LOCATION_HAS_CHILDREN', 409, `Make the racks and bins inside ${loc.code} inactive first`);
        }
        if (req.status === 'active' && loc.parentId !== null && !(await this.repo.parentActive(tx, loc.parentId))) {
          throw new AppError('INVENTORY_PARENT_INACTIVE', 409, 'Make its parent location active first');
        }
        patch.status = req.status;
      }
      const changed = Object.keys(patch);
      if (changed.length === 0) return toLocations(all)(loc);
      await this.repo.update(tx, loc.id, { ...patch, updatedBy: ctx.personId, updatedAt: new Date() });
      const [action, verb] = changed.length === 1 && patch.status !== undefined
        ? (patch.status === 'active' ? ['inventory.location.reactivated', 'Reactivated'] : ['inventory.location.deactivated', 'Deactivated'])
        : ['inventory.location.updated', 'Changed'];
      await this.audit(tx, ctx, action, publicId, loc.legalEntityId, `${verb} location ${loc.code} of ${loc.company}`, { code: loc.code, changed });
      const after = await this.visible(tx, ctx, publicId);
      return toLocations(after.all)(after.row);
    });
  }

  // ---- helpers ----

  /**
   * A location the caller reaches, with every location of its company (for its parent and fallback custodian). Another
   * company's location, or with scope own one the caller is not responsible for, is unknown (404).
   */
  private async visible(conn: Conn, ctx: RequestContext, publicId: string, lock = false): Promise<{ row: LocationRow; all: LocationRow[] }> {
    const row = await this.repo.get(conn, ctx.tenantId, publicId, lock);
    const all = row ? await this.repo.list(conn, ctx.tenantId, [row.legalEntityId]) : [];
    if (!row || !(await this.access.reachableLocations(ctx, INVENTORY_READ, all)).has(row.id)) throw new AppError('INVENTORY_LOCATION_NOT_FOUND', 404, 'Unknown location');
    return { row, all };
  }

  /** The custodian's current job (active or on notice) in the location's company. */
  private async custodianJob(tx: Tx, ctx: RequestContext, legalEntityId: number, company: string, personPublicId: string): Promise<number> {
    const { personExists, jobId } = await this.base.currentJob(tx, ctx.tenantId, personPublicId, legalEntityId);
    if (!personExists) throw new AppError('INVENTORY_BAD_CUSTODIAN', 400, 'Unknown person');
    if (jobId === null) throw new AppError('INVENTORY_BAD_CUSTODIAN', 400, `The custodian must have a current job in ${company}`);
    return jobId;
  }

  private audit(tx: Tx, ctx: RequestContext, action: string, publicId: string, legalEntityId: number, summary: string, details: Record<string, unknown>) {
    return this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action, entity: 'inventory_location', entityPublicId: publicId, legalEntityId, summary, details });
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Adding (or importing) locations is for people who reach every location of the company: scope team or all. */
export const addNeedsTeam = () => new AppError('INVENTORY_LOCATION_SCOPE', 403,
  'Adding locations needs a store role with scope team (Store in-charge or Inventory controller); a storekeeper looks after the locations given to them');

function refuse(err: unknown): AppError | undefined {
  if (violatedConstraint(err) === 'locations_company_code_unique') return new AppError('INVENTORY_DUPLICATE_LOCATION_CODE', 409, 'This company already has a location with that code');
  return undefined;
}

/** Turns rows into API locations; `all` holds the rows of the same companies, for parents and fallback custodians. */
function toLocations(all: LocationRow[]): (r: LocationRow) => Location {
  const byId = new Map(all.map((r) => [r.id, { row: r, parentId: r.parentId, custodian: custodianOf(r) }]));
  return (r) => {
    const parent = r.parentId === null ? undefined : byId.get(r.parentId)?.row;
    return {
      publicId: r.publicId, company: r.company, type: r.type, code: r.code, name: r.name,
      parent: parent ? { publicId: parent.publicId, type: parent.type, code: parent.code, name: parent.name } : null,
      custodian: custodianOf(r), responsible: responsibleFor(r.id, byId), status: r.status,
      createdBy: personRef(r.createdByPublicId, r.createdByName), createdAt: r.createdAt.toISOString(),
      updatedBy: maybePersonRef(r.updatedByPublicId, r.updatedByName), updatedAt: r.updatedAt?.toISOString() ?? null,
    };
  };
}

function custodianOf(r: LocationRow): Custodian | null {
  if (r.custodianEmploymentPublicId === null || r.custodianPublicId === null) return null;
  return { person: { publicId: r.custodianPublicId, displayName: r.custodianName ?? '' }, employmentPublicId: r.custodianEmploymentPublicId,
    employeeCode: r.custodianEmployeeCode ?? '' };
}
