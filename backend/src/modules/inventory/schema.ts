import { sql } from 'drizzle-orm';
import { pgSchema, bigint, boolean, check, foreignKey, index, numeric, smallint, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { legalEntities, persons } from '../core/schema';
import { employments } from '../hrms/people/schema';
export const inventorySchema = pgSchema('inventory');

/*
 * Each company's inventory is completely separate. Every table here has legal_entity_id, and every link to another
 * inventory record or to a job carries it too ((x_id, legal_entity_id) foreign keys onto (id, legal_entity_id)), so an
 * ATPL record can never use an AE unit, category, item, location or job — the database refuses it.
 * Nothing is deleted (trigger, migration 0040): records become inactive, and changes are in core.audit_log.
 */

/**
 * The units a company counts in (pcs, m, kg, l, box …). decimals: how many decimals a quantity in this unit may have
 * (pieces 0, metres 2, kilograms 3; at most 4). The code never changes; decimals change only while no item uses the unit.
 */
export const units = inventorySchema.table('units', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  decimals: smallint('decimals').notNull(),
  status: text('status').notNull().default('active'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('units_company_code_unique').on(t.legalEntityId, t.code),
  unique('units_id_company_unique').on(t.id, t.legalEntityId),
  check('units_code_format', sql`code ~ '^[a-z][a-z0-9_.]{0,11}$'`),
  check('units_name_length', sql`char_length(name) BETWEEN 1 AND 40`),
  check('units_decimals_check', sql`decimals BETWEEN 0 AND 4`),
  check('units_status_check', sql`status IN ('active','inactive')`),
]);

/** A company's item categories. code_prefix starts the item codes made for the category (EC → EC-0001) and never changes. */
export const itemCategories = inventorySchema.table('item_categories', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  name: text('name').notNull(),
  codePrefix: text('code_prefix').notNull(),
  status: text('status').notNull().default('active'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('item_categories_company_prefix_unique').on(t.legalEntityId, t.codePrefix),
  uniqueIndex('item_categories_company_name_unique').on(t.legalEntityId, sql`lower(${t.name})`),
  unique('item_categories_id_company_unique').on(t.id, t.legalEntityId),
  check('item_categories_prefix_format', sql`code_prefix ~ '^[A-Z][A-Z0-9]{1,5}$'`),
  check('item_categories_name_length', sql`char_length(name) BETWEEN 2 AND 60`),
  check('item_categories_status_check', sql`status IN ('active','inactive')`),
]);

/**
 * Where a company's stock sits: a store (with racks and bins inside), a work area, a testing space, transit, quarantine
 * or scrap. A rack's parent is a store, a bin's a store or a rack (checked by the service); other types have none. The
 * custodian is a person through their job in the same company; racks and bins may leave it empty and fall back to their
 * parent's. Type and parent never change. Code unique per company.
 */
export const locations = inventorySchema.table('locations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  type: text('type').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  parentId: bigint('parent_id', { mode: 'number' }),
  custodianEmploymentId: bigint('custodian_employment_id', { mode: 'number' }),
  status: text('status').notNull().default('active'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: bigint('updated_by', { mode: 'number' }).references(() => persons.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'locations_parent_company_fk', columns: [t.parentId, t.legalEntityId], foreignColumns: [t.id, t.legalEntityId] }),
  foreignKey({ name: 'locations_custodian_company_fk', columns: [t.custodianEmploymentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  unique('locations_company_code_unique').on(t.legalEntityId, t.code),
  unique('locations_id_company_unique').on(t.id, t.legalEntityId), // target of the parent key, items and the stock tables
  index('idx_locations_parent').on(t.parentId),
  check('locations_type_check', sql`type IN ('store','rack','bin','work_area','testing','transit','quarantine','scrap')`),
  check('locations_code_format', sql`code ~ '^[A-Z0-9][A-Z0-9._/-]{0,29}$'`),
  check('locations_name_length', sql`char_length(name) BETWEEN 2 AND 80`),
  check('locations_parent_by_type', sql`(type IN ('rack','bin')) = (parent_id IS NOT NULL)`),
  check('locations_custodian_needed', sql`type IN ('rack','bin') OR custodian_employment_id IS NOT NULL`),
  check('locations_not_own_parent', sql`parent_id IS NULL OR parent_id <> id`),
  check('locations_status_check', sql`status IN ('active','inactive')`),
  check('locations_updated_fields', sql`(updated_by IS NULL) = (updated_at IS NULL)`),
]);

/**
 * A company's item. Quantities (reorder level and quantity) are in the base unit. A non-stocked item (bought for use,
 * never kept in a store) has no tracking, reorder values or default location. Code and name (ignoring case) are unique
 * per company; the code never changes. Equipment the company keeps and uses (3D printers, servers) is not an item.
 */
export const items = inventorySchema.table('items', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  categoryId: bigint('category_id', { mode: 'number' }).notNull(),
  baseUnitId: bigint('base_unit_id', { mode: 'number' }).notNull(),
  tracking: text('tracking').notNull().default('none'),
  hsnCode: text('hsn_code'),
  isStocked: boolean('is_stocked').notNull().default(true),
  reorderLevel: numeric('reorder_level', { precision: 18, scale: 4, mode: 'number' }),
  reorderQty: numeric('reorder_qty', { precision: 18, scale: 4, mode: 'number' }),
  defaultLocationId: bigint('default_location_id', { mode: 'number' }),
  status: text('status').notNull().default('active'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: bigint('updated_by', { mode: 'number' }).references(() => persons.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'items_category_company_fk', columns: [t.categoryId, t.legalEntityId], foreignColumns: [itemCategories.id, itemCategories.legalEntityId] }),
  foreignKey({ name: 'items_base_unit_company_fk', columns: [t.baseUnitId, t.legalEntityId], foreignColumns: [units.id, units.legalEntityId] }),
  foreignKey({ name: 'items_default_location_company_fk', columns: [t.defaultLocationId, t.legalEntityId], foreignColumns: [locations.id, locations.legalEntityId] }),
  unique('items_company_code_unique').on(t.legalEntityId, t.code),
  uniqueIndex('items_company_name_unique').on(t.legalEntityId, sql`lower(${t.name})`),
  unique('items_id_company_unique').on(t.id, t.legalEntityId), // target of the conversions' and the stock tables' keys
  index('idx_items_company_category').on(t.legalEntityId, t.categoryId),
  check('items_code_format', sql`code ~ '^[A-Z0-9][A-Z0-9._/-]{0,29}$'`),
  check('items_name_length', sql`char_length(name) BETWEEN 2 AND 120`),
  check('items_description_length', sql`description IS NULL OR char_length(description) BETWEEN 1 AND 1000`),
  check('items_tracking_check', sql`tracking IN ('none','batch','serial')`),
  check('items_hsn_format', sql`hsn_code IS NULL OR hsn_code ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'`),
  check('items_not_stocked_fields', sql`is_stocked OR (tracking = 'none' AND reorder_level IS NULL AND reorder_qty IS NULL AND default_location_id IS NULL)`),
  check('items_reorder_check', sql`(reorder_level IS NULL OR reorder_level >= 0) AND (reorder_qty IS NULL OR reorder_qty > 0)`),
  check('items_status_check', sql`status IN ('active','inactive')`),
  check('items_updated_fields', sql`(updated_by IS NULL) = (updated_at IS NULL)`),
]);

/**
 * Other units an item is counted or bought in: one `unit` holds `factor` base units (a box of 100 pieces: 100). One
 * current conversion per item and unit; a change ends the old row (ended_at) and adds a new one, so history stays.
 */
export const itemUomConversions = inventorySchema.table('item_uom_conversions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  itemId: bigint('item_id', { mode: 'number' }).notNull(),
  unitId: bigint('unit_id', { mode: 'number' }).notNull(),
  factor: numeric('factor', { precision: 18, scale: 6, mode: 'number' }).notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  endedBy: bigint('ended_by', { mode: 'number' }).references(() => persons.id),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'item_uom_conversions_item_company_fk', columns: [t.itemId, t.legalEntityId], foreignColumns: [items.id, items.legalEntityId] }),
  foreignKey({ name: 'item_uom_conversions_unit_company_fk', columns: [t.unitId, t.legalEntityId], foreignColumns: [units.id, units.legalEntityId] }),
  uniqueIndex('item_uom_conversions_one_current').on(t.itemId, t.unitId).where(sql`ended_at IS NULL`),
  check('item_uom_conversions_factor_check', sql`factor > 0`),
  check('item_uom_conversions_ended_fields', sql`(ended_by IS NULL) = (ended_at IS NULL)`),
]);
