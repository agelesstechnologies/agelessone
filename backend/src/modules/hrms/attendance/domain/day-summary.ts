import { calculateWorkDay, DayRules, DayStatus, Punch } from './work-day-calculator';

export interface DayPolicy extends DayRules { maxOpenPunchHours: number }
/** What the work calendar says the date is for this job. */
export type DayKind = 'working' | 'weekly_off' | 'holiday';
/** How much of the day approved leave covers. */
export type LeavePart = 'full' | 'half' | null;
export type ShownStatus = DayStatus | 'working' | 'weekly_off' | 'holiday' | 'leave';

/** The part of `date` an approved leave covers (it may start at midday on its first day and end at midday on its last). */
export function leavePartOn(r: { fromDate: string; toDate: string; fromHalf: string; toHalf: string }, date: string): LeavePart {
  if (date < r.fromDate || date > r.toDate) return null;
  if ((date === r.fromDate && r.fromHalf === 'second_half') || (date === r.toDate && r.toHalf === 'first_half')) return 'half';
  return 'full';
}

/** Approved overtime on a day: what the approved requests allow, never more than the extra time worked. */
export function approvedOvertime(extraMinutes: number, approvedRequestMinutes: number[]): number {
  return Math.min(extraMinutes, approvedRequestMinutes.reduce((a, b) => a + b, 0));
}

export interface DaySplit { status: ShownStatus; leaveDays: number; absentDays: number; workedOnLeave: boolean }

/**
 * Status, leave days and absent days (each 0, 0.5 or 1) of one job's day, from what the punches say, the calendar
 * and approved leave. A weekly off or holiday is neither leave nor absence. A missed punch-out is not counted as
 * absence (it waits for a correction).
 *
 * | leave | worked full day        | worked half day      | worked less / nothing |
 * | none  | present 0 / 0          | half_day 0 / 0.5     | absent 0 / 1          |
 * | half  | present 0.5 / 0, w.o.l | present 0.5 / 0      | half_day 0.5 / 0.5    |
 * | full  | present 1 / 0, w.o.l   | leave 1 / 0, w.o.l   | leave 1 / 0           |
 * (leave days / absent days; w.o.l = worked_on_leave)
 */
export function splitDay(status: DayStatus, kind: DayKind, leave: LeavePart, workedMinutes: number): DaySplit {
  if (kind !== 'working') return { status: status === 'absent' ? kind : status, leaveDays: 0, absentDays: 0, workedOnLeave: false };
  if (leave === null) {
    return { status, leaveDays: 0, absentDays: status === 'absent' ? 1 : status === 'half_day' ? 0.5 : 0, workedOnLeave: false };
  }
  if (status === 'missed_punch') return { status, leaveDays: leave === 'full' ? 1 : 0.5, absentDays: 0, workedOnLeave: leave === 'full' };
  if (leave === 'half') {
    if (status === 'absent') return { status: 'half_day', leaveDays: 0.5, absentDays: 0.5, workedOnLeave: false };
    return { status: 'present', leaveDays: 0.5, absentDays: 0, workedOnLeave: status === 'present' };
  }
  return { status: status === 'present' ? 'present' : 'leave', leaveDays: 1, absentDays: 0, workedOnLeave: workedMinutes > 0 };
}

export interface DaySummary extends DaySplit {
  firstIn: Date | null; lastOut: Date | null;
  workedMinutes: number; extraMinutes: number;
  running: boolean;
}

/**
 * One job's day from its punches (already limited to that IST date).
 * With `now` (today only): an open punch-in counts up to now and the status is 'working' (nothing counted as absent
 * yet) — unless it has been open longer than the policy's max hours: then it is a missed punch-out.
 * Without `now`: an open punch-in is a missed punch-out (what gets stored).
 * A day closed by an automatic punch-out keeps its minutes but stays a missed punch, so it is noticed and corrected.
 */
export function summarizeDay(punches: Punch[], policy: DayPolicy, now?: Date, kind: DayKind = 'working', leave: LeavePart = null): DaySummary {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  const firstIn = sorted.find((p) => p.kind === 'in')?.at ?? null;
  const lastOut = [...sorted].reverse().find((p) => p.kind === 'out')?.at ?? null;
  const last = sorted.at(-1);
  const running = last?.kind === 'in' && now !== undefined && now.getTime() - last.at.getTime() <= policy.maxOpenPunchHours * 3_600_000;
  const counted = running ? [...sorted, { kind: 'out' as const, at: now! }] : sorted;
  const worked = calculateWorkDay(counted, policy);
  const { workedMinutes } = worked;
  const status = sorted.some((p) => p.auto) ? 'missed_punch' : worked.status;
  const extraMinutes = Math.max(0, workedMinutes - policy.fullDayMinutes); // extra time is not overtime until approved
  const split = splitDay(status, kind, leave, workedMinutes);
  if (running) Object.assign(split, { status: 'working', absentDays: 0 });
  return { firstIn, lastOut, workedMinutes, extraMinutes, running, ...split };
}
