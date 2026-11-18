import { sql } from 'drizzle-orm';
import { pgSchema, bigint, boolean, char, check, date, foreignKey, index, integer, numeric, smallint, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { legalEntities, persons } from '../core/schema';
import { employments } from '../hrms/people/schema';
import { tickets } from '../tickets/schema';
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

// ---------------------------------------------------------------------------------------------------------------------
// Stock. Every movement is a document with lines; posting a document writes stock_moves (append-only) and updates
// stock_balances (quantity per item, location and batch) and stock_valuations (moving average per item per company) in
// the same transaction, under row locks. Money is integer minor units (paise) with its currency; unit costs are minor
// units per base unit and may have decimals.
// ---------------------------------------------------------------------------------------------------------------------

/** A batch of a batch-tracked item (the batch and serial rules come with part requests). Expiry is optional. */
export const stockBatches = inventorySchema.table('stock_batches', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  itemId: bigint('item_id', { mode: 'number' }).notNull(),
  batchNo: text('batch_no').notNull(),
  expiryDate: date('expiry_date'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'stock_batches_item_company_fk', columns: [t.itemId, t.legalEntityId], foreignColumns: [items.id, items.legalEntityId] }),
  unique('stock_batches_item_batch_unique').on(t.itemId, t.batchNo),
  unique('stock_batches_id_item_company_unique').on(t.id, t.itemId, t.legalEntityId), // a balance's or move's batch is of its item
  check('stock_batches_batch_no_length', sql`char_length(batch_no) BETWEEN 1 AND 60`),
]);

/**
 * A cross-company requester: the store in-charge of the company that owns the stock lets a person from another company
 * request parts for one of its tickets until valid_until (inclusive). Requests only: no values, no approvals. Ended,
 * never deleted; one open grant per person and ticket.
 */
export const crossCompanyGrants = inventorySchema.table('cross_company_grants', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  validUntil: date('valid_until').notNull(),
  grantedBy: bigint('granted_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  endedBy: bigint('ended_by', { mode: 'number' }).references(() => persons.id),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'cross_company_grants_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  unique('cross_company_grants_id_company_unique').on(t.id, t.legalEntityId),
  uniqueIndex('cross_company_grants_one_open').on(t.personId, t.ticketId).where(sql`ended_at IS NULL`),
  check('cross_company_grants_not_self', sql`granted_by <> person_id`),
  check('cross_company_grants_ended_fields', sql`(ended_by IS NULL) = (ended_at IS NULL)`),
]);

/**
 * A request for parts for a ticket (projects come later), like Froid's "Parts required". The store in-charge approves it;
 * when its estimated value is above the company's limit the ticket's department head must approve too. Fully approved,
 * its stock is reserved (stock_reservations) until reserve_until. Nobody decides their own request.
 */
