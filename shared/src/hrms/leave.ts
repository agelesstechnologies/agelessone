import { z } from 'zod';
import { DateOnly, DecidedAs, Instant, PersonRef, PublicId } from '../common';
/** Leave: requests and answers shared by the API and the web app. Dates are IST; days come in steps of 0.5. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const reason = z.string().trim().min(3).max(500);

export const LeaveStatus = z.enum(['draft', 'submitted', 'approved', 'rejected', 'cancelled']);
export type LeaveStatus = z.infer<typeof LeaveStatus>;

export const LeaveType = z.object({ code: z.string(), name: z.string(), isPaid: z.boolean() });
export type LeaveType = z.infer<typeof LeaveType>;
const CodeName = z.object({ code: z.string(), name: z.string() });
const Job = z.object({ publicId: PublicId, company: z.string() });

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

export const LeaveRequestView = z.object({
  publicId: PublicId,
  person: PersonRef,
  employment: Job.extend({ employeeCode: z.string() }),
  leaveType: CodeName,
  fromDate: DateOnly, toDate: DateOnly,
  fromHalf: z.enum(['full', 'second_half']), toHalf: z.enum(['full', 'first_half']),
  days: z.number(),
  reason: z.string().nullable(),
  status: LeaveStatus,
  approver: PersonRef.nullable(),  // manager, department head, HR, then CEO; null only when nobody is left
  decidedBy: PersonRef.nullable(),   // null when decidedAs is no_approval_required
  decidedAs: DecidedAs.nullable(),
  decidedAt: Instant.nullable(),
  decisionReason: z.string().nullable(),
  cancelledAt: Instant.nullable(),
  createdAt: Instant,
});
export type LeaveRequestView = z.infer<typeof LeaveRequestView>;

/** GET /api/hrms/leave/balances/mine — one row per job and leave type; balance = sum of the ledger. */
export const LeaveBalance = z.object({ employment: Job, leaveType: CodeName, balance: z.number() });
export type LeaveBalance = z.infer<typeof LeaveBalance>;

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

export const LeaveLedgerEntry = z.object({
  publicId: PublicId, employment: Job, leaveType: CodeName,
  year: z.number().int(), entry: z.enum(['opening', 'grant', 'taken', 'taken_reversal', 'adjustment']), days: z.number(),
  reason: z.string().nullable(), postedAt: Instant,
});
export type LeaveLedgerEntry = z.infer<typeof LeaveLedgerEntry>;

/** GET /api/hrms/leave/report?company=&from=&to= — submitted and approved leave that touches the dates. */
export const LeaveReportQuery = z.object({
  company: emptyToUndefined(z.string().trim().max(12)), from: isoDate, to: isoDate,
  format: z.enum(['json', 'csv']).default('json'), // csv: one line per person, job and leave type
})
  .refine((q) => q.to >= q.from, { message: '`to` is before `from`', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 365, { message: 'At most 366 days at a time', path: ['to'] });
export type LeaveReportQuery = z.infer<typeof LeaveReportQuery>;
export const LeaveReport = z.object({
  company: z.string().nullable(), from: DateOnly, to: DateOnly, producedAt: Instant,
  rows: z.array(LeaveRequestView),
  /** per person and company: approved leave days inside the period by type, and the current balance by type */
  people: z.array(z.object({
    person: PersonRef,
    employment: Job.extend({ employeeCode: z.string() }),
    takenByType: z.record(z.string(), z.number()), balanceByType: z.record(z.string(), z.number()), totalTaken: z.number(),
  })),
  /** approved days per leave type, whole requests (a request crossing the range counts in full) */
  approvedDaysByType: z.array(z.object({ code: z.string(), days: z.number() })),
});
export type LeaveReport = z.infer<typeof LeaveReport>;
