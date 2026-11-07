import { sql } from 'drizzle-orm';
import { bigint, char, check, date, foreignKey, index, integer, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { legalEntities, persons } from '../core/schema';

/** The PostgreSQL schema that only the Accounts module writes to. */
export const accounts = pgSchema('accounts');

/**
 * One row per company per month, created when someone first closes it (no row = open). Closed months refuse new
 * journal entries (trigger, migration 0030). Reopening needs a request and the CEO's approval; both are audited.
 */
export const periods = accounts.table('periods', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  year: integer('year').notNull(),
  month: integer('month').notNull(),
  state: text('state').notNull().default('open'),
  closedBy: bigint('closed_by', { mode: 'number' }).references(() => persons.id),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  reopenRequestedBy: bigint('reopen_requested_by', { mode: 'number' }).references(() => persons.id),
  reopenRequestedAt: timestamp('reopen_requested_at', { withTimezone: true }),
  reopenReason: text('reopen_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('periods_company_month_unique').on(t.legalEntityId, t.year, t.month),
  check('periods_month_check', sql`month BETWEEN 1 AND 12 AND year BETWEEN 2000 AND 2100`),
  check('periods_state_check', sql`state IN ('open','soft_closed','closed')`),
]);

/**
 * Which ledgers an event debits and credits, per company or (legal_entity_id NULL) for the whole group. Never edited
 * or deleted: a change is a new version. Keys may hold a variable part: expense:<category>, deduction:<label>.
 * With no stored version the built-in default applies (domain/posting-rules.ts, to be confirmed by the CA).
 */
export const postingRules = accounts.table('posting_rules', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).references(() => legalEntities.id),
  eventType: text('event_type').notNull(),
  debitLedgerKey: text('debit_ledger_key').notNull(),
  creditLedgerKey: text('credit_ledger_key').notNull(),
  deductionLedgerKey: text('deduction_ledger_key'),
  version: integer('version').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('posting_rules_version_unique').on(t.tenantId, t.legalEntityId, t.eventType, t.version).nullsNotDistinct(),
  index('idx_posting_rules_event').on(t.tenantId, t.eventType, t.effectiveFrom),
  check('posting_rules_event_check', sql`event_type IN ('expense_approved','expense_paid','payroll_approved','salary_paid')`),
  check('posting_rules_version_positive', sql`version >= 1`),
]);

/**
 * One balanced entry per source document (unique), append-only (trigger). Debits equal credits at commit (deferred
 * constraint trigger). A correction is a new entry with source_type 'reversal' that points at the entry it reverses.
 */
export const journalEntries = accounts.table('journal_entries', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  sourceType: text('source_type').notNull(),
  sourcePublicId: uuid('source_public_id').notNull(),
  entryDate: date('entry_date').notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  description: text('description'),
  reversesEntryId: bigint('reverses_entry_id', { mode: 'number' }),
  createdBy: bigint('created_by', { mode: 'number' }).references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('journal_entries_source_unique').on(t.legalEntityId, t.sourceType, t.sourcePublicId),
  unique('journal_entries_id_company_unique').on(t.id, t.legalEntityId),
  unique('journal_entries_reverses_unique').on(t.reversesEntryId),
  foreignKey({ name: 'journal_entries_reverses_fk', columns: [t.reversesEntryId, t.legalEntityId], foreignColumns: [t.id, t.legalEntityId] }),
  index('idx_journal_entries_date').on(t.legalEntityId, t.entryDate),
  check('journal_entries_source_check', sql`source_type IN ('expense_approved','expense_paid','payroll_approved','salary_paid','reversal')`),
  check('journal_entries_currency_check', sql`currency = 'INR'`),
  check('journal_entries_reversal_check', sql`(source_type = 'reversal') = (reverses_entry_id IS NOT NULL)`),
]);

/** A line debits or credits one ledger, never both. Append-only (trigger). */
export const journalLines = accounts.table('journal_lines', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  entryId: bigint('entry_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  lineNo: integer('line_no').notNull(),
  ledgerKey: text('ledger_key').notNull(),
  debitMinor: bigint('debit_minor', { mode: 'number' }).notNull().default(0),
  creditMinor: bigint('credit_minor', { mode: 'number' }).notNull().default(0),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
}, (t) => [
  foreignKey({ name: 'journal_lines_entry_company_fk', columns: [t.entryId, t.legalEntityId], foreignColumns: [journalEntries.id, journalEntries.legalEntityId] }),
  unique('journal_lines_entry_line_unique').on(t.entryId, t.lineNo),
  index('idx_journal_lines_ledger').on(t.legalEntityId, t.ledgerKey),
  check('journal_lines_amount_check', sql`debit_minor >= 0 AND credit_minor >= 0 AND (debit_minor > 0) <> (credit_minor > 0)`),
  check('journal_lines_currency_check', sql`currency = 'INR'`),
]);

/**
 * Which Tally ledger each ledger key posts to. The maker drafts, a different person (the checker) approves. Drafting
 * a changed name withdraws the approval until it is approved again, so Tally never gets a name nobody approved.
 */
export const tallyLedgerMap = accounts.table('tally_ledger_map', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  ledgerKey: text('ledger_key').notNull(),
  tallyCompany: text('tally_company').notNull(),
  tallyLedgerName: text('tally_ledger_name').notNull(),
  state: text('state').notNull().default('draft'),
  draftedBy: bigint('drafted_by', { mode: 'number' }).notNull().references(() => persons.id),
  draftedAt: timestamp('drafted_at', { withTimezone: true }).notNull().defaultNow(),
  approvedBy: bigint('approved_by', { mode: 'number' }).references(() => persons.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tally_ledger_map_key_unique').on(t.legalEntityId, t.ledgerKey),
  check('tally_ledger_map_state_check', sql`state IN ('draft','approved')`),
  check('tally_ledger_map_approved_fields', sql`(state = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)`),
  check('tally_ledger_map_not_own_approval', sql`approved_by IS NULL OR approved_by <> drafted_by`),
]);
