import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from './common';
import { TicketStatus } from './ticket-records';
/**
 * Ticket reports and dashboard numbers. Time is always the allocated time (shared per work day, plus heads'
 * adjustments), never raw overlapping timer time. Every report says its period, company and when it was produced,
 * and answers CSV with format=csv. Department heads see their departments; HR, admin user and Management see all.
 */

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const company = z.string().trim().min(1).max(12);
const format = z.enum(['json', 'csv']).default('json');
const MAX_DAYS = 366;
const Period = z.object({ from: isoDate, to: isoDate, company: emptyToUndefined(company), format });
type Range = { from: string; to: string };
/** from on or before to, at most MAX_DAYS days. */
const fromBeforeTo = (q: Range) => q.from <= q.to;
const FROM_BEFORE_TO = { message: 'from must be on or before to', path: ['to'] };
const notTooLong = (q: Range) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_DAYS;
const NOT_TOO_LONG = { message: `At most ${MAX_DAYS} days`, path: ['to'] };

/** What every report says about itself. */
const About = { report: z.string(), company: z.string().nullable(), from: DateOnly, to: DateOnly, producedAt: Instant };
const TicketRef = z.object({ publicId: PublicId, number: z.string(), title: z.string() });
const Ref = z.object({ publicId: PublicId, name: z.string() });

export const HoursBy = z.enum(['ticket', 'type', 'person', 'department', 'customer']);
export type HoursBy = z.infer<typeof HoursBy>;
/** GET /api/tickets/reports/hours?from=&to=&by=&company=&format= */
export const HoursQuery = Period.extend({ by: HoursBy.default('ticket') }).refine(fromBeforeTo, FROM_BEFORE_TO).refine(notTooLong, NOT_TOO_LONG);
export type HoursQuery = z.infer<typeof HoursQuery>;
export const HoursReport = z.object({
  ...About, by: HoursBy,
  /** key: the ticket / type / person / department publicId, or null (customer names; "(no customer)") */
  rows: z.array(z.object({ key: PublicId.nullable(), label: z.string(), minutes: z.number().int(), hours: z.number() })),
  totals: z.object({ minutes: z.number().int(), hours: z.number() }),
});
export type HoursReport = z.infer<typeof HoursReport>;

/** GET /api/tickets/reports/utilisation?from=&to=&company=&format= — utilisation and unallocated time per person. */
export const UtilisationQuery = Period.refine(fromBeforeTo, FROM_BEFORE_TO).refine(notTooLong, NOT_TOO_LONG);
export type UtilisationQuery = z.infer<typeof UtilisationQuery>;
const PersonTime = {
  attendanceMinutes: z.number().int(), ticketMinutes: z.number().int(),
  /** attendance minus ticket time (information only) */
  unallocatedMinutes: z.number().int(),
  /** ticket / attendance × 100, one decimal; null without attendance */
  utilisationPercent: z.number().nullable(),
};
export const UtilisationReport = z.object({
  ...About, rows: z.array(z.object({ person: PersonRef, ...PersonTime })), totals: z.object(PersonTime),
});
export type UtilisationReport = z.infer<typeof UtilisationReport>;

/** GET /api/tickets/reports/overdue?company=&format= and /on-hold — as of today (from = to = today). */
export const AsOfQuery = z.object({ company: emptyToUndefined(company), format });
export type AsOfQuery = z.infer<typeof AsOfQuery>;
const TicketLine = {
  ticket: TicketRef, company: z.string(), type: z.object({ code: z.string(), name: z.string() }), status: TicketStatus, priority: z.number().int(),
  department: Ref, supervisor: PersonRef, primaryAssignee: PersonRef.nullable(), dueDate: DateOnly.nullable(),
};
export const OverdueReport = z.object({
  ...About, rows: z.array(z.object({ ...TicketLine, daysOverdue: z.number().int() })), totals: z.object({ tickets: z.number().int() }),
});
export type OverdueReport = z.infer<typeof OverdueReport>;
export const OnHoldReport = z.object({
  ...About, rows: z.array(z.object({ ...TicketLine, holdReason: z.string(), heldSince: Instant.nullable() })), totals: z.object({ tickets: z.number().int() }),
});
export type OnHoldReport = z.infer<typeof OnHoldReport>;

/** GET /api/tickets/reports/weekly?from=&to=&company=&format= — weeks start on Monday (IST). */
export const WeeklyQuery = Period.refine(fromBeforeTo, FROM_BEFORE_TO).refine(notTooLong, NOT_TOO_LONG);
export type WeeklyQuery = z.infer<typeof WeeklyQuery>;
export const WeeklyReport = z.object({
  ...About,
  rows: z.array(z.object({ weekStart: DateOnly, type: z.object({ code: z.string(), name: z.string() }), created: z.number().int(), completed: z.number().int() })),
  totals: z.object({ created: z.number().int(), completed: z.number().int() }),
});
export type WeeklyReport = z.infer<typeof WeeklyReport>;

/** GET /api/tickets/reports/missing-updates?from=&to=&company=&format= — ticket-days with a timer but no daily update. */
export const MissingUpdatesReportQuery = Period.refine(fromBeforeTo, FROM_BEFORE_TO).refine(notTooLong, NOT_TOO_LONG);
export type MissingUpdatesReportQuery = z.infer<typeof MissingUpdatesReportQuery>;
export const MissingUpdatesReport = z.object({
  ...About,
  rows: z.array(z.object({ person: PersonRef, missingUpdates: z.number().int(), tickets: z.number().int(), minutes: z.number().int() })),
  totals: z.object({ missingUpdates: z.number().int(), minutes: z.number().int() }),
});
export type MissingUpdatesReport = z.infer<typeof MissingUpdatesReport>;

/** GET /api/tickets/dashboard?company= — numbers for the CEO dashboard (IST months). */
/** company: one company code (default: all the caller may see); month: YYYY-MM (default: this month, IST). */
export const TicketDashboardQuery = z.object({
  company: emptyToUndefined(company),
  month: emptyToUndefined(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')),
});
export type TicketDashboardQuery = z.infer<typeof TicketDashboardQuery>;
const Count = z.number().int();
/** Time to complete: hours from created to completed (calendar time), and allocated minutes worked. null when none completed. */
const CompletionFigures = {
  completed: Count,
  avgHours: z.number().nullable(), medianHours: z.number().nullable(), avgWorkedMinutes: z.number().int().nullable(),
};
export const TicketDashboard = z.object({
  company: z.string().nullable(), producedAt: Instant, month: z.string(), lastMonth: z.string(),
  open: Count,
  openByType: z.array(z.object({ type: z.object({ code: z.string(), name: z.string() }), count: Count })),
  openByPriority: z.array(z.object({ priority: z.number().int(), count: Count })),
  openByTypeAndPriority: z.array(z.object({ type: z.object({ code: z.string(), name: z.string() }), priority: z.number().int(), count: Count })),
  overdue: Count, completedThisMonth: Count, completedLastMonth: Count,
  /** Tickets completed in the month (IST): how long they took, overall and per type. */
  completion: z.object({
    ...CompletionFigures,
    byType: z.array(z.object({ type: z.object({ code: z.string(), name: z.string() }), ...CompletionFigures })),
  }),
  /** The oldest unfinished tickets (up to 10), oldest first. */
  oldestOpen: z.array(z.object({
    ticket: TicketRef, type: z.object({ code: z.string(), name: z.string() }), status: TicketStatus, priority: z.number().int(),
    dueDate: DateOnly.nullable(), ageDays: Count, overdue: z.boolean(),
  })),
});
export type TicketDashboard = z.infer<typeof TicketDashboard>;
