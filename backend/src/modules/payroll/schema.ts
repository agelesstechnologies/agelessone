import { sql } from 'drizzle-orm';
import { bigint, char, check, date, foreignKey, index, integer, numeric, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { legalEntities, persons } from '../core/schema';
import { employments } from '../hrms/people/schema';

/** The PostgreSQL schema that only the Payroll module writes to. */
export const payroll = pgSchema('payroll');

/** A job's fixed monthly salary from a date. Never edited or deleted (trigger, migration 0020): a change is a new row. */
export const salaries = payroll.table('salaries', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  monthlyAmountPaise: bigint('monthly_amount_paise', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  effectiveFrom: date('effective_from').notNull(),
  note: text('note'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'salaries_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  unique('salaries_employment_from_unique').on(t.employmentId, t.effectiveFrom),
  check('salaries_amount_positive', sql`monthly_amount_paise > 0`),
]);

/**
 * Where a job's salary is paid, from a date. Never edited or deleted: a change is a new row. The account number is
 * shown masked by the API and only appears in full in the bank upload file.
 */
export const bankAccounts = payroll.table('bank_accounts', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  accountHolder: text('account_holder').notNull(),
  accountNumber: text('account_number').notNull(),
  ifsc: text('ifsc').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'bank_accounts_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  unique('bank_accounts_employment_from_unique').on(t.employmentId, t.effectiveFrom),
  check('bank_accounts_number_format', sql`account_number ~ '^[0-9]{6,18}$'`),
  check('bank_accounts_ifsc_format', sql`ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'`),
]);

/**
 * One payroll per company per month: draft (recalculate and adjust freely) → approved (frozen) → paid.
 * Approved by someone other than whoever prepared it last. After approval only "paid" may be recorded (trigger).
 */
export const payrollRuns = payroll.table('payroll_runs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  status: text('status').notNull().default('draft'),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  preparedBy: bigint('prepared_by', { mode: 'number' }).notNull().references(() => persons.id),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(),
  approvedBy: bigint('approved_by', { mode: 'number' }).references(() => persons.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  bankRef: text('bank_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('payroll_runs_company_month_unique').on(t.legalEntityId, t.year, t.month),
  unique('payroll_runs_id_company_unique').on(t.id, t.legalEntityId),
  check('payroll_runs_month_check', sql`month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2100`),
  check('payroll_runs_status_check', sql`status IN ('draft','approved','paid')`),
  check('payroll_runs_not_own_approval', sql`approved_by IS NULL OR approved_by <> prepared_by`),
  check('payroll_runs_approved_fields', sql`(status = 'draft') = (approved_by IS NULL AND approved_at IS NULL)`),
  check('payroll_runs_paid_fields', sql`(status = 'paid') = (paid_at IS NOT NULL AND bank_ref IS NOT NULL)`),
]);

/** One person's pay in a run (all amounts in paise). Changes only while the run is a draft (trigger). */
export const payrollItems = payroll.table('payroll_items', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  runId: bigint('run_id', { mode: 'number' }).notNull(),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  monthlySalaryPaise: bigint('monthly_salary_paise', { mode: 'number' }).notNull(),
  daysInMonth: integer('days_in_month').notNull(),
  employedDays: integer('employed_days').notNull(),
  absentDays: numeric('absent_days', { precision: 4, scale: 1 }).notNull(),
  lopAmountPaise: bigint('lop_amount_paise', { mode: 'number' }).notNull(),
  salaryForMonthPaise: bigint('salary_for_month_paise', { mode: 'number' }).notNull(),
  additionsTotalPaise: bigint('additions_total_paise', { mode: 'number' }).notNull().default(0),
  deductionsTotalPaise: bigint('deductions_total_paise', { mode: 'number' }).notNull().default(0),
  netPayPaise: bigint('net_pay_paise', { mode: 'number' }).notNull(),
}, (t) => [
  foreignKey({ name: 'payroll_items_run_company_fk', columns: [t.runId, t.legalEntityId], foreignColumns: [payrollRuns.id, payrollRuns.legalEntityId] }),
  foreignKey({ name: 'payroll_items_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  unique('payroll_items_run_employment_unique').on(t.runId, t.employmentId),
  check('payroll_items_amounts_check', sql`monthly_salary_paise > 0 AND lop_amount_paise >= 0 AND salary_for_month_paise >= 0
    AND additions_total_paise >= 0 AND deductions_total_paise >= 0 AND absent_days >= 0`),
  check('payroll_items_net_check', sql`net_pay_paise = salary_for_month_paise + additions_total_paise - deductions_total_paise AND net_pay_paise >= 0`),
]);

/** An addition (bonus …) or deduction (PT, TDS, ESI, advance …) on one person's pay; only while the run is a draft. */
export const payrollAdjustments = payroll.table('payroll_adjustments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  itemId: bigint('item_id', { mode: 'number' }).notNull().references(() => payrollItems.id),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  note: text('note'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_payroll_adjustments_item').on(t.itemId),
  check('payroll_adjustments_kind_check', sql`kind IN ('addition','deduction')`),
  check('payroll_adjustments_amount_positive', sql`amount_paise > 0`),
]);
