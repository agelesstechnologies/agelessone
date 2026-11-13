import { sql } from 'drizzle-orm';
import { bigint, boolean, char, check, date, foreignKey, index, integer, jsonb, pgSchema, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { legalEntities, machineCredentials, persons } from '../core/schema';

/** The PostgreSQL schema that only the Accounts module writes to. */
export const accounts = pgSchema('accounts');

/**
 * One row per company per month, created when someone first closes it (no row = open). Closed months refuse new
 * journal entries (trigger, migration 0038). Reopening needs a request and the CEO's approval; both are audited.
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
 * or deleted: a change is a new version. Keys come from the fixed list in @ageless/shared (LEDGER_KEYS).
 * With no stored version the built-in default applies (domain/ledger.ts, to be confirmed by the CA).
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
  // Ledger keys come from the fixed list (accounts.is_ledger_key, migration 0039). NOT VALID in the migration: rows written before it are kept as they are.
  check('posting_rules_debit_key_check', sql`accounts.is_ledger_key(debit_ledger_key)`),
  check('posting_rules_credit_key_check', sql`accounts.is_ledger_key(credit_ledger_key)`),
  check('posting_rules_deduction_key_check', sql`deduction_ledger_key IS NULL OR accounts.is_ledger_key(deduction_ledger_key)`),
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
  check('journal_lines_key_check', sql`accounts.is_ledger_key(ledger_key)`),   // NOT VALID in the migration: older lines are kept (the journal is append-only)
]);

/**
 * The Tally company a legal entity's books go to: one row per company. The maker drafts, a different person (the checker)
 * approves. Changing the name or the start date withdraws the approval until it is approved again.
 */
export const tallyCompanies = accounts.table('tally_companies', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().unique().references(() => legalEntities.id),
  tallyCompanyName: text('tally_company_name').notNull(),
  booksFrom: date('books_from').notNull(),
  state: text('state').notNull().default('draft'),
  draftedBy: bigint('drafted_by', { mode: 'number' }).notNull().references(() => persons.id),
  draftedAt: timestamp('drafted_at', { withTimezone: true }).notNull().defaultNow(),
  approvedBy: bigint('approved_by', { mode: 'number' }).references(() => persons.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // The connector's last check of Tally against the ledger map (names Tally did not have exactly). Not part of the approval.
  connectorCheckedAt: timestamp('connector_checked_at', { withTimezone: true }),
  connectorMissing: jsonb('connector_missing').$type<{ ledgers: string[]; costCentres: string[] }>(),
}, (t) => [
  check('tally_companies_state_check', sql`state IN ('draft','approved')`),
  check('tally_companies_approved_fields', sql`(state = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)`),
  check('tally_companies_not_own_approval', sql`approved_by IS NULL OR approved_by <> drafted_by`),
  check('tally_companies_name_check', sql`btrim(tally_company_name) <> ''`),
]);

/**
 * Which Tally ledger each ledger key posts to, in the company's Tally company (tally_companies, one per legal entity).
 * The maker drafts, a different person (the checker) approves. Drafting a changed name withdraws the approval until it
 * is approved again, so Tally never gets a name nobody approved.
 */
export const tallyLedgerMap = accounts.table('tally_ledger_map', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  ledgerKey: text('ledger_key').notNull(),
  tallyLedgerName: text('tally_ledger_name').notNull(),
  state: text('state').notNull().default('draft'),
  draftedBy: bigint('drafted_by', { mode: 'number' }).notNull().references(() => persons.id),
  draftedAt: timestamp('drafted_at', { withTimezone: true }).notNull().defaultNow(),
  approvedBy: bigint('approved_by', { mode: 'number' }).references(() => persons.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tally_ledger_map_key_unique').on(t.legalEntityId, t.ledgerKey),
  foreignKey({ name: 'tally_ledger_map_tally_company_fk', columns: [t.legalEntityId], foreignColumns: [tallyCompanies.legalEntityId] }),
  check('tally_ledger_map_state_check', sql`state IN ('draft','approved')`),
  check('tally_ledger_map_approved_fields', sql`(state = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)`),
  check('tally_ledger_map_not_own_approval', sql`approved_by IS NULL OR approved_by <> drafted_by`),
  check('tally_ledger_map_key_check', sql`accounts.is_ledger_key(ledger_key)`),
]);

/**
 * One Tally import for one company: the Import Data envelope built from a set of journal entries. The journal itself is
 * never touched; this only records what was built and what Tally answered. There is no connection to Tally: a person
 * downloads the file and imports it by hand. built (the maker made it) -> approved (a different person, the checker, may
 * now let it be downloaded) -> imported (the accountant says it is in Tally, with any failed entries named), or cancelled.
 */
export const tallyBatches = accounts.table('tally_batches', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  tallyCompanyName: text('tally_company_name').notNull(),   // the name the envelope was built for (the company's Tally company at that time)
  state: text('state').notNull().default('built'),
  entryCount: integer('entry_count').notNull(),
  totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),   // sum of all debits (= all credits), in paise
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  requestXml: text('request_xml').notNull(),
  importResult: text('import_result'),   // Tally's own import result, when the accountant uploaded it
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  approvedBy: bigint('approved_by', { mode: 'number' }).references(() => persons.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  downloadedAt: timestamp('downloaded_at', { withTimezone: true }),   // the first download
  finishedBy: bigint('finished_by', { mode: 'number' }).references(() => persons.id),
  finishedByMachine: bigint('finished_by_machine', { mode: 'number' }).references(() => machineCredentials.id),   // imported by the Tally connector instead of a person
  finishedAt: timestamp('finished_at', { withTimezone: true }),      // when it was marked imported or cancelled
  // The connector's progress. on_hold: the request may have reached Tally with no answer, so it is not posted again until a person decides.
  connectorHold: boolean('connector_hold').notNull().default(false),
  connectorMessage: text('connector_message'),
  connectorAt: timestamp('connector_at', { withTimezone: true }),
}, (t) => [
  unique('tally_batches_id_company_unique').on(t.id, t.legalEntityId),
  foreignKey({ name: 'tally_batches_tally_company_fk', columns: [t.legalEntityId], foreignColumns: [tallyCompanies.legalEntityId] }),
  index('idx_tally_batches_company').on(t.legalEntityId, t.createdAt),
  check('tally_batches_state_check', sql`state IN ('built','approved','imported','cancelled')`),
  check('tally_batches_approval_check', sql`(approved_by IS NULL) = (approved_at IS NULL) AND (state NOT IN ('approved','imported') OR approved_by IS NOT NULL)`),
  check('tally_batches_not_own_approval', sql`approved_by IS NULL OR approved_by <> created_by`),
  check('tally_batches_download_after_approval', sql`downloaded_at IS NULL OR approved_by IS NOT NULL`),
  check('tally_batches_hold_check', sql`NOT connector_hold OR state = 'approved'`),
  check('tally_batches_finished_check', sql`(state IN ('imported','cancelled')) = (finished_at IS NOT NULL AND (finished_by IS NOT NULL OR finished_by_machine IS NOT NULL))`),
  check('tally_batches_counts_check', sql`entry_count > 0 AND total_minor > 0`),
  check('tally_batches_currency_check', sql`currency = 'INR'`),
]);

