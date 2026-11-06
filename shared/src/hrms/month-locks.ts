import { z } from 'zod';
import { Instant, PersonRef, PublicId } from '../common';
/** Month lock: a company's month closed for payroll. Shared by the API and the web app. */

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const company = z.string().trim().min(1).max(12);

/** POST /api/hrms/month-locks — HR locks a month that has ended. */
export const LockMonthRequest = z.object({ company, year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });
export type LockMonthRequest = z.infer<typeof LockMonthRequest>;

/** POST /api/hrms/month-locks/:publicId/unlock — System Admin only, with the reason (kept). */
export const UnlockMonthRequest = z.object({ reason: z.string().trim().min(5).max(500) });
export type UnlockMonthRequest = z.infer<typeof UnlockMonthRequest>;

/** GET /api/hrms/month-locks?company=&year= — every lock, unlocked ones too (newest first). */
export const MonthLocksQuery = z.object({ company: emptyToUndefined(company), year: emptyToUndefined(z.coerce.number().int().min(2000).max(2100)) });
export type MonthLocksQuery = z.infer<typeof MonthLocksQuery>;

export const MonthLock = z.object({
  publicId: PublicId, company: z.string(), year: z.number().int(), month: z.number().int(),
  lockedBy: PersonRef, lockedAt: Instant,
  unlockedBy: PersonRef.nullable(), unlockedAt: Instant.nullable(), unlockReason: z.string().nullable(),
});
export type MonthLock = z.infer<typeof MonthLock>;
