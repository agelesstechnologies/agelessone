import { pgSchema, bigint, text, uuid, timestamp } from 'drizzle-orm/pg-core';
export const core = pgSchema('core');

/** One record per human, shared by every module. Full Core tables: see docs/reference/ageless_core_tickets_hrms.sql */
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
