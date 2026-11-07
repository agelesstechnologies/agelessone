import { z } from 'zod';
import { DateOnly, DecidedAs, Escalation, Instant, PersonRef, PublicId } from '../common';
/** Attendance corrections: requests and answers shared by the API and the web app. Times are ISO with offset; dates IST. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const instant = z.string().datetime({ offset: true });

export const CorrectionKind = z.enum(['missed_out', 'missed_in', 'wrong_time', 'other']);
export type CorrectionKind = z.infer<typeof CorrectionKind>;
export const CorrectionStatus = z.enum(['submitted', 'approved', 'rejected', 'cancelled']);
export type CorrectionStatus = z.infer<typeof CorrectionStatus>;

/**
 * POST /api/hrms/attendance/corrections — fix one job's day: your own, or (as their manager) a team member's.
 * missed_out needs requestedOut; missed_in needs requestedIn; wrong_time names the wrong punches and the right time(s).
 * Approval adds punches at requestedIn / requestedOut and leaves out punchIdsToExclude; nothing is deleted or edited.
 */
export const CreateCorrectionRequest = z.object({
  publicId: z.string().uuid().optional(),
  employmentPublicId: z.string().uuid(),
  workDate: isoDate,
  kind: CorrectionKind,
  requestedIn: instant.optional(),
  requestedOut: instant.optional(),
  punchIdsToExclude: z.array(z.string().uuid()).max(20).default([]),
  reason: z.string().trim().min(10, 'Say in at least 10 characters what happened').max(500),
}).superRefine((r, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (r.kind === 'missed_out' && !r.requestedOut) issue('requestedOut', 'A missed punch-out needs requestedOut');
  if (r.kind === 'missed_in' && !r.requestedIn) issue('requestedIn', 'A missed punch-in needs requestedIn');
  if (r.kind === 'wrong_time' && r.punchIdsToExclude.length === 0) issue('punchIdsToExclude', 'Name the wrong punch(es)');
  if (r.kind === 'wrong_time' && !r.requestedIn && !r.requestedOut) issue('requestedIn', 'Give the right time');
  if (!r.requestedIn && !r.requestedOut && r.punchIdsToExclude.length === 0) issue('requestedIn', 'Nothing to correct');
  if (r.requestedIn && r.requestedOut && Date.parse(r.requestedIn) >= Date.parse(r.requestedOut)) issue('requestedOut', '`requestedOut` must be after `requestedIn`');
});
export type CreateCorrectionRequest = z.infer<typeof CreateCorrectionRequest>;

/** GET /api/hrms/attendance/corrections/mine — about you, or filed by you. */
export const MyCorrectionsQuery = z.object({ status: emptyToUndefined(CorrectionStatus) });
export type MyCorrectionsQuery = z.infer<typeof MyCorrectionsQuery>;

/** POST /api/hrms/attendance/corrections/:publicId/reject */
export const RejectCorrectionRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export type RejectCorrectionRequest = z.infer<typeof RejectCorrectionRequest>;

export const Correction = z.object({
  publicId: PublicId,
  person: PersonRef,
  employment: z.object({ publicId: PublicId, company: z.string() }),
  workDate: DateOnly,
  kind: CorrectionKind,
  requestedIn: Instant.nullable(), requestedOut: Instant.nullable(),
  punchIdsToExclude: z.array(PublicId),
  reason: z.string(),
  status: CorrectionStatus,
  requestedBy: PersonRef,
  approver: PersonRef.nullable(),
  decidedBy: PersonRef.nullable(),   // null when decidedAs is no_approval_required
  decidedAs: DecidedAs.nullable(),
  decidedAt: Instant.nullable(), decisionReason: z.string().nullable(),
  escalation: Escalation.nullable(),  // sent to the CEO (forwarded or waited too long)
  cancelledAt: Instant.nullable(), createdAt: Instant,
});
export type Correction = z.infer<typeof Correction>;
