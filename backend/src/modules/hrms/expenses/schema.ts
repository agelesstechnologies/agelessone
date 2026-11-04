import { sql } from 'drizzle-orm';
import { bigint, text, date, uuid, boolean, timestamp, check, unique, index, char, foreignKey } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { legalEntities, persons } from '../../core/schema';
import { tickets } from '../../tickets/schema';
import { employments } from '../people/schema';

/** fuel, travel, food, materials, other ... per tenant; receipt_required decides whether a photo/PDF must be attached. */
export const expenseCategories = hrms.table('expense_categories', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  receiptRequired: boolean('receipt_required').notNull().default(true),
}, (t) => [unique('expense_categories_tenant_code_unique').on(t.tenantId, t.code)]);

/** submitted → approved → paid, or submitted → rejected. A paid claim never changes (trigger in migration 0006). */
export const expenseClaims = hrms.table('expense_claims', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  categoryId: bigint('category_id', { mode: 'number' }).notNull().references(() => expenseCategories.id),
  spentOn: date('spent_on').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'), // of amount_paise / approved_amount_paise
  description: text('description'),
  receiptPath: text('receipt_path'),                       // relative to the uploads folder
  ticketId: bigint('ticket_id', { mode: 'number' }).references(() => tickets.id), // link to a service ticket
  status: text('status').notNull().default('submitted'),
  approvedBy: bigint('approved_by', { mode: 'number' }).references(() => persons.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedAmountPaise: bigint('approved_amount_paise', { mode: 'number' }),
  rejectedBy: bigint('rejected_by', { mode: 'number' }).references(() => persons.id),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  paymentRef: text('payment_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'expense_claims_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  index('idx_expense_claims_person').on(sql`person_id`),
  index('idx_expense_claims_employment').on(sql`employment_id`),
  check('expense_claims_status_check', sql`status IN ('submitted','approved','rejected','paid')`),
  check('expense_claims_amount_positive', sql`amount_paise > 0`),
  check('expense_claims_not_self_approved', sql`approved_by IS NULL OR approved_by <> person_id`),
  check('expense_claims_not_self_rejected', sql`rejected_by IS NULL OR rejected_by <> person_id`),
  check('expense_claims_approved_within_claim', sql`approved_amount_paise IS NULL OR (approved_amount_paise > 0 AND approved_amount_paise <= amount_paise)`),
  check('expense_claims_paid_has_details', sql`status <> 'paid' OR (paid_at IS NOT NULL AND payment_ref IS NOT NULL)`),
  check('expense_claims_rejected_has_reason', sql`status <> 'rejected' OR rejection_reason IS NOT NULL`),
]);
