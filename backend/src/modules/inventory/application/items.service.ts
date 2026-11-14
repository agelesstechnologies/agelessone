import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  Conversion, ConvertQuery, CopyItemRequest, CreateItemRequest, Item, ItemConversionInput, ItemList, ItemsQuery, LocationType, RecordStatus, UpdateItemRequest,
} from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { items } from '../schema';
import { CatalogRepository, CategoryRow, ConversionRow, ItemRow, UnitRow } from '../infrastructure/catalog.repository';
import { LocationsRepository } from '../infrastructure/locations.repository';
import { nextItemCode } from '../domain/codes';
import { changedFields, conversionProblems, ItemContent, itemProblems, UnitFacts } from '../domain/items';
import { fitsDecimals, toBaseQuantity } from '../domain/quantities';
import { INVENTORY, INVENTORY_READ } from '../domain/permissions';
import { CompanyAccess } from './company-access.service';
import { isResentCreate, maybePersonRef, personRef } from './support';

type ChosenConversion = { unitId: number; unitCode: string; factor: number };

/**
 * Each company's items and their unit conversions. Code and name (ignoring case) are unique per company; without a code
 * an item gets the next code of its category. Category, units and default location come from the item's own company and
 * must be active when chosen. The code never changes. Items become inactive, never deleted; changed conversions are ended
 * and added again, so history stays.
 */
