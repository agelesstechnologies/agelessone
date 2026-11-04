import { describe, expect, it } from 'vitest';
import { monthEnded, monthRange, monthsBetween } from './months';

describe('months', () => {
  it('months touched by a range, across a year end', () => {
    expect(monthsBetween('2026-12-30', '2027-01-04')).toEqual([{ year: 2026, month: 12 }, { year: 2027, month: 1 }]);
    expect(monthsBetween('2026-05-10', '2026-05-12')).toEqual([{ year: 2026, month: 5 }]);
  });
  it('first and last day, February in a leap year', () => {
    expect(monthRange({ year: 2028, month: 2 })).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
  it('a month is over only after its last day', () => {
    expect(monthEnded({ year: 2026, month: 10 }, '2026-10-31')).toBe(false);
    expect(monthEnded({ year: 2026, month: 10 }, '2026-11-01')).toBe(true);
  });
});
