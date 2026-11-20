import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from './common';
/** Accounts: periods, posting rules, journal entries and the Tally ledger map. Money is integer paise (`*Minor`), INR only for now. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const company = z.string().trim().min(1).max(12);
/**
 * The fixed list of ledger keys. Nothing else is accepted when a rule, a mapping, an expense category or a journal line is
 * written. // CA TO CONFIRM: the list is the accounting team's to settle. Adding a key means adding it here and in a new
 * migration that replaces the database function accounts.is_ledger_key (a test fails while the two differ).
 */
export const LEDGER_KEYS = [
  'salary.expense',
  'payable.salary', 'payable.reimbursements', 'payable.vendors',
  'stat.pf', 'stat.esi', 'stat.pt', 'stat.tds',
  'asset.staff_advance',
  'tax.input_cgst', 'tax.input_sgst', 'tax.input_igst',
  'expense.fuel', 'expense.travel', 'expense.food', 'expense.materials', 'expense.other',
  'bank.salary', 'bank.operating',
  'round_off',
] as const;
export const LedgerKey = z.enum(LEDGER_KEYS, { errorMap: () => ({ message: `Not a known ledger key. Use one of: ${LEDGER_KEYS.join(', ')}` }) });
export type LedgerKey = z.infer<typeof LedgerKey>;
/** Keys an expense category may post to. */
export const EXPENSE_LEDGER_KEYS = LEDGER_KEYS.filter((k) => k.startsWith('expense.'));
/** The ledger of each payroll deduction label (case does not matter); a label not listed here cannot be posted until it is added. */
export const DEDUCTION_LEDGER_KEYS: Record<string, LedgerKey> = {
  pf: 'stat.pf', esi: 'stat.esi', pt: 'stat.pt', tds: 'stat.tds', advance: 'asset.staff_advance',
};
export const deductionLedgerKey = (label: string): LedgerKey | null => DEDUCTION_LEDGER_KEYS[label.trim().toLowerCase()] ?? null;
const Month = z.object({ company, year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });

/** What a caller may do in Accounts (from their role, or the interim policy accounts.interim_roles). */
export const AccountsAccess = z.object({ maker: z.boolean(), checker: z.boolean(), ceo: z.boolean(), view: z.boolean() });
export type AccountsAccess = z.infer<typeof AccountsAccess>;

// ---- periods ----

export const PeriodState = z.enum(['open', 'soft_closed', 'closed']);
export type PeriodState = z.infer<typeof PeriodState>;
/** GET /api/accounts/periods?company=&year= — all twelve months; a month nobody touched is open. */
export const PeriodsQuery = z.object({ company, year: z.preprocess((v) => (v === '' || v === undefined ? undefined : Number(v)), z.number().int().min(2000).max(2100)) });
export type PeriodsQuery = z.infer<typeof PeriodsQuery>;
/** POST /api/accounts/periods/soft-close and /close */
export const PeriodRequest = Month;
export type PeriodRequest = z.infer<typeof PeriodRequest>;
/** POST /api/accounts/periods/reopen-request — the accounts manager (or maker) asks; the CEO approves with /reopen-approve. */
export const ReopenRequest = Month.extend({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500) });
export type ReopenRequest = z.infer<typeof ReopenRequest>;
export const Period = z.object({
  publicId: PublicId.nullable(), company: z.string(), year: z.number().int(), month: z.number().int(), state: PeriodState,
  closedBy: PersonRef.nullable(), closedAt: Instant.nullable(),
  reopenRequestedBy: PersonRef.nullable(), reopenRequestedAt: Instant.nullable(), reopenReason: z.string().nullable(),
});
export type Period = z.infer<typeof Period>;

// ---- posting rules ----

/** The events that write a journal entry. */
export const PostingEvent = z.enum(['expense_approved', 'expense_paid', 'payroll_approved', 'salary_paid']);
export type PostingEvent = z.infer<typeof PostingEvent>;
/** GET /api/accounts/posting-rules?company= — the rule in force today for every event. */
export const PostingRulesQuery = z.object({ company: emptyToUndefined(company) });
export type PostingRulesQuery = z.infer<typeof PostingRulesQuery>;
/** POST /api/accounts/posting-rules — a new version (company left out: the group default). Accounts checker only. */
export const NewPostingRuleRequest = z.object({
  publicId: z.string().uuid().optional(),
  company: company.optional(),
  eventType: PostingEvent,
  debitLedgerKey: LedgerKey,
  creditLedgerKey: LedgerKey,
  /** payroll_approved only: a ledger for deductions whose label has no stat.* key of its own (see DEDUCTION_LEDGER_KEYS). */
  deductionLedgerKey: LedgerKey.optional(),
  effectiveFrom: isoDate,
});
export type NewPostingRuleRequest = z.infer<typeof NewPostingRuleRequest>;
export const PostingRule = z.object({
  publicId: PublicId.nullable(), company: z.string().nullable(), eventType: PostingEvent, debitLedgerKey: z.string(), creditLedgerKey: z.string(),
  deductionLedgerKey: z.string().nullable(), version: z.number().int(), effectiveFrom: DateOnly.nullable(),
  /** stored: a saved version; default: the built-in placeholder (to be confirmed by the CA) */
  source: z.enum(['stored', 'default']),
});
export type PostingRule = z.infer<typeof PostingRule>;

