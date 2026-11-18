import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from './common';
/**
 * Accounts: payment requests, payment batches, the bank statement and reports. Money is integer paise (`*Minor`), INR only.
 * The maker asks, the checker (a different person) approves, the maker pays and reconciles. Nothing here is ever deleted.
 * First version: paying a batch does not write a journal entry yet (the posting rule for payments is for the CA to confirm).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const company = z.string().trim().min(1).max(12);
const amountMinor = z.number().int().min(1, 'The amount must be more than zero').max(100_000_000_00_00);

/** Bank ledgers a batch can be paid from, and a statement belongs to. */
export const BANK_LEDGER_KEYS = ['bank.operating', 'bank.salary'] as const;
export const BankLedgerKey = z.enum(BANK_LEDGER_KEYS);
export type BankLedgerKey = z.infer<typeof BankLedgerKey>;

// ---- payment requests ----

export const PayeeKind = z.enum(['vendor', 'employee', 'other']);
export type PayeeKind = z.infer<typeof PayeeKind>;
export const PaymentRequestState = z.enum(['pending', 'approved', 'rejected', 'batched', 'paid', 'cancelled']);
export type PaymentRequestState = z.infer<typeof PaymentRequestState>;

/** GET /api/accounts/payment-requests?company=&state= */
export const PaymentRequestsQuery = z.object({ company, state: emptyToUndefined(PaymentRequestState) });
export type PaymentRequestsQuery = z.infer<typeof PaymentRequestsQuery>;
/** POST /api/accounts/payment-requests — the maker asks for a payment. The same publicId sent twice is stored once. */
export const NewPaymentRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  payeeName: z.string().trim().min(1, 'Name the payee').max(120),
  payeeKind: PayeeKind,
  purpose: z.string().trim().min(3, 'Say what the payment is for').max(300),
  amountMinor,
  dueDate: isoDate,
});
export type NewPaymentRequest = z.infer<typeof NewPaymentRequest>;
/** POST /api/accounts/payment-requests/:publicId/reject and /cancel */
export const PaymentDecision = z.object({ note: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(300) });
export type PaymentDecision = z.infer<typeof PaymentDecision>;
export const PaymentRequest = z.object({
  publicId: PublicId, company: z.string(), payeeName: z.string(), payeeKind: PayeeKind, purpose: z.string(),
  amountMinor: z.number().int(), currency: z.string(), dueDate: DateOnly, state: PaymentRequestState,
  requestedBy: PersonRef, requestedAt: Instant, decidedBy: PersonRef.nullable(), decidedAt: Instant.nullable(), decisionNote: z.string().nullable(),
  batchPublicId: PublicId.nullable(),
});
export type PaymentRequest = z.infer<typeof PaymentRequest>;

// ---- payment batches ----

export const PaymentBatchState = z.enum(['draft', 'approved', 'paid', 'cancelled']);
export type PaymentBatchState = z.infer<typeof PaymentBatchState>;
/** GET /api/accounts/payment-batches?company= */
export const PaymentBatchesQuery = z.object({ company });
export type PaymentBatchesQuery = z.infer<typeof PaymentBatchesQuery>;
/** POST /api/accounts/payment-batches — the maker groups approved requests to be paid from one bank ledger. */
export const NewPaymentBatch = z.object({
  publicId: z.string().uuid().optional(),
  company,
  bankLedgerKey: BankLedgerKey,
  requestPublicIds: z.array(z.string().uuid()).min(1, 'Pick at least one request').max(200),
});
export type NewPaymentBatch = z.infer<typeof NewPaymentBatch>;
/** POST /api/accounts/payment-batches/:publicId/mark-paid — the maker says the money has left the bank. */
export const MarkBatchPaid = z.object({ paidOn: isoDate, bankReference: z.string().trim().min(1, 'Give the bank reference (UTR)').max(60) });
export type MarkBatchPaid = z.infer<typeof MarkBatchPaid>;
export const PaymentBatch = z.object({
  publicId: PublicId, company: z.string(), bankLedgerKey: z.string(), state: PaymentBatchState,
  requestCount: z.number().int(), totalMinor: z.number().int(), currency: z.string(),
  createdBy: PersonRef, createdAt: Instant, approvedBy: PersonRef.nullable(), approvedAt: Instant.nullable(),
  paidOn: DateOnly.nullable(), bankReference: z.string().nullable(), paidBy: PersonRef.nullable(),
  /** The bank statement line that confirmed it, once reconciled. */
  reconciled: z.boolean(),
});
export type PaymentBatch = z.infer<typeof PaymentBatch>;
export const PaymentBatchDetail = PaymentBatch.extend({ requests: z.array(PaymentRequest) });
export type PaymentBatchDetail = z.infer<typeof PaymentBatchDetail>;

