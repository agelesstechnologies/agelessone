import { describe, expect, it } from 'vitest';
import { attendancePercent, daysBetween, emptySplit, monthBounds, previousMonth, splitKey } from './dashboard';

describe('dashboard arithmetic', () => {
  it('works out month bounds, including February in a leap year', () => {
    expect(monthBounds('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('steps back over a year end', () => {
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(previousMonth('2026-11')).toBe('2026-10');
  });

  it('maps stored statuses and calendar kinds to split keys', () => {
    expect(splitKey('half_day')).toBe('halfDay');
    expect(splitKey('weekly_off')).toBe('weeklyOff');
    expect(splitKey('working')).toBe('absent');
  });

  it('counts a half day as half attended and leaves leave out', () => {
    expect(attendancePercent({ ...emptySplit(), present: 3, halfDay: 2, absent: 1, leave: 5 })).toBe(66.7);
    expect(attendancePercent({ ...emptySplit(), leave: 2, holiday: 1 })).toBeNull();
  });

  it('counts whole days between dates', () => {
    expect(daysBetween('2026-10-30', '2026-11-04')).toBe(5);
  });
});
