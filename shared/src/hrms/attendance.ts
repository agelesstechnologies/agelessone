import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from '../common';
/** Attendance: answers and queries shared by the API and the web app. Times are UTC ISO; dates are IST work dates. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
/** Date ranges: `to` not before `from`, and at most 93 days (about a quarter) at a time. */
type Range = { from: string; to: string };
type Check = [(q: Range) => boolean, { message: string; path: string[] }];
const inOrder: Check = [(q) => q.to >= q.from, { message: '`to` is before `from`', path: ['to'] }];
const notTooLong: Check = [(q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92, { message: 'At most 93 days at a time', path: ['to'] }];
const Job = z.object({ publicId: PublicId, company: z.string() });
const JobWithCode = Job.extend({ employeeCode: z.string() });

/** Stored status, plus 'working' for today while the person is still punched in. */
export const DayStatus = z.enum(['present', 'half_day', 'absent', 'leave', 'holiday', 'weekly_off', 'missed_punch', 'working']);
export type DayStatus = z.infer<typeof DayStatus>;

/**
 * Something the app should ask about after a punch, never a refusal — e.g. TICKETS_DAILY_UPDATE_MISSING at punch-out:
 * today's tickets without a daily update (items: the tickets).
 */
export const PunchNotice = z.object({
  code: z.string(), message: z.string(), items: z.array(z.object({ publicId: PublicId, label: z.string() })),
});
export type PunchNotice = z.infer<typeof PunchNotice>;

export const Punch = z.object({
  publicId: PublicId, kind: z.enum(['in', 'out']), occurredAt: Instant, receivedAt: Instant,
  employment: Job, locationStatus: z.string().nullable(),
  /** only on the answer to a new punch, when there is something to ask */
  notices: z.array(PunchNotice).optional(),
});
export type Punch = z.infer<typeof Punch>;

/** GET /api/hrms/attendance/today */
export const TodayAttendance = z.object({
  date: DateOnly,
  punchedIn: z.boolean(),
  since: Instant.nullable(),                     // time of the open punch-in
  employment: Job.nullable(),                    // the job punched in on
  workedMinutes: z.number().int(),               // today, all jobs, counting the open punch up to now
  lastMissedPunchDate: DateOnly.nullable(),      // latest earlier day still a missed punch with no open correction
});
export type TodayAttendance = z.infer<typeof TodayAttendance>;

export const WorkDayRow = z.object({
  date: DateOnly,
  employment: JobWithCode,
  firstIn: Instant.nullable(), lastOut: Instant.nullable(),
  workedMinutes: z.number().int(),
  extraMinutes: z.number().int(),                // worked beyond the full-day setting — not overtime by itself
  approvedOvertimeMinutes: z.number().int(),     // approved overtime requests, at most extraMinutes
  status: DayStatus, locked: z.boolean(), running: z.boolean(), // running: today, still punched in (minutes up to now)
  leaveDays: z.number(), absentDays: z.number(), // each 0, 0.5 or 1
  workedOnLeave: z.boolean(),                    // worked on a day of approved leave
});
export type WorkDayRow = z.infer<typeof WorkDayRow>;

/** A punch as history shows it. corrected: an approved correction left it out of the day (it is still stored). */
export const HistoryPunch = z.object({ publicId: PublicId, kind: z.enum(['in', 'out']), occurredAt: Instant, source: z.string(), corrected: z.boolean() });
export type HistoryPunch = z.infer<typeof HistoryPunch>;
/** A history row: the day plus every punch of that job on that date, in time order. */
export const HistoryRow = WorkDayRow.extend({ punches: z.array(HistoryPunch) });
export type HistoryRow = z.infer<typeof HistoryRow>;

/** GET /api/hrms/attendance/history?from=&to= — your own days, newest first. */
export const AttendanceHistoryQuery = z.object({ from: isoDate, to: isoDate }).refine(...inOrder).refine(...notTooLong);
export type AttendanceHistoryQuery = z.infer<typeof AttendanceHistoryQuery>;

/** GET /api/hrms/attendance/register?date=&company= */
export const AttendanceRegisterQuery = z.object({ date: isoDate, company: emptyToUndefined(z.string().trim().max(12)) });
export type AttendanceRegisterQuery = z.infer<typeof AttendanceRegisterQuery>;
export const AttendanceRegister = z.object({
  date: DateOnly, company: z.string().nullable(),
  rows: z.array(WorkDayRow.omit({ date: true }).extend({ person: PersonRef })),
  summary: z.record(DayStatus, z.number().int()),  // rows per status
  totals: z.object({ leaveDays: z.number(), absentDays: z.number() }),
});
export type AttendanceRegister = z.infer<typeof AttendanceRegister>;

/** GET /api/hrms/attendance/work-hours?company=&from=&to= */
export const WorkHoursQuery = z.object({
  company: emptyToUndefined(z.string().trim().max(12)), from: isoDate, to: isoDate,
  format: z.enum(['json', 'csv']).default('json'),
})
  .refine(...inOrder).refine(...notTooLong);
export type WorkHoursQuery = z.infer<typeof WorkHoursQuery>;
export const WorkHours = z.object({
  company: z.string().nullable(), from: DateOnly, to: DateOnly, producedAt: Instant,
  rows: z.array(z.object({
    person: PersonRef,
    employment: JobWithCode,
    days: z.object({ present: z.number().int(), halfDay: z.number().int(), missedPunch: z.number().int(), absent: z.number().int(), leave: z.number().int() }),
    leaveDays: z.number(),   // full and half days of approved leave
    absentDays: z.number(),  // absences, including past working days with no punches at all
    workedMinutes: z.number().int(), extraMinutes: z.number().int(), approvedOvertimeMinutes: z.number().int(),
    overtimePayable: z.boolean(), // the company's hrms.overtime.payable policy on the last date
  })),
});
export type WorkHours = z.infer<typeof WorkHours>;

/** POST /api/hrms/attendance/rebuild — one job, or every job of one person, over a date range. */
export const RebuildWorkDaysRequest = z.object({
  employmentPublicId: z.string().uuid().optional(),
  personPublicId: z.string().uuid().optional(),
  from: isoDate, to: isoDate,
}).refine(...inOrder).refine(...notTooLong).refine((r) => (r.employmentPublicId === undefined) !== (r.personPublicId === undefined), { message: 'Give employmentPublicId or personPublicId', path: ['employmentPublicId'] });
export type RebuildWorkDaysRequest = z.infer<typeof RebuildWorkDaysRequest>;
export const RebuildResult = z.object({ rebuilt: z.number().int(), skippedLocked: z.number().int() });
export type RebuildResult = z.infer<typeof RebuildResult>;
