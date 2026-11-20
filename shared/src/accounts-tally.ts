import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from './common';
/**
 * Accounts -> Tally sync. There is no connection to Tally: a batch is a file. The maker creates it from journal entries,
 * a different person (the checker) approves it, only then can it be downloaded, and the accountant says what happened
 * when they imported it into Tally. Entries Tally refused go back to the queue with its error text.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const company = z.string().trim().min(1).max(12);

/** GET /api/accounts/tally/queue?company=&from=&to= — entries not yet in a live batch. */
export const TallyQueueQuery = z.object({ company, from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: 'The start date is after the end date', path: ['from'] });
export type TallyQueueQuery = z.infer<typeof TallyQueueQuery>;

export const TallyQueueItem = z.object({
  entryPublicId: PublicId, entryDate: DateOnly, sourceType: z.string(), totalMinor: z.number().int(),
  /** Ready entries go into the next batch. Blocked ones use ledger keys with no approved Tally ledger yet. */
  ready: z.boolean(),
  blockedKeys: z.array(z.string()),
  /** Tally's error text when an earlier attempt failed (the entry is back in the queue). */
  lastError: z.string().nullable(),
});
export type TallyQueueItem = z.infer<typeof TallyQueueItem>;
export const TallyQueue = z.object({
  items: z.array(TallyQueueItem), readyCount: z.number().int(), blockedCount: z.number().int(), returnedCount: z.number().int(),
  /** Only the first entries by date are listed and batched at once. */
  limited: z.boolean(),
});
export type TallyQueue = z.infer<typeof TallyQueue>;

/** POST /api/accounts/tally/batches — the maker builds one batch from the ready entries in the range. */
export const NewTallyBatchRequest = z.object({ publicId: z.string().uuid().optional(), company, from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: 'The start date is after the end date', path: ['from'] });
export type NewTallyBatchRequest = z.infer<typeof NewTallyBatchRequest>;

export const TallyBatchState = z.enum(['built', 'approved', 'imported', 'cancelled']);
export type TallyBatchState = z.infer<typeof TallyBatchState>;
export const TallyExportState = z.enum(['pending', 'created', 'failed']);
export type TallyExportState = z.infer<typeof TallyExportState>;

/** GET /api/accounts/tally/batches?company= */
export const TallyBatchesQuery = z.object({ company });
export type TallyBatchesQuery = z.infer<typeof TallyBatchesQuery>;

export const TallyBatch = z.object({
  publicId: PublicId, company: z.string(), tallyCompanyName: z.string(), state: TallyBatchState,
  entryCount: z.number().int(), totalMinor: z.number().int(),
  createdBy: PersonRef, createdAt: Instant, approvedBy: PersonRef.nullable(), approvedAt: Instant.nullable(),
  downloadedAt: Instant.nullable(), finishedBy: PersonRef.nullable(), finishedAt: Instant.nullable(),
  /** Entries that Tally refused (or that were left out because the batch was cancelled). */
  failedCount: z.number().int(),
  hasResult: z.boolean(),
  /** The Tally connector recorded the import (no person). */
  importedByConnector: z.boolean(),
  /** The connector will not post this batch again until a person decides (the answer from Tally was in doubt or unclear). */
  onHold: z.boolean(),
  /** The connector's latest note: why it could not post, or why the batch is on hold. */
  connectorMessage: z.string().nullable(),
});
export type TallyBatch = z.infer<typeof TallyBatch>;
export const TallyBatchEntry = z.object({
  entryPublicId: PublicId, entryDate: DateOnly, sourceType: z.string(), voucherType: z.string(), totalMinor: z.number().int(),
  state: TallyExportState, tallyMessage: z.string().nullable(),
});
export type TallyBatchEntry = z.infer<typeof TallyBatchEntry>;
export const TallyBatchDetail = TallyBatch.extend({ entries: z.array(TallyBatchEntry) });
export type TallyBatchDetail = z.infer<typeof TallyBatchDetail>;
/** The answer to creating a batch: the batch, and how many entries were left in the queue because a ledger is not mapped yet. */
export const CreatedTallyBatch = TallyBatchDetail.extend({ skippedBlocked: z.number().int() });
export type CreatedTallyBatch = z.infer<typeof CreatedTallyBatch>;

/**
 * POST /api/accounts/tally/batches/:publicId/mark-imported — the accountant says the file is in Tally. Entries named in
 * `failed` go back to the queue with the error text; every other entry is recorded as created.
 */
export const MarkImportedRequest = z.object({
  failed: z.array(z.object({ entryPublicId: PublicId, error: z.string().trim().min(1, 'Give the error Tally showed').max(500) })).max(1000).default([]),
});
export type MarkImportedRequest = z.infer<typeof MarkImportedRequest>;

/** POST /api/accounts/tally/batches/:publicId/import-result — Tally's own import result (its XML answer), pasted or read from a file. */
export const ImportResultRequest = z.object({ resultText: z.string().trim().min(1, 'The result is empty').max(500_000) });
export type ImportResultRequest = z.infer<typeof ImportResultRequest>;