@Injectable()
export class ItemsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CatalogRepository) private readonly repo: CatalogRepository,
    @Inject(LocationsRepository) private readonly locations: LocationsRepository,
    @Inject(CompanyAccess) private readonly access: CompanyAccess,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async list(ctx: RequestContext, q: ItemsQuery): Promise<ItemList> {
    const companies = await this.access.forList(ctx, INVENTORY_READ, q.company);
    const empty = { items: [], page: q.page, pageSize: q.pageSize, total: 0 };
    let categoryId: number | undefined;
    if (q.category) {
      const category = await this.repo.category(this.db, ctx.tenantId, q.category);
      if (!category || !companies.some((c) => c.id === category.legalEntityId)) return empty;
      categoryId = category.id;
    }
    const { rows, total } = await this.repo.listItems(ctx.tenantId, { companyIds: companies.map((c) => c.id), categoryId, status: q.status,
      tracking: q.tracking, stocked: q.stocked, search: q.search }, q.page, q.pageSize);
    const conversions = await this.repo.conversions(this.db, rows.map((r) => r.id));
    return { items: rows.map((r) => toItem(r, conversions)), page: q.page, pageSize: q.pageSize, total };
  }

  async get(ctx: RequestContext, publicId: string): Promise<Item> {
    return this.detail(this.db, await this.visible(this.db, ctx, publicId));
  }

  /** The same publicId again answers the stored item (created: false). */
  async create(ctx: RequestContext, req: CreateItemRequest): Promise<{ item: Item; created: boolean }> {
    if (await this.access.alreadyStored(ctx, items, req.publicId)) return { item: await this.get(ctx, req.publicId as string), created: false };
    const company = await this.access.require(ctx, [INVENTORY.items], req.company);
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.lockCategories(tx, company.id);
        const category = await this.chosenCategory(tx, ctx, company.id, req.categoryPublicId);
        const baseUnit = await this.chosenUnit(tx, ctx, company.id, req.baseUnitPublicId, 'baseUnitPublicId');
        const location = req.defaultLocationPublicId ? await this.chosenLocation(tx, ctx, company.id, req.defaultLocationPublicId) : null;
        const conversions = await this.chosenConversions(tx, ctx, company.id, req.conversions);
        const content: ItemContent = {
          name: req.name, description: req.description ?? null, categoryId: category.id, baseUnitId: baseUnit.id, tracking: req.tracking,
          hsnCode: req.hsnCode ?? null, isStocked: req.isStocked, reorderLevel: req.reorderLevel ?? null, reorderQty: req.reorderQty ?? null,
          defaultLocationId: location?.id ?? null,
        };
        requireValid(content, baseUnit, location?.type ?? null, conversions);
        const code = req.code ?? nextItemCode(category.codePrefix, await this.repo.codesWithPrefix(tx, company.id, category.codePrefix));
        const [id] = await this.repo.insertItems(tx, [{ tenantId: ctx.tenantId, publicId, legalEntityId: company.id, code, createdBy: ctx.personId, ...content }]);
        await this.addConversions(tx, ctx, company.id, id, conversions);
        await this.audit(tx, ctx, 'inventory.item.created', publicId, company.id, `Added item ${code} ${req.name} to ${company.code}`, { code });
      });
    } catch (err) {
      if (isResentCreate(err)) return { item: await this.get(ctx, publicId), created: false };
      throw refuse(err) ?? err;
    }
    return { item: await this.get(ctx, publicId), created: true };
  }

  /** Send only what changes; sending what is already stored changes nothing. */
  async update(ctx: RequestContext, publicId: string, req: UpdateItemRequest): Promise<Item> {
    try {
      return await this.db.transaction(async (tx) => {
        const item = await this.visible(tx, ctx, publicId, true);
        await this.access.requireChange(ctx, INVENTORY.items, item.legalEntityId, item.company);
        const company = item.legalEntityId;
        const categoryId = req.categoryPublicId === undefined || req.categoryPublicId === item.categoryPublicId
          ? item.categoryId : (await this.chosenCategory(tx, ctx, company, req.categoryPublicId)).id;
        const baseUnit: UnitFacts = req.baseUnitPublicId === undefined || req.baseUnitPublicId === item.baseUnitPublicId
          ? { id: item.baseUnitId, code: item.baseUnitCode, decimals: item.baseUnitDecimals }
          : await this.chosenUnit(tx, ctx, company, req.baseUnitPublicId, 'baseUnitPublicId');
        let location: { id: number; type: LocationType } | null = item.defaultLocationId === null ? null
          : { id: item.defaultLocationId, type: item.defaultLocationType as LocationType };
        if (req.defaultLocationPublicId === null) location = null;
        else if (req.defaultLocationPublicId !== undefined && req.defaultLocationPublicId !== item.defaultLocationPublicId) {
          location = await this.chosenLocation(tx, ctx, company, req.defaultLocationPublicId);
        }
        const current = (await this.repo.conversions(tx, [item.id])).map((c) => ({ unitId: c.unitId, unitCode: c.unitCode, factor: c.factor }));
        if (baseUnit.id !== item.baseUnitId && current.length > 0 && req.conversions === undefined) {
          throw new AppError('INVENTORY_CONVERSIONS_NEEDED', 400, 'The item has unit conversions: send them again with the new base unit (factors are in base units)');
        }
        const wanted = req.conversions === undefined ? current : await this.chosenConversions(tx, ctx, company, req.conversions);
        const next: ItemContent = {
          name: req.name ?? item.name,
          description: req.description === undefined ? item.description : req.description,
          categoryId, baseUnitId: baseUnit.id,
          tracking: req.tracking ?? item.tracking,
          hsnCode: req.hsnCode === undefined ? item.hsnCode : req.hsnCode,
          isStocked: req.isStocked ?? item.isStocked,
          reorderLevel: req.reorderLevel === undefined ? item.reorderLevel : req.reorderLevel,
          reorderQty: req.reorderQty === undefined ? item.reorderQty : req.reorderQty,
          defaultLocationId: location?.id ?? null,
        };
        const changed: string[] = changedFields(item, next);
        const factorOf = (list: ChosenConversion[], unitId: number) => list.find((c) => c.unitId === unitId)?.factor;
        const toEnd = current.filter((c) => factorOf(wanted, c.unitId) !== c.factor).map((c) => c.unitId);
        const toAdd = wanted.filter((c) => factorOf(current, c.unitId) !== c.factor);
        if (toEnd.length || toAdd.length) changed.push('conversions');
        const status = req.status !== undefined && req.status !== item.status ? req.status : undefined;
        if (changed.length === 0 && status === undefined) return this.detail(tx, item);
        if (changed.length > 0) requireValid(next, baseUnit, location?.type ?? null, wanted);

        const patch = Object.fromEntries(changedFields(item, next).map((k) => [k, next[k]])) as Partial<ItemContent>;
        await this.repo.updateItem(tx, item.id, { ...patch, ...(status === undefined ? {} : { status }), updatedBy: ctx.personId, updatedAt: new Date() });
        await this.repo.endConversions(tx, item.id, ctx.personId, toEnd);
        await this.addConversions(tx, ctx, company, item.id, toAdd);
        const [action, verb] = changed.length === 0 ? (status === 'active' ? ['inventory.item.reactivated', 'Reactivated'] : ['inventory.item.deactivated', 'Deactivated'])
          : ['inventory.item.updated', 'Changed'];
        await this.audit(tx, ctx, action, publicId, company, `${verb} item ${item.code} ${next.name} of ${item.company}`,
          { code: item.code, changed: status === undefined ? changed : [...changed, 'status'] });
        return this.detail(tx, await this.visible(tx, ctx, publicId));
      });
    } catch (err) {
      throw refuse(err) ?? err;
    }
  }

  /**
   * A new, separate item in another company made from this one: only the description travels (name, description, HSN/SAC
   * code, tracking, stocked or not). The caller reaches the source item and manages items in the target company.
   */
  async copy(ctx: RequestContext, req: CopyItemRequest): Promise<{ item: Item; created: boolean }> {
    if (await this.access.alreadyStored(ctx, items, req.publicId)) return { item: await this.get(ctx, req.publicId as string), created: false };
    const source = await this.visible(this.db, ctx, req.sourceItemPublicId);
    const company = await this.access.require(ctx, [INVENTORY.items], req.company);
    if (company.id === source.legalEntityId) throw new AppError('INVENTORY_COPY_SAME_COMPANY', 400, `${source.code} already belongs to ${company.code}; copy into another company`);
    const publicId = req.publicId ?? randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.lockCategories(tx, company.id);
        const category = await this.chosenCategory(tx, ctx, company.id, req.categoryPublicId);
        let baseUnit: UnitRow | undefined;
        if (req.baseUnitPublicId) baseUnit = await this.chosenUnit(tx, ctx, company.id, req.baseUnitPublicId, 'baseUnitPublicId');
        else {
          baseUnit = (await this.repo.companyUnits(tx, company.id)).find((u) => u.code === source.baseUnitCode && u.status === 'active');
          if (!baseUnit) throw new AppError('INVENTORY_UNKNOWN_UNIT', 400, `${company.code} has no active unit "${source.baseUnitCode}": choose the base unit`, { field: 'baseUnitPublicId' });
        }
        const content: ItemContent = {
          name: source.name, description: source.description, categoryId: category.id, baseUnitId: baseUnit.id, tracking: source.tracking,
          hsnCode: source.hsnCode, isStocked: source.isStocked, reorderLevel: null, reorderQty: null, defaultLocationId: null,
        };
        requireValid(content, baseUnit, null, []);
        const code = req.code ?? nextItemCode(category.codePrefix, await this.repo.codesWithPrefix(tx, company.id, category.codePrefix));
        await this.repo.insertItems(tx, [{ tenantId: ctx.tenantId, publicId, legalEntityId: company.id, code, createdBy: ctx.personId, ...content }]);
        await this.audit(tx, ctx, 'inventory.item.copied', publicId, company.id, `Added item ${code} ${source.name} to ${company.code}, copied from ${source.company} ${source.code}`,
          { code, copiedFrom: { company: source.company, code: source.code } });
      });
    } catch (err) {
      if (isResentCreate(err)) return { item: await this.get(ctx, publicId), created: false };
      throw refuse(err) ?? err;
    }
    return { item: await this.get(ctx, publicId), created: true };
  }

  /** A quantity in one of the item's units (its base unit or a converted one), in base units. */
  async convert(ctx: RequestContext, publicId: string, q: ConvertQuery): Promise<Conversion> {
    const item = await this.visible(this.db, ctx, publicId);
    const baseUnit = { publicId: item.baseUnitPublicId, code: item.baseUnitCode, name: item.baseUnitName, decimals: item.baseUnitDecimals };
    let unit = baseUnit;
    let factor = 1;
    if (q.unit !== item.baseUnitPublicId) {
      const c = (await this.repo.conversions(this.db, [item.id])).find((x) => x.unitPublicId === q.unit);
      if (!c) throw new AppError('INVENTORY_NO_CONVERSION', 400, `${item.code} has no conversion for that unit`);
      unit = { publicId: c.unitPublicId, code: c.unitCode, name: c.unitName, decimals: c.unitDecimals };
      factor = c.factor;
    }
    if (!fitsDecimals(q.quantity, unit.decimals)) {
      throw new AppError('INVENTORY_QUANTITY_DECIMALS', 400, unit.decimals === 0 ? `Use whole numbers for ${unit.code}` : `Use at most ${unit.decimals} decimals for ${unit.code}`);
    }
    return { quantity: q.quantity, unit, factor, baseQuantity: toBaseQuantity(q.quantity, factor, baseUnit.decimals), baseUnit };
  }

  // ---- helpers ----

  /** An item of a company the caller reaches; anything else is unknown (404), so other companies' records stay unseen. */
  private async visible(conn: Conn, ctx: RequestContext, publicId: string, lock = false): Promise<ItemRow> {
    const row = await this.repo.item(conn, ctx.tenantId, publicId, lock);
    if (!row || !(await this.access.mayUse(ctx, INVENTORY_READ, row.legalEntityId))) throw new AppError('INVENTORY_ITEM_NOT_FOUND', 404, 'Unknown item');
    return row;
  }

  private async detail(conn: Conn, row: ItemRow): Promise<Item> {
    return toItem(row, await this.repo.conversions(conn, [row.id]));
  }

  /** A category chosen for an item: the item's own company's, and active. */
  private async chosenCategory(tx: Tx, ctx: RequestContext, legalEntityId: number, publicId: string): Promise<CategoryRow> {
    const c = await this.repo.category(tx, ctx.tenantId, publicId);
    if (!c || c.legalEntityId !== legalEntityId) throw new AppError('INVENTORY_UNKNOWN_CATEGORY', 400, 'That category does not belong to this company');
    if (c.status !== 'active') throw new AppError('INVENTORY_CATEGORY_INACTIVE', 400, `The category "${c.name}" is inactive and takes no new items`);
    return c;
  }

  /** A unit chosen for an item: the item's own company's, and active. */
  private async chosenUnit(tx: Tx, ctx: RequestContext, legalEntityId: number, publicId: string, field: string): Promise<UnitRow> {
    const u = await this.repo.unit(tx, ctx.tenantId, publicId);
    if (!u || u.legalEntityId !== legalEntityId) throw new AppError('INVENTORY_UNKNOWN_UNIT', 400, 'That unit does not belong to this company', { field });
    if (u.status !== 'active') throw new AppError('INVENTORY_UNIT_INACTIVE', 400, `The unit "${u.code}" is inactive and takes no new items`, { field });
    return u;
  }

  /** A default location chosen for an item: the item's own company's, and active (its type is checked by the item rules). */
  private async chosenLocation(tx: Tx, ctx: RequestContext, legalEntityId: number, publicId: string): Promise<{ id: number; type: LocationType }> {
    const l = await this.locations.get(tx, ctx.tenantId, publicId);
    if (!l || l.legalEntityId !== legalEntityId) throw new AppError('INVENTORY_UNKNOWN_LOCATION', 400, 'That location does not belong to this company');
    if (l.status !== 'active') throw new AppError('INVENTORY_LOCATION_INACTIVE', 400, `The location ${l.code} is inactive`);
    return { id: l.id, type: l.type };
  }

  private async chosenConversions(tx: Tx, ctx: RequestContext, legalEntityId: number, list: ItemConversionInput[]): Promise<ChosenConversion[]> {
    const out: ChosenConversion[] = [];
    for (const c of list) {
      const u = await this.chosenUnit(tx, ctx, legalEntityId, c.unitPublicId, 'conversions');
      out.push({ unitId: u.id, unitCode: u.code, factor: c.factor });
    }
    return out;
  }

  private addConversions(tx: Tx, ctx: RequestContext, legalEntityId: number, itemId: number, list: ChosenConversion[]) {
    return this.repo.insertConversions(tx, list.map((c) => ({ tenantId: ctx.tenantId, legalEntityId, itemId, unitId: c.unitId, factor: c.factor, createdBy: ctx.personId })));
  }

  private audit(tx: Tx, ctx: RequestContext, action: string, publicId: string, legalEntityId: number, summary: string, details: Record<string, unknown>) {
    return this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action, entity: 'inventory_item', entityPublicId: publicId, legalEntityId, summary, details });
  }
}

