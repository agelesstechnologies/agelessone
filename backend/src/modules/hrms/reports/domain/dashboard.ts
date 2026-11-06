/** Dashboard arithmetic: months, day splits and attendance %. Pure functions. */

export type SplitKey = 'present' | 'halfDay' | 'missedPunch' | 'absent' | 'leave' | 'holiday' | 'weeklyOff';
export type Split = Record<SplitKey, number>;

const KEY: Record<string, SplitKey> = {
  present: 'present', half_day: 'halfDay', missed_punch: 'missedPunch', absent: 'absent', leave: 'leave', holiday: 'holiday', weekly_off: 'weeklyOff',
};

/** A stored day status (or a calendar kind) as a split key; 'working' with nothing stored is an absence. */
export function splitKey(status: string): SplitKey {
  return status === 'working' ? 'absent' : KEY[status] ?? 'absent';
}

export function emptySplit(): Split {
  return { present: 0, halfDay: 0, missedPunch: 0, absent: 0, leave: 0, holiday: 0, weeklyOff: 0 };
}

/** "2026-11" → first and last day. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** "2026-01" → "2025-12" */
export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * Attended working days (a half day counts 0.5) over working days (present, half day, missed punch, absent; leave,
 * holidays and weekly offs left out), one decimal. Null without working days.
 */
export function attendancePercent(s: Split): number | null {
  const working = s.present + s.halfDay + s.missedPunch + s.absent;
  if (working === 0) return null;
  return Math.round(((s.present + s.halfDay / 2) / working) * 1000) / 10;
}

/** Whole days between two IST dates (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