// ---- bank statement ----

export const BankLineState = z.enum(['unmatched', 'matched']);
export type BankLineState = z.infer<typeof BankLineState>;
/** GET /api/accounts/bank/lines?company=&bankLedgerKey=&state= */
export const BankLinesQuery = z.object({ company, bankLedgerKey: emptyToUndefined(BankLedgerKey), state: emptyToUndefined(BankLineState) });
export type BankLinesQuery = z.infer<typeof BankLinesQuery>;
/** One statement row. Exactly one of debitMinor (money out) and creditMinor (money in) is above zero. */
export const BankImportLine = z.object({
  txnDate: isoDate,
  description: z.string().trim().min(1).max(200),
  reference: z.string().trim().max(60).optional(),
  debitMinor: z.number().int().min(0),
  creditMinor: z.number().int().min(0),
}).refine((l) => (l.debitMinor > 0) !== (l.creditMinor > 0), { message: 'A line is either money out or money in, not both and not zero' });
export type BankImportLine = z.infer<typeof BankImportLine>;
/** POST /api/accounts/bank/import — rows already on file (same date, reference, amount, text) are skipped, so a statement can be sent twice. */
export const BankImportRequest = z.object({ company, bankLedgerKey: BankLedgerKey, lines: z.array(BankImportLine).min(1, 'No lines to import').max(2000) });
export type BankImportRequest = z.infer<typeof BankImportRequest>;
export const BankImportResult = z.object({ imported: z.number().int(), skipped: z.number().int() });
export type BankImportResult = z.infer<typeof BankImportResult>;
/** POST /api/accounts/bank/lines/:publicId/match — ties a money-out line to the paid batch it settled (same amount, same bank). */
export const MatchBankLine = z.object({ batchPublicId: z.string().uuid() });
export type MatchBankLine = z.infer<typeof MatchBankLine>;
export const BankLine = z.object({
  publicId: PublicId, company: z.string(), bankLedgerKey: z.string(), txnDate: DateOnly, description: z.string(), reference: z.string().nullable(),
  debitMinor: z.number().int(), creditMinor: z.number().int(), state: BankLineState,
  matchedBatchPublicId: PublicId.nullable(), matchedBy: PersonRef.nullable(), matchedAt: Instant.nullable(),
});
export type BankLine = z.infer<typeof BankLine>;

// ---- reports ----

/** GET /api/accounts/reports/trial-balance?company=&from=&to= — every ledger with entries, from the journal. */
export const TrialBalanceQuery = z.object({ company, from: emptyToUndefined(isoDate), to: emptyToUndefined(isoDate) });
export type TrialBalanceQuery = z.infer<typeof TrialBalanceQuery>;
export const TrialBalanceRow = z.object({ ledgerKey: z.string(), debitMinor: z.number().int(), creditMinor: z.number().int(), balanceMinor: z.number().int() });
export type TrialBalanceRow = z.infer<typeof TrialBalanceRow>;
export const TrialBalance = z.object({
  company: z.string(), from: DateOnly.nullable(), to: DateOnly.nullable(), rows: z.array(TrialBalanceRow),
  totalDebitMinor: z.number().int(), totalCreditMinor: z.number().int(),
});
export type TrialBalance = z.infer<typeof TrialBalance>;
/** GET /api/accounts/reports/payments-summary?company= — where requests, batches and the bank statement stand. */
export const PaymentsSummaryQuery = z.object({ company });
export type PaymentsSummaryQuery = z.infer<typeof PaymentsSummaryQuery>;
const Count = z.object({ count: z.number().int(), totalMinor: z.number().int() });
export const PaymentsSummary = z.object({
  company: z.string(),
  requests: z.record(PaymentRequestState, Count),
  batches: z.record(PaymentBatchState, Count),
  bank: z.object({ unmatchedOut: Count, unmatchedIn: Count, matched: Count, paidBatchesNotReconciled: Count }),
});
export type PaymentsSummary = z.infer<typeof PaymentsSummary>;
