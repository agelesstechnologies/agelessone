import { z } from 'zod';
/** Pieces the API's answers share. Answers are Zod schemas too, so the OpenAPI spec and typed clients come from them. */

/** A date as the API answers it (YYYY-MM-DD; work dates are IST). */
export const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** An instant as the API answers it (UTC ISO, e.g. 2026-11-04T03:30:00.000Z). */
export const Instant = z.string().datetime();
export const PublicId = z.string().uuid();

/** A person as other records point at them. */
export const PersonRef = z.object({ publicId: PublicId, displayName: z.string() });
export type PersonRef = z.infer<typeof PersonRef>;

/**
 * How a request was decided: by its named approver, by HR, by Management (CEO), or not at all because the requester's
 * role needs no approval (policy hrms.approvals.auto_approve_roles). Set by the server only, never by a request.
 */
export const DecidedAs = z.enum(['approver', 'hr', 'management', 'no_approval_required']);
export type DecidedAs = z.infer<typeof DecidedAs>;

/**
 * A request sent to the CEO: forwarded by an approver (`by`), or automatically after waiting too long (`by` null,
 * policy hrms.approvals.escalate_after_days). The original approver may still decide it; the first decision wins.
 */
export const Escalation = z.object({ at: Instant, by: PersonRef.nullable(), reason: z.string() });
export type Escalation = z.infer<typeof Escalation>;

/** POST /api/hrms/.../:publicId/forward: send a request waiting for your decision to the CEO, with the reason. */
export const ForwardRequest = z.object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500) });
export type ForwardRequest = z.infer<typeof ForwardRequest>;

/** The answer to a create call that only returns the new record's id. */
export const CreatedId = z.object({ publicId: PublicId });
export type CreatedId = z.infer<typeof CreatedId>;

/** Every error: a stable code to act on, a message for people, and details (e.g. which fields failed validation). */
export const ErrorResponse = z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;
