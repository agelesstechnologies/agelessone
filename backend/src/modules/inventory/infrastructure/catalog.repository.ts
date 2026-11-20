import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, count, eq, ilike, inArray, isNull, like, or, SQL, sql } from 'drizzle-orm';
import type { ItemTracking, LocationType, RecordStatus } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { itemCategories, items, itemUomConversions, locations, units } from '../schema';
import { ItemContent } from '../domain/items';

const creator = aliasedTable(persons, 'creator');
const updater = aliasedTable(persons, 'updater');
const baseUnit = aliasedTable(units, 'base_unit');
const defaultLocation = aliasedTable(locations, 'default_location');

export interface UnitRow {
  id: number; publicId: string; legalEntityId: number; company: string; code: string; name: string; decimals: number; status: RecordStatus;
  createdByPublicId: string; createdByName: string; createdAt: Date;
}
export interface CategoryRow {
  id: number; publicId: string; legalEntityId: number; company: string; name: string; codePrefix: string; status: RecordStatus; itemCount: number;
  createdByPublicId: string; createdByName: string; createdAt: Date;
}
export interface ItemRow extends ItemContent {
  id: number; publicId: string; legalEntityId: number; company: string; code: string; status: RecordStatus;
  categoryPublicId: string; categoryName: string; categoryPrefix: string;
  baseUnitPublicId: string; baseUnitCode: string; baseUnitName: string; baseUnitDecimals: number;
  defaultLocationPublicId: string | null; defaultLocationType: LocationType | null; defaultLocationCode: string | null; defaultLocationName: string | null;
  createdByPublicId: string; createdByName: string; createdAt: Date;
  updatedByPublicId: string | null; updatedByName: string | null; updatedAt: Date | null;
}
/** A current conversion of an item, with its unit. */
export interface ConversionRow { itemId: number; unitId: number; factor: number; unitPublicId: string; unitCode: string; unitName: string; unitDecimals: number }
export interface ItemFilter { companyIds: number[]; categoryId?: number; status?: RecordStatus; tracking?: ItemTracking; stocked?: boolean; search?: string }

const asStatus = <T extends { status: string }>(r: T) => r as T & { status: RecordStatus };

