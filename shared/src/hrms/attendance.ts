import { z } from 'zod';
/** Attendance: answers and queries shared by the API and the web app. Times are UTC ISO; dates are IST work dates. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
/** Date ranges: `to` not before `from`, and at most 93 days (about a quarter) at a time. */
type Range = { from: string; to: string };
type Check = [(q: Range) => boolean, { message: string; path: string[] }];
const inOrder: Check = [(q) => q.to >= q.from, { message: '`to` is before `from`', path: ['to'] }];
const notTooLong: Check = [(q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 92, { message: 'At most 93 days at a time', path: ['to'] }];

/** Stored status, plus 'working' for today while the person is still punched in. */
export type DayStatus = 'present' | 'half_day' | 'absent' | 'leave' | 'holiday' | 'weekly_off' | 'missed_punch' | 'working';

export interface Punch {
  publicId: string; kind: 'in' | 'out'; occurredAt: string; receivedAt: string;
  employment: { publicId: string; company: string }; locationStatus: string | null;
}

/** GET /api/hrms/attendance/today */
export interface TodayAttendance {
  date: string;
  punchedIn: boolean;
  since: string | null;                                   // time of the open punch-in
  employment: { publicId: string; company: string } | null; // the job punched in on
  workedMinutes: number;                                  // today, all jobs, counting the open punch up to now
}

export interface WorkDayRow {
  date: string;
  employment: { publicId: string; company: string; employeeCode: string };
  firstIn: string | null; lastOut: string | null;
  workedMinutes: number; overtimeMinutes: number;
  status: DayStatus; locked: boolean; running: boolean;   // running: today, still punched in (minutes up to now)
}

/** GET /api/hrms/attendance/history?from=&to= — your own days, newest first. */
export const AttendanceHistoryQuery = z.object({ from: isoDate, to: isoDate }).refine(...inOrder).refine(...notTooLong);
export type AttendanceHistoryQuery = z.infer<typeof AttendanceHistoryQuery>;

/** GET /api/hrms/attendance/register?date=&company= */
export const AttendanceRegisterQuery = z.object({ date: isoDate, company: emptyToUndefined(z.string().trim().max(12)) });
export type AttendanceRegisterQuery = z.infer<typeof AttendanceRegisterQuery>;
export interface AttendanceRegister {
  date: string; company: string | null;
  rows: (Omit<WorkDayRow, 'date'> & { person: { publicId: string; displayName: string } })[];
  summary: Partial<Record<DayStatus, number>>;
}

/** GET /api/hrms/attendance/work-hours?company=&from=&to= */
export const WorkHoursQuery = z.object({ company: emptyToUndefined(z.string().trim().max(12)), from: isoDate, to: isoDate })
  .refine(...inOrder).refine(...notTooLong);
export type WorkHoursQuery = z.infer<typeof WorkHoursQuery>;
export interface WorkHours {
  company: string | null; from: string; to: string;
  rows: {
    person: { publicId: string; displayName: string };
    employment: { publicId: string; company: string; employeeCode: string };
    days: { present: number; halfDay: number; missedPunch: number; absent: number };
    workedMinutes: number; overtimeMinutes: number;
  }[];
}

/** POST /api/hrms/attendance/rebuild — one job, or every job of one person, over a date range. */
export const RebuildWorkDaysRequest = z.object({
  employmentPublicId: z.string().uuid().optional(),
  personPublicId: z.string().uuid().optional(),
  from: isoDate, to: isoDate,
}).refine(...inOrder).refine(...notTooLong).refine((r) => (r.employmentPublicId === undefined) !== (r.personPublicId === undefined), { message: 'Give employmentPublicId or personPublicId', path: ['employmentPublicId'] });
export type RebuildWorkDaysRequest = z.infer<typeof RebuildWorkDaysRequest>;
export interface RebuildResult { rebuilt: number; skippedLocked: number }
