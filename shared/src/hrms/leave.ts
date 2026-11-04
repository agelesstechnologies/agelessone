import { z } from 'zod';
/** Leave: requests and answers shared by the API and the web app. Dates are IST; days come in steps of 0.5. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const reason = z.string().trim().min(3).max(500);

export const LeaveStatus = z.enum(['draft', 'submitted', 'approved', 'rejected', 'cancelled']);
export type LeaveStatus = z.infer<typeof LeaveStatus>;

export interface LeaveType { code: string; name: string; isPaid: boolean }

/**
 * POST /api/hrms/leave/requests — leave on one of your own jobs. fromHalf 'second_half' starts at midday on the first day;
 * toHalf 'first_half' ends at midday on the last day. Sending the same publicId again returns the stored request.
 */
export const ApplyLeaveRequest = z.object({
  publicId: z.string().uuid().optional(),
  employmentPublicId: z.string().uuid(),
  leaveTypeCode: z.string().trim().min(1).max(20),
  fromDate: isoDate,
  toDate: isoDate,
  fromHalf: z.enum(['full', 'second_half']).default('full'),
  toHalf: z.enum(['full', 'first_half']).default('full'),
  reason: reason.optional(),
}).refine((r) => r.toDate >= r.fromDate, { message: '`toDate` is before `fromDate`', path: ['toDate'] })
  .refine((r) => (Date.parse(r.toDate) - Date.parse(r.fromDate)) / 86_400_000 <= 365, { message: 'At most 366 days at a time', path: ['toDate'] })
  .refine((r) => !(r.fromDate === r.toDate && r.fromHalf === 'second_half' && r.toHalf === 'first_half'),
    { message: 'A single day cannot run from the second half to the first half', path: ['toHalf'] });
export type ApplyLeaveRequest = z.infer<typeof ApplyLeaveRequest>;

/** GET /api/hrms/leave/requests/mine */
export const MyLeaveQuery = z.object({ status: emptyToUndefined(LeaveStatus) });
export type MyLeaveQuery = z.infer<typeof MyLeaveQuery>;

/** POST /api/hrms/leave/requests/:publicId/reject */
export const RejectLeaveRequest = z.object({ reason });
export type RejectLeaveRequest = z.infer<typeof RejectLeaveRequest>;

/** POST /api/hrms/leave/requests/:publicId/cancel */
export const CancelLeaveRequest = z.object({ reason: reason.optional() });
export type CancelLeaveRequest = z.infer<typeof CancelLeaveRequest>;

export interface LeaveRequestView {
  publicId: string;
  person: { publicId: string; displayName: string };
  employment: { publicId: string; company: string; employeeCode: string };
  leaveType: { code: string; name: string };
  fromDate: string; toDate: string;
  fromHalf: 'full' | 'second_half'; toHalf: 'full' | 'first_half';
  days: number;
  reason: string | null;
  status: LeaveStatus;
  approver: { publicId: string; displayName: string } | null;  // null: HR decides (no manager on the job)
  decidedBy: { publicId: string; displayName: string } | null;
  decidedAt: string | null;
  decisionReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/** GET /api/hrms/leave/balances/mine — one row per job and leave type; balance = sum of the ledger. */
export interface LeaveBalance {
  employment: { publicId: string; company: string };
  leaveType: { code: string; name: string };
  balance: number;
}

/** POST /api/hrms/leave/ledger/adjustments — HR: an opening balance (one per job, type and year) or an adjustment (+/-). */
export const LeaveAdjustmentRequest = z.object({
  publicId: z.string().uuid().optional(),
  employmentPublicId: z.string().uuid(),
  leaveTypeCode: z.string().trim().min(1).max(20),
  year: z.number().int().min(2000).max(2100),
  entry: z.enum(['opening', 'adjustment']),
  days: z.number().refine((d) => d !== 0 && Number.isInteger(d * 2), 'Whole or half days, not zero').refine((d) => Math.abs(d) <= 999, 'At most 999 days'),
  reason,
}).refine((r) => r.entry !== 'opening' || r.days > 0, { message: 'An opening balance is more than zero', path: ['days'] });
export type LeaveAdjustmentRequest = z.infer<typeof LeaveAdjustmentRequest>;

export interface LeaveLedgerEntry {
  publicId: string; employment: { publicId: string; company: string }; leaveType: { code: string; name: string };
  year: number; entry: 'opening' | 'grant' | 'taken' | 'taken_reversal' | 'adjustment'; days: number; reason: string | null; postedAt: string;
}

/** GET /api/hrms/leave/report?company=&from=&to= — submitted and approved leave that touches the dates. */
export const LeaveReportQuery = z.object({ company: emptyToUndefined(z.string().trim().max(12)), from: isoDate, to: isoDate })
  .refine((q) => q.to >= q.from, { message: '`to` is before `from`', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 365, { message: 'At most 366 days at a time', path: ['to'] });
export type LeaveReportQuery = z.infer<typeof LeaveReportQuery>;
export interface LeaveReport {
  company: string | null; from: string; to: string;
  rows: LeaveRequestView[];
  /** approved days per leave type, whole requests (a request crossing the range counts in full) */
  approvedDaysByType: { code: string; days: number }[];
}