/** Writes inventory.units, item_categories, items and item_uom_conversions; reads companies, locations and people for names. */
@Injectable()
export class CatalogRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- units ----

  private selectUnits(conn: Conn) {
    return conn.select({
      id: units.id, publicId: units.publicId, legalEntityId: units.legalEntityId, company: legalEntities.code, code: units.code, name: units.name,
      decimals: units.decimals, status: units.status, createdByPublicId: creator.publicId, createdByName: creator.displayName, createdAt: units.createdAt,
    }).from(units)
      .innerJoin(legalEntities, eq(legalEntities.id, units.legalEntityId))
      .innerJoin(creator, eq(creator.id, units.createdBy));
  }

  async listUnits(tenantId: number, companyIds: number[], status?: RecordStatus): Promise<UnitRow[]> {
    if (companyIds.length === 0) return [];
    const rows = await this.selectUnits(this.db).where(and(eq(units.tenantId, tenantId), inArray(units.legalEntityId, companyIds),
      status === undefined ? undefined : eq(units.status, status))).orderBy(asc(legalEntities.code), asc(units.code));
    return rows.map(asStatus);
  }

  /** `lock` holds the row until the transaction ends, so two changes cannot interleave. */
  async unit(conn: Conn, tenantId: number, publicId: string, lock = false): Promise<UnitRow | undefined> {
    const where = and(eq(units.tenantId, tenantId), eq(units.publicId, publicId));
    if (lock) await conn.select({ id: units.id }).from(units).where(where).for('update');
    const [row] = await this.selectUnits(conn).where(where);
    return row && asStatus(row);
  }

  async companyUnits(conn: Conn, legalEntityId: number): Promise<UnitRow[]> {
    return (await this.selectUnits(conn).where(eq(units.legalEntityId, legalEntityId))).map(asStatus);
  }

  async insertUnit(tx: Tx, v: typeof units.$inferInsert): Promise<void> {
    await tx.insert(units).values(v);
  }

  async updateUnit(tx: Tx, id: number, patch: { name?: string; decimals?: number; status?: RecordStatus }): Promise<void> {
    await tx.update(units).set(patch).where(eq(units.id, id));
  }

  /** Whether any item counts in this unit or has a conversion for it (current or ended). */
  async unitInUse(conn: Conn, unitId: number): Promise<boolean> {
    const [asBase] = await conn.select({ id: items.id }).from(items).where(eq(items.baseUnitId, unitId)).limit(1);
    if (asBase) return true;
    const [asConversion] = await conn.select({ id: itemUomConversions.id }).from(itemUomConversions).where(eq(itemUomConversions.unitId, unitId)).limit(1);
    return asConversion !== undefined;
  }

  // ---- categories ----

  private selectCategories(conn: Conn) {
    return conn.select({
      id: itemCategories.id, publicId: itemCategories.publicId, legalEntityId: itemCategories.legalEntityId, company: legalEntities.code,
      name: itemCategories.name, codePrefix: itemCategories.codePrefix, status: itemCategories.status,
      itemCount: sql<number>`(SELECT count(*) FROM ${items} WHERE ${items.categoryId} = ${itemCategories.id})::int`,
      createdByPublicId: creator.publicId, createdByName: creator.displayName, createdAt: itemCategories.createdAt,
    }).from(itemCategories)
      .innerJoin(legalEntities, eq(legalEntities.id, itemCategories.legalEntityId))
      .innerJoin(creator, eq(creator.id, itemCategories.createdBy));
  }

  async listCategories(tenantId: number, companyIds: number[], status?: RecordStatus): Promise<CategoryRow[]> {
    if (companyIds.length === 0) return [];
    const rows = await this.selectCategories(this.db).where(and(eq(itemCategories.tenantId, tenantId), inArray(itemCategories.legalEntityId, companyIds),
      status === undefined ? undefined : eq(itemCategories.status, status)))
      .orderBy(asc(legalEntities.code), asc(sql`lower(${itemCategories.name})`));
    return rows.map(asStatus);
  }

  async category(conn: Conn, tenantId: number, publicId: string, lock = false): Promise<CategoryRow | undefined> {
    const where = and(eq(itemCategories.tenantId, tenantId), eq(itemCategories.publicId, publicId));
    if (lock) await conn.select({ id: itemCategories.id }).from(itemCategories).where(where).for('update');
    const [row] = await this.selectCategories(conn).where(where);
    return row && asStatus(row);
  }

  async companyCategories(conn: Conn, legalEntityId: number): Promise<CategoryRow[]> {
    return (await this.selectCategories(conn).where(eq(itemCategories.legalEntityId, legalEntityId))).map(asStatus);
  }

  async insertCategory(tx: Tx, v: typeof itemCategories.$inferInsert): Promise<void> {
    await tx.insert(itemCategories).values(v);
  }

  async updateCategory(tx: Tx, id: number, patch: { name?: string; status?: RecordStatus }): Promise<void> {
    await tx.update(itemCategories).set(patch).where(eq(itemCategories.id, id));
  }

  /** Locks a company's categories, so item codes made at the same moment (a create, a copy, an import) cannot collide. */
  async lockCategories(tx: Tx, legalEntityId: number): Promise<void> {
    await tx.select({ id: itemCategories.id }).from(itemCategories).where(eq(itemCategories.legalEntityId, legalEntityId)).for('update');
  }

  // ---- items ----

  private selectItems(conn: Conn) {
    return conn.select({
      id: items.id, publicId: items.publicId, legalEntityId: items.legalEntityId, company: legalEntities.code, code: items.code, name: items.name,
      description: items.description, categoryId: items.categoryId, baseUnitId: items.baseUnitId, tracking: sql<ItemTracking>`${items.tracking}`,
      hsnCode: items.hsnCode, isStocked: items.isStocked, reorderLevel: items.reorderLevel, reorderQty: items.reorderQty,
      defaultLocationId: items.defaultLocationId, status: sql<RecordStatus>`${items.status}`,
      categoryPublicId: itemCategories.publicId, categoryName: itemCategories.name, categoryPrefix: itemCategories.codePrefix,
      baseUnitPublicId: baseUnit.publicId, baseUnitCode: baseUnit.code, baseUnitName: baseUnit.name, baseUnitDecimals: baseUnit.decimals,
      defaultLocationPublicId: defaultLocation.publicId, defaultLocationType: sql<LocationType | null>`${defaultLocation.type}`,
      defaultLocationCode: defaultLocation.code, defaultLocationName: defaultLocation.name,
      createdByPublicId: creator.publicId, createdByName: creator.displayName, createdAt: items.createdAt,
      updatedByPublicId: updater.publicId, updatedByName: updater.displayName, updatedAt: items.updatedAt,
    }).from(items)
      .innerJoin(legalEntities, eq(legalEntities.id, items.legalEntityId))
      .innerJoin(itemCategories, eq(itemCategories.id, items.categoryId))
      .innerJoin(baseUnit, eq(baseUnit.id, items.baseUnitId))
      .leftJoin(defaultLocation, eq(defaultLocation.id, items.defaultLocationId))
      .innerJoin(creator, eq(creator.id, items.createdBy))
      .leftJoin(updater, eq(updater.id, items.updatedBy));
  }

  private itemWhere(tenantId: number, f: ItemFilter): SQL | undefined {
    const search = f.search ? `%${f.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
    return and(
      eq(items.tenantId, tenantId), inArray(items.legalEntityId, f.companyIds),
      f.categoryId === undefined ? undefined : eq(items.categoryId, f.categoryId),
      f.status === undefined ? undefined : eq(items.status, f.status),
      f.tracking === undefined ? undefined : eq(items.tracking, f.tracking),
      f.stocked === undefined ? undefined : eq(items.isStocked, f.stocked),
      search === undefined ? undefined : or(ilike(items.code, search), ilike(items.name, search)),
    );
  }

  /** One page of items, by company then code, and how many match in all. */
  async listItems(tenantId: number, f: ItemFilter, page: number, pageSize: number): Promise<{ rows: ItemRow[]; total: number }> {
    if (f.companyIds.length === 0) return { rows: [], total: 0 };
    const where = this.itemWhere(tenantId, f);
    const [rows, [{ total }]] = await Promise.all([
      this.selectItems(this.db).where(where).orderBy(asc(legalEntities.code), asc(items.code)).limit(pageSize).offset((page - 1) * pageSize),
      this.db.select({ total: count() }).from(items).where(where),
    ]);
    return { rows, total };
  }

  async item(conn: Conn, tenantId: number, publicId: string, lock = false): Promise<ItemRow | undefined> {
    const where = and(eq(items.tenantId, tenantId), eq(items.publicId, publicId));
    if (lock) await conn.select({ id: items.id }).from(items).where(where).for('update');
    const [row] = await this.selectItems(conn).where(where);
    return row;
  }

  /** Code and name of every item of a company (what an import compares against). */
  companyItemNames(conn: Conn, legalEntityId: number): Promise<{ code: string; name: string }[]> {
    return conn.select({ code: items.code, name: items.name }).from(items).where(eq(items.legalEntityId, legalEntityId));
  }

  /** The codes a company already uses after "PREFIX-" (to make the next one). */
  async codesWithPrefix(conn: Conn, legalEntityId: number, prefix: string): Promise<string[]> {
    const rows = await conn.select({ code: items.code }).from(items).where(and(eq(items.legalEntityId, legalEntityId), like(items.code, `${prefix}-%`)));
    return rows.map((r) => r.code);
  }

  /** Inserts items and answers their ids, in order. */
  async insertItems(tx: Tx, rows: (typeof items.$inferInsert)[]): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      ids.push(...(await tx.insert(items).values(rows.slice(i, i + 500)).returning({ id: items.id })).map((r) => r.id));
    }
    return ids;
  }

  async updateItem(tx: Tx, id: number, patch: Partial<ItemContent> & { status?: RecordStatus; updatedBy: number; updatedAt: Date }): Promise<void> {
    await tx.update(items).set(patch).where(eq(items.id, id));
  }

  // ---- conversions ----

  /** The current conversions of these items, by unit code. */
  async conversions(conn: Conn, itemIds: number[]): Promise<ConversionRow[]> {
    if (itemIds.length === 0) return [];
    return conn.select({
      itemId: itemUomConversions.itemId, unitId: itemUomConversions.unitId, factor: itemUomConversions.factor,
      unitPublicId: units.publicId, unitCode: units.code, unitName: units.name, unitDecimals: units.decimals,
    }).from(itemUomConversions).innerJoin(units, eq(units.id, itemUomConversions.unitId))
      .where(and(inArray(itemUomConversions.itemId, itemIds), isNull(itemUomConversions.endedAt))).orderBy(asc(units.code));
  }

  async insertConversions(tx: Tx, rows: (typeof itemUomConversions.$inferInsert)[]): Promise<void> {
    if (rows.length) await tx.insert(itemUomConversions).values(rows);
  }

  /** Ends current conversions of an item (all, or only these units); the rows stay as history. */
  async endConversions(tx: Tx, itemId: number, endedBy: number, unitIds?: number[]): Promise<void> {
    if (unitIds && unitIds.length === 0) return;
    await tx.update(itemUomConversions).set({ endedBy, endedAt: new Date() }).where(and(eq(itemUomConversions.itemId, itemId),
      isNull(itemUomConversions.endedAt), unitIds ? inArray(itemUomConversions.unitId, unitIds) : undefined));
  }
}