/** Refuses (400 INVENTORY_ITEM_INVALID, every problem in details) an item that breaks an item rule. */
function requireValid(content: ItemContent, baseUnit: UnitFacts, locationType: LocationType | null, conversions: ChosenConversion[]): void {
  const problems = [...itemProblems(content, baseUnit, locationType), ...conversionProblems(content.baseUnitId, conversions)];
  if (problems.length) throw new AppError('INVENTORY_ITEM_INVALID', 400, problems.map((p) => p.message).join('. '), problems);
}

function refuse(err: unknown): AppError | undefined {
  switch (violatedConstraint(err)) {
    case 'items_company_code_unique': return new AppError('INVENTORY_DUPLICATE_ITEM_CODE', 409, 'This company already has an item with that code');
    case 'items_company_name_unique': return new AppError('INVENTORY_DUPLICATE_ITEM_NAME', 409, 'This company already has an item with that name');
    default: return undefined;
  }
}

export function toItem(r: ItemRow, conversions: ConversionRow[]): Item {
  return {
    publicId: r.publicId, company: r.company, code: r.code, name: r.name, description: r.description,
    category: { publicId: r.categoryPublicId, name: r.categoryName, codePrefix: r.categoryPrefix },
    baseUnit: { publicId: r.baseUnitPublicId, code: r.baseUnitCode, name: r.baseUnitName, decimals: r.baseUnitDecimals },
    tracking: r.tracking, hsnCode: r.hsnCode, isStocked: r.isStocked, reorderLevel: r.reorderLevel, reorderQty: r.reorderQty,
    defaultLocation: r.defaultLocationPublicId === null ? null
      : { publicId: r.defaultLocationPublicId, type: r.defaultLocationType as LocationType, code: r.defaultLocationCode ?? '', name: r.defaultLocationName ?? '' },
    conversions: conversions.filter((c) => c.itemId === r.id)
      .map((c) => ({ unit: { publicId: c.unitPublicId, code: c.unitCode, name: c.unitName, decimals: c.unitDecimals }, factor: c.factor })),
    status: r.status as RecordStatus, createdBy: personRef(r.createdByPublicId, r.createdByName), createdAt: r.createdAt.toISOString(),
    updatedBy: maybePersonRef(r.updatedByPublicId, r.updatedByName), updatedAt: r.updatedAt?.toISOString() ?? null,
  };
}