export const partRequests = inventorySchema.table('part_requests', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  number: text('number').notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  /** projects come later (no table yet) */
  projectId: bigint('project_id', { mode: 'number' }),
  requestedBy: bigint('requested_by', { mode: 'number' }).notNull().references(() => persons.id),
  /** asked through a cross-company grant */
  grantId: bigint('grant_id', { mode: 'number' }),
  status: text('status').notNull().default('pending'),
  note: text('note'),
  estimatedValueMinor: bigint('estimated_value_minor', { mode: 'bigint' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  needsHeadApproval: boolean('needs_head_approval').notNull(),
  storeApprovedBy: bigint('store_approved_by', { mode: 'number' }).references(() => persons.id),
  storeApprovedAt: timestamp('store_approved_at', { withTimezone: true }),
  headApprovedBy: bigint('head_approved_by', { mode: 'number' }).references(() => persons.id),
  headApprovedAt: timestamp('head_approved_at', { withTimezone: true }),
  reserveUntil: date('reserve_until'),
  /** who rejected or cancelled it, and why */
  decidedBy: bigint('decided_by', { mode: 'number' }).references(() => persons.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'part_requests_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'part_requests_grant_company_fk', columns: [t.grantId, t.legalEntityId], foreignColumns: [crossCompanyGrants.id, crossCompanyGrants.legalEntityId] }),
  unique('part_requests_company_number_unique').on(t.legalEntityId, t.number),
  unique('part_requests_id_company_unique').on(t.id, t.legalEntityId),
  index('idx_part_requests_ticket').on(t.ticketId),
  index('idx_part_requests_company_status').on(t.legalEntityId, t.status),
  check('part_requests_status_check', sql`status IN ('pending','approved','fulfilled','rejected','cancelled','expired','closed')`),
  check('part_requests_money_check', sql`estimated_value_minor >= 0 AND currency = 'INR'`),
  check('part_requests_not_own_decision', sql`(store_approved_by IS NULL OR store_approved_by <> requested_by) AND (head_approved_by IS NULL OR head_approved_by <> requested_by)
    AND (decided_by IS NULL OR status = 'cancelled' OR decided_by <> requested_by)`),
  check('part_requests_approval_fields', sql`(store_approved_by IS NULL) = (store_approved_at IS NULL) AND (head_approved_by IS NULL) = (head_approved_at IS NULL)
    AND (decided_by IS NULL) = (decided_at IS NULL)`),
  check('part_requests_approved_fields', sql`status IN ('pending','rejected') OR (store_approved_by IS NOT NULL AND (NOT needs_head_approval OR head_approved_by IS NOT NULL) AND reserve_until IS NOT NULL)
    OR (status = 'cancelled' AND decided_by IS NOT NULL) OR status = 'closed'`),
  check('part_requests_rejected_fields', sql`status <> 'rejected' OR (decided_by IS NOT NULL AND decision_reason IS NOT NULL)`),
  check('part_requests_note_length', sql`note IS NULL OR char_length(note) BETWEEN 1 AND 500`),
]);

/** One item of a part request: how much, where the store in-charge reserves it from, and how much has been issued. */
export const partRequestLines = inventorySchema.table('part_request_lines', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  requestId: bigint('request_id', { mode: 'number' }).notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: bigint('item_id', { mode: 'number' }).notNull(),
  quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
  locationId: bigint('location_id', { mode: 'number' }),
  issuedQty: numeric('issued_qty', { precision: 18, scale: 4 }).notNull().default('0'),
  /** quantity × the item's average when asked (the request's estimate is their sum) */
  estimatedValueMinor: bigint('estimated_value_minor', { mode: 'bigint' }).notNull(),
}, (t) => [
  foreignKey({ name: 'part_request_lines_request_company_fk', columns: [t.requestId, t.legalEntityId], foreignColumns: [partRequests.id, partRequests.legalEntityId] }),
  foreignKey({ name: 'part_request_lines_item_company_fk', columns: [t.itemId, t.legalEntityId], foreignColumns: [items.id, items.legalEntityId] }),
  foreignKey({ name: 'part_request_lines_location_company_fk', columns: [t.locationId, t.legalEntityId], foreignColumns: [locations.id, locations.legalEntityId] }),
  unique('part_request_lines_request_line_unique').on(t.requestId, t.lineNo),
  unique('part_request_lines_request_item_unique').on(t.requestId, t.itemId),
  unique('part_request_lines_id_company_unique').on(t.id, t.legalEntityId),
  check('part_request_lines_quantity_check', sql`quantity > 0 AND issued_qty >= 0 AND issued_qty <= quantity AND line_no >= 1`),
]);

/**
 * Stock held for a part request line in one location (and batch). quantity is what is still held; it goes down as the
 * request is issued and is released (released_at, reason) when issued in full, or when the request is cancelled, expires
 * or its ticket closes. A balance's reserved = the open quantities held in it.
 */
export const stockReservations = inventorySchema.table('stock_reservations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  requestLineId: bigint('request_line_id', { mode: 'number' }).notNull(),
  itemId: bigint('item_id', { mode: 'number' }).notNull(),
  locationId: bigint('location_id', { mode: 'number' }).notNull(),
  batchId: bigint('batch_id', { mode: 'number' }),
  reservedQty: numeric('reserved_qty', { precision: 18, scale: 4 }).notNull(),
  quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releaseReason: text('release_reason'),
}, (t) => [
  foreignKey({ name: 'stock_reservations_line_company_fk', columns: [t.requestLineId, t.legalEntityId], foreignColumns: [partRequestLines.id, partRequestLines.legalEntityId] }),
  foreignKey({ name: 'stock_reservations_item_company_fk', columns: [t.itemId, t.legalEntityId], foreignColumns: [items.id, items.legalEntityId] }),
  foreignKey({ name: 'stock_reservations_location_company_fk', columns: [t.locationId, t.legalEntityId], foreignColumns: [locations.id, locations.legalEntityId] }),
  foreignKey({ name: 'stock_reservations_batch_item_fk', columns: [t.batchId, t.itemId, t.legalEntityId], foreignColumns: [stockBatches.id, stockBatches.itemId, stockBatches.legalEntityId] }),
  index('idx_stock_reservations_line').on(t.requestLineId),
  index('idx_stock_reservations_open').on(t.itemId, t.locationId).where(sql`released_at IS NULL`),
  check('stock_reservations_quantity_check', sql`reserved_qty > 0 AND quantity >= 0 AND quantity <= reserved_qty`),
  check('stock_reservations_release_fields', sql`(released_at IS NULL) = (release_reason IS NULL) AND (release_reason IS NULL OR release_reason IN ('issued','cancelled','expired','ticket_closed'))
    AND (released_at IS NULL OR quantity = 0)`),
]);

