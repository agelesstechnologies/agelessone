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
  /** The ledger this category posts to in Accounts: one of the expense.* keys of LEDGER_KEYS (@ageless/shared). */
  ledgerKey: text('ledger_key').notNull(),
}, (t) => [
  unique('expense_categories_tenant_code_unique').on(t.tenantId, t.code),
  check('expense_categories_ledger_key_check', sql`ledger_key LIKE 'expense.%' AND accounts.is_ledger_key(ledger_key)`),
]);

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
  decidedAs: text('decided_as'), // approver | hr | management | no_approval_required (see migration 0021)
  approvedAmountPaise: bigint('approved_amount_paise', { mode: 'number' }),
  rejectedBy: bigint('rejected_by', { mode: 'number' }).references(() => persons.id),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  paymentRef: text('payment_ref'),
  // sent to the CEO: forwarded by an approver (escalated_by) or automatically after the waiting days (escalated_by null)
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  escalatedBy: bigint('escalated_by', { mode: 'number' }).references(() => persons.id),
  escalationReason: text('escalation_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('expense_claims_escalation_fields', sql`(escalated_at IS NULL) = (escalation_reason IS NULL) AND (escalated_by IS NULL OR escalated_at IS NOT NULL)`),
  foreignKey({ name: 'expense_claims_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  index('idx_expense_claims_person').on(sql`person_id`),
  index('idx_expense_claims_employment').on(sql`employment_id`),
  check('expense_claims_status_check', sql`status IN ('submitted','approved','rejected','paid')`),
  check('expense_claims_amount_positive', sql`amount_paise > 0`),
  check('expense_claims_not_self_approved', sql`approved_by IS NULL OR approved_by <> person_id`),
  check('expense_claims_not_self_rejected', sql`rejected_by IS NULL OR rejected_by <> person_id`),
  check('expense_claims_approved_within_claim', sql`approved_amount_paise IS NULL OR (approved_amount_paise > 0 AND approved_amount_paise <= amount_paise)`),
  check('expense_claims_paid_has_details', sql`status <> 'paid' OR (paid_at IS NOT NULL AND payment_ref IS NOT NULL)`),
  check('expense_claims_decided_fields', sql`(status NOT IN ('approved','paid') OR (approved_at IS NOT NULL AND decided_as IS NOT NULL))
    AND (status <> 'rejected' OR (rejected_by IS NOT NULL AND decided_as IS NOT NULL))`),
  check('expense_claims_decided_as_check', sql`decided_as IS NULL OR decided_as IN ('approver','hr','management','no_approval_required')`),
  // an approval always has an approver, except a claim that needed no approval (and that one never has one)
  check('expense_claims_decider_required', sql`decided_as IS NULL OR (decided_as = 'no_approval_required') = (approved_by IS NULL AND rejected_by IS NULL)`),
  check('expense_claims_rejected_has_reason', sql`status <> 'rejected' OR rejection_reason IS NOT NULL`),
]);
