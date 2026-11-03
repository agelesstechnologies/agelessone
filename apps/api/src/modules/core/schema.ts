import { sql } from 'drizzle-orm';
import { pgSchema, bigint, text, uuid, timestamp, boolean, varchar, check, unique } from 'drizzle-orm/pg-core';
export const core = pgSchema('core');

/** One row per company group using the platform. Full Core tables: see docs/reference/ageless_core_tickets_hrms.sql */
export const tenants = core.table('tenants', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The registered companies inside a tenant (AE, ATPL ...). */
export const legalEntities = core.table('legal_entities', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  code: varchar('code', { length: 12 }).notNull(),
  name: text('name').notNull(),
  legalForm: text('legal_form').notNull(),
  pan: varchar('pan', { length: 10 }),
}, (t) => [
  unique().on(t.tenantId, t.code),
  check('legal_entities_legal_form_check', sql`${t.legalForm} IN ('partnership','private_limited','llp','proprietorship','other')`),
]);

/** One record per human, shared by every module. */
export const persons = core.table('persons', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personType: text('person_type').notNull(),
  displayName: text('display_name').notNull(),
  fullName: text('full_name').notNull(),
  mobile: text('mobile'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