/**
 * A stock document: receipt (from a supplier; a direct purchase needs a reason until purchase orders exist), issue (to a
 * ticket of the same company; projects come later), return (of an issue), transfer (sent to transit, then received) or
 * reversal (undoes a posted document). Posted when created; a transfer stays in_transit until received. Never deleted:
 * a mistake is reversed (status reversed, and the reversal document points at it).
 */
export const stockDocuments = inventorySchema.table('stock_documents', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  type: text('type').notNull(),
  number: text('number').notNull(),
  status: text('status').notNull().default('posted'),
  documentDate: date('document_date').notNull(),
  supplierName: text('supplier_name'),
  challanNo: text('challan_no'),
  challanPath: text('challan_path'),
  challanType: text('challan_type'),
  reason: text('reason'),
  note: text('note'),
  ticketId: bigint('ticket_id', { mode: 'number' }),
  /** projects come later (no table yet) */
  projectId: bigint('project_id', { mode: 'number' }),
  /** return: the issue it returns; reversal: the document it undoes */
  originalDocumentId: bigint('original_document_id', { mode: 'number' }),
  transitLocationId: bigint('transit_location_id', { mode: 'number' }),
  /** issue: the part request it fills */
  requestId: bigint('request_id', { mode: 'number' }),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  receivedBy: bigint('received_by', { mode: 'number' }).references(() => persons.id),
  receivedAt: timestamp('received_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'stock_documents_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'stock_documents_original_company_fk', columns: [t.originalDocumentId, t.legalEntityId], foreignColumns: [t.id, t.legalEntityId] }),
  foreignKey({ name: 'stock_documents_transit_company_fk', columns: [t.transitLocationId, t.legalEntityId], foreignColumns: [locations.id, locations.legalEntityId] }),
  foreignKey({ name: 'stock_documents_request_company_fk', columns: [t.requestId, t.legalEntityId], foreignColumns: [partRequests.id, partRequests.legalEntityId] }),
  unique('stock_documents_company_number_unique').on(t.legalEntityId, t.number),
  unique('stock_documents_id_company_unique').on(t.id, t.legalEntityId),
  uniqueIndex('stock_documents_one_reversal').on(t.originalDocumentId).where(sql`type = 'reversal'`),
  index('idx_stock_documents_company_date').on(t.legalEntityId, t.documentDate),
  index('idx_stock_documents_ticket').on(t.ticketId),
  check('stock_documents_type_check', sql`type IN ('receipt','issue','return','transfer','reversal')`),
  check('stock_documents_status_check', sql`status IN ('posted','in_transit','reversed')`),
  check('stock_documents_currency_check', sql`currency = 'INR'`),
  check('stock_documents_receipt_fields', sql`(type = 'receipt') = (supplier_name IS NOT NULL) AND (type <> 'receipt' OR reason IS NOT NULL)`),
  check('stock_documents_issue_target', sql`(type = 'issue') = (ticket_id IS NOT NULL OR project_id IS NOT NULL)`),
  check('stock_documents_original_fields', sql`(type IN ('return','reversal')) = (original_document_id IS NOT NULL) AND (type <> 'reversal' OR reason IS NOT NULL)`),
  check('stock_documents_transit_fields', sql`(type = 'transfer') = (transit_location_id IS NOT NULL) AND (status <> 'in_transit' OR type = 'transfer')`),
  check('stock_documents_received_fields', sql`(received_by IS NULL) = (received_at IS NULL) AND (received_at IS NULL OR type = 'transfer')`),
  check('stock_documents_challan_fields', sql`(challan_path IS NULL) = (challan_type IS NULL) AND (challan_type IS NULL OR challan_type IN ('jpg','png','pdf')) AND (challan_path IS NULL OR type = 'receipt')`),
  check('stock_documents_reversal_final', sql`type <> 'reversal' OR status = 'posted'`),
  check('stock_documents_request_on_issue', sql`request_id IS NULL OR type = 'issue'`),
  check('stock_documents_text_lengths', sql`(supplier_name IS NULL OR char_length(supplier_name) BETWEEN 2 AND 120) AND (challan_no IS NULL OR char_length(challan_no) BETWEEN 1 AND 60) AND (reason IS NULL OR char_length(reason) BETWEEN 3 AND 300) AND (note IS NULL OR char_length(note) BETWEEN 1 AND 500)`),
]);

