import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from './common';
import { TicketStatus } from './ticket-records';
import { PunchConfirmation } from './hrms/attendance';
/** Ticket time: ticket punch in / out, shared time per work day, the head's adjustments, daily updates. */

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const deviceTime = z.string().datetime({ offset: true });

/** POST /api/tickets/punch-in — start a timer on each ticket, all in one go (several may run at once). */
export const TicketPunchInRequest = z.object({
  /** device time (default: now) */
  occurredAt: deviceTime.optional(),
  items: z.array(z.object({
    /** made on the device, so a resend is stored once */
    publicId: z.string().uuid(),
    ticketPublicId: z.string().uuid(),
  })).min(1).max(20).refine((i) => new Set(i.map((x) => x.ticketPublicId)).size === i.length, 'Each ticket once'),
  /** where the person is (one place for all the tickets); the address is looked up for the confirmation */
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().int().nonnegative().optional(),
}).refine((p) => (p.latitude === undefined) === (p.longitude === undefined), { message: 'Send latitude and longitude together', path: ['longitude'] });
export type TicketPunchInRequest = z.infer<typeof TicketPunchInRequest>;

/** POST /api/tickets/punch-out — stop the timers of some tickets, or all of mine. */
export const TicketPunchOutRequest = z.object({
  occurredAt: deviceTime.optional(),
  tickets: z.array(z.string().uuid()).min(1).max(50).optional(),
  all: z.literal(true).optional(),
}).refine((r) => (r.tickets === undefined) !== (r.all === undefined), { message: 'Send either tickets or all: true' });
export type TicketPunchOutRequest = z.infer<typeof TicketPunchOutRequest>;

const TicketRef = z.object({ publicId: PublicId, number: z.string(), title: z.string() });
export const EndReason = z.enum(['manual', 'day_punch_out', 'unfinished']);

export const RunningTicket = z.object({
  timelogPublicId: PublicId, ticket: TicketRef.extend({ status: TicketStatus }), startedAt: Instant,
});
export type RunningTicket = z.infer<typeof RunningTicket>;
/** The answer to ticket punch in / out: how many timers changed, and what runs now. */
export const TicketPunchConfirmation = PunchConfirmation.extend({
  /** the tickets of this punch-in: number, customer (from the type's customer field) and description */
  tickets: z.array(z.object({ publicId: PublicId, number: z.string(), customer: z.string().nullable(), description: z.string().nullable() })),
});
export type TicketPunchConfirmation = z.infer<typeof TicketPunchConfirmation>;
export const TicketPunchResult = z.object({
  started: z.number().int(), stopped: z.number().int(), running: z.array(RunningTicket),
  /** on punch-in only */
  confirmation: TicketPunchConfirmation.optional(),
});
export type TicketPunchResult = z.infer<typeof TicketPunchResult>;

// ---- daily updates ----

/** POST /api/tickets/:id/updates — JSON, or multipart with up to 5 photos / files in the field `files`. */
export const DailyUpdateRequest = z.object({
  publicId: emptyToUndefined(z.string().uuid()),
  note: z.string().trim().min(3).max(1000),
  percentComplete: z.coerce.number().int().min(0).max(100),
  /** IST date (default today) */
  workDate: emptyToUndefined(isoDate),
});
export type DailyUpdateRequest = z.infer<typeof DailyUpdateRequest>;

export const DailyUpdate = z.object({
  publicId: PublicId, workDate: DateOnly, person: PersonRef, note: z.string(), percentComplete: z.number().int(),
  attachments: z.array(z.object({ publicId: PublicId, kind: z.string(), fileType: z.string() })), createdAt: Instant,
});
export type DailyUpdate = z.infer<typeof DailyUpdate>;

/** GET /api/tickets/daily-updates/missing?date= — default yesterday (IST). */
export const MissingUpdatesQuery = z.object({ date: emptyToUndefined(isoDate) });
export type MissingUpdatesQuery = z.infer<typeof MissingUpdatesQuery>;
export const MissingUpdate = z.object({
  date: DateOnly, ticket: TicketRef, person: PersonRef, department: z.object({ publicId: PublicId, name: z.string() }), minutes: z.number().int(),
});
export type MissingUpdate = z.infer<typeof MissingUpdate>;

// ---- time per day ----

/** GET /api/tickets/time/allocations?person=&date= */
export const AllocationQuery = z.object({ person: z.string().uuid(), date: isoDate });
export type AllocationQuery = z.infer<typeof AllocationQuery>;

export const DayAllocation = z.object({
  person: PersonRef, date: DateOnly,
  /** the day's attended minutes (all jobs): ticket time never adds up to more */
  attendanceMinutes: z.number().int(),
  totalMinutes: z.number().int(),
  rows: z.array(z.object({ ticket: TicketRef, calculatedMinutes: z.number().int(), adjustedMinutes: z.number().int(), minutes: z.number().int() })),
  adjustments: z.array(z.object({
    batchId: PublicId, ticket: TicketRef, minutes: z.number().int(), reason: z.string(), adjustedBy: PersonRef,
    adjustedAs: z.enum(['head', 'management']), at: Instant,
  })),
  timelogs: z.array(z.object({ publicId: PublicId, ticket: TicketRef, startedAt: Instant, endedAt: Instant.nullable(), endReason: EndReason.nullable() })),
});
export type DayAllocation = z.infer<typeof DayAllocation>;

/**
 * POST /api/tickets/time/adjustments — move a person's minutes between tickets on one day (+ adds, - takes away).
 * Each ticket stays at 0 or more and the day's total within the attended minutes.
 */
export const AdjustTimeRequest = z.object({
  personPublicId: z.string().uuid(),
  date: isoDate,
  reason: z.string().trim().min(3, 'Give a reason').max(500),
  changes: z.array(z.object({ ticketPublicId: z.string().uuid(), minutes: z.number().int().min(-1440).max(1440).refine((m) => m !== 0, 'Not 0') }))
    .min(1).max(20).refine((c) => new Set(c.map((x) => x.ticketPublicId)).size === c.length, 'Each ticket once'),
});
export type AdjustTimeRequest = z.infer<typeof AdjustTimeRequest>;

/** GET /api/tickets/:publicId/timelogs: everyone's ticket punches on one ticket, newest first, and the time each person has on it. */
export const TicketTimelog = z.object({
  publicId: PublicId, person: PersonRef, employeeCode: z.string(),
  startedAt: Instant, endedAt: Instant.nullable(),
  /** manual (ticket punch-out), day_punch_out (stopped by the daily punch-out), unfinished (missed punch: counts no time) */
  endReason: z.enum(['manual', 'day_punch_out', 'unfinished']).nullable(),
  /** timer length in minutes (null while running); the counted time is shared between tickets run together, see totals */
  timerMinutes: z.number().int().nullable(),
  /** the address where the ticket punch-in was made, once looked up (never coordinates) */
  address: z.string().nullable(),
});
export type TicketTimelog = z.infer<typeof TicketTimelog>;
export const TicketTimelogs = z.object({
  logs: z.array(TicketTimelog),
  /** counted (shared) minutes per person on this ticket, adjustments included */
  totals: z.array(z.object({ person: PersonRef, minutes: z.number().int() })),
  totalMinutes: z.number().int(),
});
export type TicketTimelogs = z.infer<typeof TicketTimelogs>;
