import { pgSchema, bigint, text, uuid, timestamp, smallint } from 'drizzle-orm/pg-core';
import { persons } from '../core/schema';
export const ticketsSchema = pgSchema('tickets');

export const tickets = ticketsSchema.table('tickets', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  number: text('number').notNull(),
  priority: smallint('priority').notNull(),
  status: text('status').notNull().default('assigned'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  description: text('description').notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
});
