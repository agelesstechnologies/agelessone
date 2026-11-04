/** Leave may start in the afternoon of the first day... */
export type FromHalf = 'full' | 'second_half';
/** ...and end at midday on the last day. */
export type ToHalf = 'full' | 'first_half';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' → milliseconds at UTC midnight (UTC, so time zones and daylight saving never shift a day). */
function toUtc(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!DATE.test(date) || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new RangeError(`Not a real date: ${date}`);
  }
  return ms;
}

/**
 * Working days of leave from `from` to `to` (both included), in steps of 0.5.
 * - Days in `daysOff` ('YYYY-MM-DD': the job's holidays and weekly offs, from the work calendar) are not counted.
 * - fromHalf 'second_half' takes half a day off the first day; toHalf 'first_half' takes half a day off the last day —
 *   only when that day counts (a half-day on a holiday or weekly off changes nothing).
 * - A single day can be one half or the whole day, not "second half to first half".
 * Pure: no database, no clock. Whether holidays inside a leave count ("sandwich" rule) is company policy; this
 * function does not count them.
 */
export function calculateLeaveDays(
  from: string, to: string, fromHalf: FromHalf, toHalf: ToHalf, daysOff: string[],
): number {
  const start = toUtc(from);
  const end = toUtc(to);
  if (end < start) throw new RangeError(`Leave ends (${to}) before it starts (${from})`);
  if (start === end && fromHalf === 'second_half' && toHalf === 'first_half') {
    throw new RangeError('A single day cannot run from the second half to the first half');
  }

  const off = new Set(daysOff);
  const counts = (ms: number) => !off.has(new Date(ms).toISOString().slice(0, 10));

  let days = 0;
  for (let ms = start; ms <= end; ms += DAY_MS) if (counts(ms)) days += 1;
  if (fromHalf === 'second_half' && counts(start)) days -= 0.5;
  if (toHalf === 'first_half' && counts(end)) days -= 0.5;
  return days;
}