/** One journal entry inside a batch, as one Tally voucher (REMOTEID = the entry's public_id). */
export const tallyExports = accounts.table('tally_exports', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  batchId: bigint('batch_id', { mode: 'number' }).notNull(),
  entryId: bigint('entry_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  remoteId: uuid('remote_id').notNull(),
  voucherType: text('voucher_type').notNull(),
  state: text('state').notNull().default('pending'),
  tallyMessage: text('tally_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'tally_exports_batch_company_fk', columns: [t.batchId, t.legalEntityId], foreignColumns: [tallyBatches.id, tallyBatches.legalEntityId] }),
  foreignKey({ name: 'tally_exports_entry_company_fk', columns: [t.entryId, t.legalEntityId], foreignColumns: [journalEntries.id, journalEntries.legalEntityId] }),
  unique('tally_exports_batch_entry_unique').on(t.batchId, t.entryId),
  // An entry goes to Tally once: only a failed attempt may be tried again in a later batch.
  uniqueIndex('tally_exports_entry_once').on(t.entryId).where(sql`state <> 'failed'`),
  check('tally_exports_state_check', sql`state IN ('pending','created','failed')`),
  check('tally_exports_voucher_type_check', sql`voucher_type IN ('Platform Journal','Platform Payment')`),
]);