// ---- journal entries ----

export const JournalSourceType = z.enum(['expense_approved', 'expense_paid', 'payroll_approved', 'salary_paid', 'reversal']);
export type JournalSourceType = z.infer<typeof JournalSourceType>;
/** GET /api/accounts/journal-entries?company=&from=&to=&sourceType=&ledgerKey=&page=&pageSize= */
export const JournalEntriesQuery = z.object({
  company: emptyToUndefined(company),
  from: emptyToUndefined(isoDate),
  to: emptyToUndefined(isoDate),
  sourceType: emptyToUndefined(JournalSourceType),
  ledgerKey: emptyToUndefined(z.string().trim().max(80)),   // a search: old journal lines may hold keys that are no longer valid
  page: z.preprocess((v) => (v === '' || v === undefined ? 1 : Number(v)), z.number().int().min(1)),
  pageSize: z.preprocess((v) => (v === '' || v === undefined ? 50 : Number(v)), z.number().int().min(1).max(200)),
});
export type JournalEntriesQuery = z.infer<typeof JournalEntriesQuery>;
export const JournalLine = z.object({ ledgerKey: z.string(), debitMinor: z.number().int(), creditMinor: z.number().int() });
export type JournalLine = z.infer<typeof JournalLine>;
export const JournalEntry = z.object({
  publicId: PublicId, company: z.string(), sourceType: JournalSourceType, sourcePublicId: PublicId, entryDate: DateOnly, currency: z.string(),
  description: z.string().nullable(), reversesPublicId: PublicId.nullable(), reversedByPublicId: PublicId.nullable(),
  lines: z.array(JournalLine), totalDebitMinor: z.number().int(), totalCreditMinor: z.number().int(),
  createdBy: PersonRef.nullable(), createdAt: Instant,
});
export type JournalEntry = z.infer<typeof JournalEntry>;
export const JournalEntryPage = z.object({ items: z.array(JournalEntry), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });
export type JournalEntryPage = z.infer<typeof JournalEntryPage>;
/** POST /api/accounts/journal-entries/:publicId/reverse — corrections are only ever a reversing entry. Checker only. */
export const ReverseEntryRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export type ReverseEntryRequest = z.infer<typeof ReverseEntryRequest>;

// ---- Tally company ----

/** The Tally company a legal entity's books go to. One per company; the maker drafts, a different person (the checker) approves. */
export const TallyCompanyState = z.enum(['unset', 'draft', 'approved']);
export type TallyCompanyState = z.infer<typeof TallyCompanyState>;
/** GET /api/accounts/tally-company?company= */
export const TallyCompanyQuery = z.object({ company });
export type TallyCompanyQuery = z.infer<typeof TallyCompanyQuery>;
/** POST /api/accounts/tally-company — the maker drafts (or changes) it; a changed one needs approving again. */
export const DraftTallyCompanyRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  tallyCompanyName: z.string().trim().min(1).max(120),
  /** The first day of the books in Tally (nothing earlier is exported). */
  booksFrom: isoDate,
});
export type DraftTallyCompanyRequest = z.infer<typeof DraftTallyCompanyRequest>;
export const TallyCompany = z.object({
  publicId: PublicId.nullable(), company: z.string(), tallyCompanyName: z.string().nullable(), booksFrom: DateOnly.nullable(),
  state: TallyCompanyState, draftedBy: PersonRef.nullable(), approvedBy: PersonRef.nullable(), approvedAt: Instant.nullable(),
  /** The connector's last check of Tally against the ledger map: when, and the names Tally did not have exactly. Null until it has run. */
  connectorCheckedAt: Instant.nullable(),
  connectorMissing: z.object({ ledgers: z.array(z.string()), costCentres: z.array(z.string()) }).nullable(),
});
export type TallyCompany = z.infer<typeof TallyCompany>;

// ---- Tally ledger map ----

export const LedgerMapState = z.enum(['unmapped', 'draft', 'approved']);
export type LedgerMapState = z.infer<typeof LedgerMapState>;
/** GET /api/accounts/ledger-map?company= — stored mappings, plus the ledger keys the posting rules use that have none yet. The Tally company comes from the company's Tally company record. */
export const LedgerMapQuery = z.object({ company });
export type LedgerMapQuery = z.infer<typeof LedgerMapQuery>;
/** POST /api/accounts/ledger-map — the maker drafts (or changes) a mapping; a changed mapping needs approving again. */
export const DraftLedgerMapRequest = z.object({
  publicId: z.string().uuid().optional(),
  company, ledgerKey: LedgerKey,
  tallyLedgerName: z.string().trim().min(1).max(120),
});
export type DraftLedgerMapRequest = z.infer<typeof DraftLedgerMapRequest>;
export const LedgerMapEntry = z.object({
  publicId: PublicId.nullable(), company: z.string(), ledgerKey: z.string(), tallyCompany: z.string().nullable(), tallyLedgerName: z.string().nullable(),
  state: LedgerMapState, draftedBy: PersonRef.nullable(), approvedBy: PersonRef.nullable(), approvedAt: Instant.nullable(),
});
export type LedgerMapEntry = z.infer<typeof LedgerMapEntry>;