/**
 * One line of a document. quantity is in the item's base unit; entered_quantity / entered_unit_id keep what a receipt was
 * entered in when that was a conversion unit. unit_cost_minor and value_minor are recorded when posted and never change
 * (an issue keeps the average cost of that moment). location: into (receipt, return) or from (issue, transfer);
 * to_location: a transfer's destination. Never changed or deleted (trigger, migration 0041).
 */
export const stockDocumentLines = inventorySchema.table('stock_document_lines', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  documentId: bigint('document_id', { mode: 'number' }).notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: bigint('item_id', { mode: 'number' }).notNull(),
  locationId: bigint('location_id', { mode: 'number' }).notNull(),
  toLocationId: bigint('to_location_id', { mode: 'number' }),
  batchId: bigint('batch_id', { mode: 'number' }),
  serialNo: text('serial_no'),
  quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
  enteredQuantity: numeric('entered_quantity', { precision: 18, scale: 4 }),
  enteredUnitId: bigint('entered_unit_id', { mode: 'number' }),
  unitCostMinor: numeric('unit_cost_minor', { precision: 24, scale: 6 }).notNull(),
  valueMinor: bigint('value_minor', { mode: 'bigint' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  condition: text('condition'),
  /** return: the issue line it returns; reversal: the line it undoes */
  originalLineId: bigint('original_line_id', { mode: 'number' }),
  /** issue against a part request: the request line it fills */
  requestLineId: bigint('request_line_id', { mode: 'number' }),
}, (t) => [
  foreignKey({ name: 'stock_document_lines_document_company_fk', columns: [t.documentId, t.legalEntityId], foreignColumns: [stockDocuments.id, stockDocuments.legalEntityId] }),
  foreignKey({ name: 'stock_document_lines_item_company_fk', columns: [t.itemId, t.legalEntityId], foreignColumns: [items.id, items.legalEntityId] }),
  foreignKey({ name: 'stock_document_lines_location_company_fk', columns: [t.locationId, t.legalEntityId], foreignColumns: [locations.id, locations.legalEntityId] }),
  foreignKey({ name: 'stock_document_lines_to_location_company_fk', columns: [t.toLocationId, t.legalEntityId], foreignColumns: [locations.id, locations.legalEntityId] }),
  foreignKey({ name: 'stock_document_lines_unit_company_fk', columns: [t.enteredUnitId, t.legalEntityId], foreignColumns: [units.id, units.legalEntityId] }),
  foreignKey({ name: 'stock_document_lines_batch_item_fk', columns: [t.batchId, t.itemId, t.legalEntityId], foreignColumns: [stockBatches.id, stockBatches.itemId, stockBatches.legalEntityId] }),
  foreignKey({ name: 'stock_document_lines_original_company_fk', columns: [t.originalLineId, t.legalEntityId], foreignColumns: [t.id, t.legalEntityId] }),
  foreignKey({ name: 'stock_document_lines_request_line_company_fk', columns: [t.requestLineId, t.legalEntityId], foreignColumns: [partRequestLines.id, partRequestLines.legalEntityId] }),
  unique('stock_document_lines_document_line_unique').on(t.documentId, t.lineNo),
  unique('stock_document_lines_id_company_unique').on(t.id, t.legalEntityId),
  index('idx_stock_document_lines_item').on(t.itemId),
  index('idx_stock_document_lines_original').on(t.originalLineId),
  check('stock_document_lines_quantity_check', sql`quantity > 0 AND (entered_quantity IS NULL OR entered_quantity > 0)`),
  check('stock_document_lines_entered_fields', sql`(entered_quantity IS NULL) = (entered_unit_id IS NULL)`),
  check('stock_document_lines_money_check', sql`unit_cost_minor >= 0 AND value_minor >= 0 AND currency = 'INR'`),
  check('stock_document_lines_condition_check', sql`condition IS NULL OR condition IN ('usable','repair','scrap')`),
  check('stock_document_lines_to_location_check', sql`to_location_id IS NULL OR to_location_id <> location_id`),
  check('stock_document_lines_line_no_check', sql`line_no >= 1`),
  check('stock_document_lines_serial_one_unit', sql`serial_no IS NULL OR quantity = 1`),
]);

/**
 * The stock ledger: one row per quantity change of an item in a location (and batch). Append-only: never updated or
 * deleted (trigger, migration 0041); a reversal adds opposite rows (reversal_of), each original row reversed at most once.
 * Balances and valuations are the sums of these rows (the inventory:daily job checks and rebuilds them).
 */
export const stockMoves = inventorySchema.table('stock_moves', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  itemId: bigint('item_id', { mode: 'number' }).notNull(),
  locationId: bigint('location_id', { mode: 'number' }).notNull(),
  batchId: bigint('batch_id', { mode: 'number' }),
  serialNo: text('serial_no'),
  qtyDelta: numeric('qty_delta', { precision: 18, scale: 4 }).notNull(),
  unitCostMinor: numeric('unit_cost_minor', { precision: 24, scale: 6 }).notNull(),
  valueDeltaMinor: bigint('value_delta_minor', { mode: 'bigint' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  documentId: bigint('document_id', { mode: 'number' }).notNull(),
  documentLineId: bigint('document_line_id', { mode: 'number' }).notNull(),
  movedAt: timestamp('moved_at', { withTimezone: true }).notNull().defaultNow(),
  reversalOf: bigint('reversal_of', { mode: 'number' }),
}, (t) => [
  foreignKey({ name: 'stock_moves_item_company_fk', columns: [t.itemId, t.legalEntityId], foreignColumns: [items.id, items.legalEntityId] }),
  foreignKey({ name: 'stock_moves_location_company_fk', columns: [t.locationId, t.legalEntityId], foreignColumns: [locations.id, locations.legalEntityId] }),
  foreignKey({ name: 'stock_moves_batch_item_fk', columns: [t.batchId, t.itemId, t.legalEntityId], foreignColumns: [stockBatches.id, stockBatches.itemId, stockBatches.legalEntityId] }),
  foreignKey({ name: 'stock_moves_document_company_fk', columns: [t.documentId, t.legalEntityId], foreignColumns: [stockDocuments.id, stockDocuments.legalEntityId] }),
  foreignKey({ name: 'stock_moves_line_company_fk', columns: [t.documentLineId, t.legalEntityId], foreignColumns: [stockDocumentLines.id, stockDocumentLines.legalEntityId] }),
  foreignKey({ name: 'stock_moves_reversal_company_fk', columns: [t.reversalOf, t.legalEntityId], foreignColumns: [t.id, t.legalEntityId] }),
  unique('stock_moves_id_company_unique').on(t.id, t.legalEntityId),
  uniqueIndex('stock_moves_reversed_once').on(t.reversalOf).where(sql`reversal_of IS NOT NULL`),
  index('idx_stock_moves_item_location').on(t.legalEntityId, t.itemId, t.locationId),
  index('idx_stock_moves_document').on(t.documentId),
  check('stock_moves_qty_check', sql`qty_delta <> 0`),
  check('stock_moves_money_check', sql`unit_cost_minor >= 0 AND currency = 'INR' AND (value_delta_minor = 0 OR sign(value_delta_minor) = sign(qty_delta))`),
]);

/**
 * How much of an item is in a location (and batch) now: the sum of its stock_moves. Never below zero. reserved (part
 * requests, later) is part of on_hand; available = on_hand - reserved. Changed only by posting, under a row lock.
 */
export const stockBalances = inventorySchema.table('stock_balances', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  itemId: bigint('item_id', { mode: 'number' }).notNull(),
  locationId: bigint('location_id', { mode: 'number' }).notNull(),
  batchId: bigint('batch_id', { mode: 'number' }),
  onHand: numeric('on_hand', { precision: 18, scale: 4 }).notNull().default('0'),
  reserved: numeric('reserved', { precision: 18, scale: 4 }).notNull().default('0'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'stock_balances_item_company_fk', columns: [t.itemId, t.legalEntityId], foreignColumns: [items.id, items.legalEntityId] }),
  foreignKey({ name: 'stock_balances_location_company_fk', columns: [t.locationId, t.legalEntityId], foreignColumns: [locations.id, locations.legalEntityId] }),
  foreignKey({ name: 'stock_balances_batch_item_fk', columns: [t.batchId, t.itemId, t.legalEntityId], foreignColumns: [stockBatches.id, stockBatches.itemId, stockBatches.legalEntityId] }),
  unique('stock_balances_place_unique').on(t.legalEntityId, t.itemId, t.locationId, t.batchId).nullsNotDistinct(),
  index('idx_stock_balances_location').on(t.locationId),
  check('stock_balances_on_hand_check', sql`on_hand >= 0`),
  check('stock_balances_reserved_check', sql`reserved >= 0 AND reserved <= on_hand`),
]);

