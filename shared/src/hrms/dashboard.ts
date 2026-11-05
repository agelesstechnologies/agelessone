import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from '../common';
/** The approvals inbox and the HRMS dashboard: answers shared by the API and the web app. */

const Count = z.number().int();
const Paise = z.number().int();

// ---------------- GET /api/hrms/approvals/mine ----------------

export const ApprovalType = z.enum(['leave', 'expense', 'correction', 'overtime']);
export type ApprovalType = z.infer<typeof ApprovalType>;

/** One request waiting for the caller's decision. Dates for leave, corrections and overtime; an amount for expenses. */
export const ApprovalItem = z.object({
  type: ApprovalType,
  publicId: PublicId,
  person: PersonRef,
  company: z.string(),
  fromDate: DateOnly.nullable(),  // leave: first day; correction / overtime: the work date; expense: the date spent
  toDate: DateOnly.nullable(),    // leave: last day; otherwise the same as fromDate
  amountPaise: Paise.nullable(),  // expenses only
  currency: z.string().nullable(),
  summary: z.string(),            // e.g. "Casual leave, 2 days" or "Overtime 90 min"
  submittedAt: Instant,
  ageDays: Count,                 // whole days waiting (IST)
});
export type ApprovalItem = z.infer<typeof ApprovalItem>;

/** Counts per type; null for a kind of request whose module is not built yet (ticket reassignments). */
export const ApprovalCounts = z.object({
  leave: Count, expense: Count, correction: Count, overtime: Count,
  ticketReassignment: Count.nullable(),
  total: Count,
});
export type ApprovalCounts = z.infer<typeof ApprovalCounts>;

export const ApprovalsInbox = z.object({ asOf: Instant, counts: ApprovalCounts, items: z.array(ApprovalItem) });
export type ApprovalsInbox = z.infer<typeof ApprovalsInbox>;

// ---------------- GET /api/hrms/dashboard ----------------

/** company: all (every company the caller may see) or one company code; month: YYYY-MM (default: this month, IST). */
export const DashboardQuery = z.object({
  company: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(1).max(20).default('all')),
  month: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM').optional()),
});
export type DashboardQuery = z.infer<typeof DashboardQuery>;

const DaySplit = z.object({
  present: Count, halfDay: Count, missedPunch: Count, absent: Count, leave: Count, holiday: Count, weeklyOff: Count,
});
export type DaySplit = z.infer<typeof DaySplit>;

const MonthFigures = z.object({
  month: z.string(), from: DateOnly, to: DateOnly,      // to: the last day counted (today for the current month)
  employees: Count,                                     // people with a job in the period
  presentDays: z.number(), absentDays: z.number(), leaveDays: z.number(), // present counts a half day as 0.5
  attendancePercent: z.number().nullable(),             // attended / working days (leave not counted); null without working days
  workedMinutes: Count, approvedOvertimeMinutes: Count,
});

export const Dashboard = z.object({
  asOf: Instant,
  month: z.string(),
  scope: z.object({
    visibility: z.enum(['team', 'all']),   // team: you and the people you manage; all: everyone (HR, Management)
    company: z.string(),                   // what was asked: all or a company code
    companies: z.array(z.string()),        // the companies counted
  }),
  /** Figures for things not available yet (or not to this caller) are null, never 0. */
  totals: z.object({
    employees: Count,                      // people with a current job (joining, active or notice)
    active: Count,                         // people with an active job
    joinersThisMonth: Count,               // jobs that start in the month
    onProbation: Count,                    // current jobs with engagement type probation
    onLeaveToday: Count,                   // approved leave covering today
    openPositions: Count.nullable(),       // null for team visibility (positions belong to the company)
    certificatesExpiringIn30Days: Count,   // still valid, expiring within 30 days
    pendingExpenses: z.array(z.object({ currency: z.string(), awaitingApprovalPaise: Paise, awaitingPaymentPaise: Paise })),
    openTickets: Count.nullable(),         // service tickets: not built yet
    documentsExpiring: Count.nullable(),   // documents: not built yet
  }),
  attendance: z.object({
    from: DateOnly, to: DateOnly,          // to: the last day counted (today at most)
    split: DaySplit,                       // job-days in the month so far
    daily: z.array(DaySplit.extend({ date: DateOnly })),
  }),
  leave: z.object({
    submitted: Count,                      // requests waiting for a decision that touch the month
    approved: Count,                       // approved requests that touch the month
    leaveDays: z.number(),                 // approved leave days in the month (half days count 0.5)
    byType: z.array(z.object({ code: z.string(), name: z.string(), requests: Count })),
  }),
  departments: z.array(z.object({
    company: z.string(), code: z.string().nullable(), name: z.string(), // code null: people without a department
    headcount: Count, attendancePercent: z.number().nullable(),
  })),
  myApprovals: ApprovalCounts,
  recentActivity: z.array(z.object({
    at: Instant, action: z.string(), summary: z.string(), actor: PersonRef.nullable(), company: z.string().nullable(),
  })),
  comparison: z.object({ thisMonth: MonthFigures, lastMonth: MonthFigures }),
});
export type Dashboard = z.infer<typeof Dashboard>;
