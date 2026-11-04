import { z } from 'zod';
/** Overtime requests: extra time is paid as overtime only when approved. Shared by the API and the web app. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

export const OvertimeStatus = z.enum(['submitted', 'approved', 'rejected', 'cancelled']);
export type OvertimeStatus = z.infer<typeof OvertimeStatus>;

/**
 * POST /api/hrms/attendance/overtime — for your own job, or (as their manager) a team member's. A future date is
 * planned overtime. On the day, approved minutes count up to the extra time actually worked.
 */
export const CreateOvertimeRequest = z.object({
  publicId: z.string().uuid().optional(),
  employmentPublicId: z.string().uuid(),
  workDate: isoDate,
  minutes: z.number().int().min(1).max(1440),
  reason: z.string().trim().min(3).max(500),
  ticketPublicId: z.string().uuid().optional(),
});
export type CreateOvertimeRequest = z.infer<typeof CreateOvertimeRequest>;

/** GET /api/hrms/attendance/overtime/mine — about you, or filed by you. */
export const MyOvertimeQuery = z.object({ status: emptyToUndefined(OvertimeStatus) });
export type MyOvertimeQuery = z.infer<typeof MyOvertimeQuery>;

/** POST /api/hrms/attendance/overtime/:publicId/reject */
export const RejectOvertimeRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export type RejectOvertimeRequest = z.infer<typeof RejectOvertimeRequest>;

export interface OvertimeRequestView {
  publicId: string;
  person: { publicId: string; displayName: string };
  employment: { publicId: string; company: string };
  workDate: string;
  minutes: number;
  reason: string;
  ticket: { publicId: string; number: string } | null;
  status: OvertimeStatus;
  requestedBy: { publicId: string; displayName: string };
  approver: { publicId: string; displayName: string } | null;
  decidedBy: { publicId: string; displayName: string } | null;
  decidedAt: string | null; decisionReason: string | null;
  cancelledAt: string | null; createdAt: string;
}
