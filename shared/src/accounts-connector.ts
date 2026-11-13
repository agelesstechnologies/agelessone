import { z } from 'zod';
import { Instant, PublicId } from './common';
import { TallyBatchState } from './accounts-tally';
/**
 * The Tally connector: a small program on the Tally server PC. It only ever calls out (no inbound ports): it signs in with
 * a machine credential, polls the outbox, posts each approved batch to Tally on that PC (http://localhost:9000), and reports
 * what Tally said. It can use these routes and nothing else.
 */

/** Machine credentials are made by an admin; the secret is shown once. */
export const MACHINE_PERMISSIONS = ['accounts.tally.connector'] as const;
export const CreateMachineCredentialRequest = z.object({ name: z.string().trim().min(3).max(80), permission: z.enum(MACHINE_PERMISSIONS).default('accounts.tally.connector') });
export type CreateMachineCredentialRequest = z.infer<typeof CreateMachineCredentialRequest>;
export const MachineCredential = z.object({
  publicId: PublicId, name: z.string(), clientId: z.string(), permission: z.string(), isActive: z.boolean(),
  createdAt: Instant, lastUsedAt: Instant.nullable(), revokedAt: Instant.nullable(),
});
export type MachineCredential = z.infer<typeof MachineCredential>;
/** The secret is in this answer only; it cannot be read again. */
export const CreatedMachineCredential = MachineCredential.extend({ secret: z.string() });
export type CreatedMachineCredential = z.infer<typeof CreatedMachineCredential>;

/** POST /api/auth/machine-token */
export const MachineTokenRequest = z.object({ clientId: z.string().trim().min(8).max(64), secret: z.string().min(16).max(200) });
export type MachineTokenRequest = z.infer<typeof MachineTokenRequest>;
export const MachineTokenResponse = z.object({ token: z.string(), expiresAt: Instant });
export type MachineTokenResponse = z.infer<typeof MachineTokenResponse>;

/** GET /api/accounts/tally/outbox — approved batches waiting to be posted to Tally (not on hold). */
export const OutboxBatch = z.object({
  publicId: PublicId, company: z.string(), tallyCompanyName: z.string(), xml: z.string(),
  entries: z.array(z.object({ entryPublicId: PublicId })),
  /** Every Tally ledger name approved for this company, and the cost centre names it uses (none yet). The connector checks them against Tally. */
  expectedLedgers: z.array(z.string()), expectedCostCentres: z.array(z.string()),
});
export type OutboxBatch = z.infer<typeof OutboxBatch>;
export const Outbox = z.object({ batches: z.array(OutboxBatch) });
export type Outbox = z.infer<typeof Outbox>;

/**
 * POST /api/accounts/tally/results — what happened to one batch.
 *   completed  Tally answered; created/altered/errors/lastVchId/lineErrors are what it said.
 *   not_posted Nothing reached Tally (not running, company not open, ledger names missing). The batch stays in the outbox to try again.
 *   in_doubt   The request may have reached Tally but no answer came. The batch is put on hold: a person checks Tally, then records the result.
 */
export const TallyResultReport = z.object({
  batchPublicId: PublicId,
  outcome: z.enum(['completed', 'not_posted', 'in_doubt']),
  created: z.number().int().min(0).nullable().default(null),
  altered: z.number().int().min(0).nullable().default(null),
  errors: z.number().int().min(0).nullable().default(null),
  lastVchId: z.string().max(100).nullable().default(null),
  lineErrors: z.array(z.string().max(1000)).max(1000).default([]),
  message: z.string().max(500).nullable().default(null),
});
export type TallyResultReport = z.infer<typeof TallyResultReport>;
export const TallyResultAck = z.object({
  state: TallyBatchState, onHold: z.boolean(), entriesCreated: z.number().int(), entriesReturned: z.number().int(),
  /** Why a person has to decide (the result did not say which entries failed). */
  message: z.string().nullable(),
});
export type TallyResultAck = z.infer<typeof TallyResultAck>;

/** POST /api/accounts/tally/mapping-report — names the ledger map expects that Tally does not have exactly (spelling, case and spaces count). */
export const TallyMappingReport = z.object({
  tallyCompanyName: z.string().min(1).max(120),
  ledgersChecked: z.number().int().min(0), costCentresChecked: z.number().int().min(0),
  missingLedgers: z.array(z.string().max(200)).max(1000), missingCostCentres: z.array(z.string().max(200)).max(1000),
});
export type TallyMappingReport = z.infer<typeof TallyMappingReport>;
export const TallyMappingAck = z.object({ ok: z.boolean() });
export type TallyMappingAck = z.infer<typeof TallyMappingAck>;
