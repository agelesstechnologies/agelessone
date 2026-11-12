import { addDays, istDayStart } from '../../../platform/time';

/** Outside workers' daily attendance on a ticket's site: which days may be recorded, and the values. Pure. */

/** A list without dates covers this many days up to today; a list never covers more than the maximum. */
export const ATTENDANCE_DEFAULT_DAYS = 31;
export const ATTENDANCE_MAX_DAYS = 92;
const DAY_MS = 86_400_000;

export type AttendanceDateProblem = 'FUTURE' | 'BEFORE_START' | 'AFTER_END' | 'TOO_OLD';

/**
 * Why a work date (IST) cannot be recorded for a worker on site from `fromDate` to `toDate` (null: still on site), or
 * null when it can: not after today, within their days on site, and at most `backdateDays` before today.
 */
export function attendanceDateProblem(date: string, worker: { fromDate: string; toDate: string | null }, today: string,
  backdateDays: number): AttendanceDateProblem | null {
  if (date > today) return 'FUTURE';
  if (date < worker.fromDate) return 'BEFORE_START';
  if (worker.toDate !== null && date > worker.toDate) return 'AFTER_END';
  if (date < addDays(today, -backdateDays)) return 'TOO_OLD';
  return null;
}

/** The dates a list covers: the ones asked for, else the last 31 days up to today. null: reversed or longer than 92 days. */
export function attendanceRange(q: { from?: string; to?: string }, today: string): { from: string; to: string } | null {
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, -(ATTENDANCE_DEFAULT_DAYS - 1));
  if (from > to) return null;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  return days > ATTENDANCE_MAX_DAYS ? null : { from, to };
}

/** An IST clock time ('HH:MM', 24-hour) on an IST work date, as the instant (UTC). */
export function istClock(date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(istDayStart(date).getTime() + (h * 60 + m) * 60_000);
}

/** Minutes from time in to time out; null unless both are known. */
export function attendanceMinutes(timeIn: Date | null, timeOut: Date | null): number | null {
  return timeIn && timeOut ? Math.round((timeOut.getTime() - timeIn.getTime()) / 60_000) : null;
}

export interface AttendanceValues { status: string; timeIn: Date | null; timeOut: Date | null; note: string | null }

/** The same day sent again with nothing changed (a resend): nothing is written. */
export function sameAttendance(a: AttendanceValues, b: AttendanceValues): boolean {
  return a.status === b.status && a.note === b.note && a.timeIn?.getTime() === b.timeIn?.getTime() && a.timeOut?.getTime() === b.timeOut?.getTime();
}