/**
 * The value of an item's stock in its company: total quantity, total value and the moving weighted average cost (minor
 * units per base unit). Receipts and returns recalculate the average; issues and transfers take it. Nothing in stock
 * means no value. Changed only by posting, under a row lock.
 */
export const stockValuations = inventorySchema.table('stock_valuations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  itemId: bigint('item_id', { mode: 'number' }).notNull(),
  onHand: numeric('on_hand', { precision: 18, scale: 4 }).notNull().default('0'),
  valueMinor: bigint('value_minor', { mode: 'bigint' }).notNull().default(sql`0`),
  avgCostMinor: numeric('avg_cost_minor', { precision: 24, scale: 6 }).notNull().default('0'),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'stock_valuations_item_company_fk', columns: [t.itemId, t.legalEntityId], foreignColumns: [items.id, items.legalEntityId] }),
  unique('stock_valuations_item_unique').on(t.itemId),
  check('stock_valuations_amounts_check', sql`on_hand >= 0 AND value_minor >= 0 AND avg_cost_minor >= 0 AND currency = 'INR'`),
  check('stock_valuations_empty_has_no_value', sql`on_hand > 0 OR value_minor = 0`),
]);

/** The next number of each document type per company (GRN-00001, ISS-00001, REQ-00001 …); the row is locked while a number is taken. */
export const documentSeries = inventorySchema.table('document_series', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  docType: text('doc_type').notNull(),
  nextNumber: integer('next_number').notNull().default(1),
}, (t) => [
  unique('document_series_company_type_unique').on(t.legalEntityId, t.docType),
  check('document_series_type_check', sql`doc_type IN ('receipt','issue','return','transfer','reversal','request')`),
  check('document_series_next_check', sql`next_number >= 1`),
]);

/**
 * Serial-numbered units: one row per unit of a serial item, in exactly one location at a time (location null: not in
 * stock: issued, or its receipt reversed). Posting moves it: a unit arriving must not be in stock anywhere, a unit
 * leaving must be in that location. The serial number is unique per item.
 */
export const stockSerials = inventorySchema.table('stock_serials', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  itemId: bigint('item_id', { mode: 'number' }).notNull(),
  serialNo: text('serial_no').notNull(),
  locationId: bigint('location_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'stock_serials_item_company_fk', columns: [t.itemId, t.legalEntityId], foreignColumns: [items.id, items.legalEntityId] }),
  foreignKey({ name: 'stock_serials_location_company_fk', columns: [t.locationId, t.legalEntityId], foreignColumns: [locations.id, locations.legalEntityId] }),
  unique('stock_serials_item_serial_unique').on(t.itemId, t.serialNo),
  index('idx_stock_serials_location').on(t.locationId),
  check('stock_serials_serial_length', sql`char_length(serial_no) BETWEEN 1 AND 80`),
]);
