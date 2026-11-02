import { bigint, text, date, uuid, boolean } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { persons } from '../../core/schema';
import { tickets } from '../../tickets/schema';

export const expenseCategories = hrms.table('expense_categories', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  receiptRequired: boolean('receipt_required').notNull().default(true),
});
export const expenseClaims = hrms.table('expense_claims', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  categoryId: bigint('category_id', { mode: 'number' }).notNull().references(() => expenseCategories.id),
  spentOn: date('spent_on').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).references(() => tickets.id), // link to a service ticket
  status: text('status').notNull().default('submitted'),
});
