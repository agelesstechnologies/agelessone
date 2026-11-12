import { describe, expect, it } from 'vitest';
import { monthsToAccrue, paidParts, unpaidDaysFor, unpaidInside } from './accrual';

describe('monthly leave entitlement', () => {
  it('every month of this year up to now, or from the joining month', () => {
    expect(monthsToAccrue('2024-06-10', '2026-03-15')).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(monthsToAccrue('2026-02-20', '2026-03-01')).toEqual(['2026-02-01', '2026-03-01']);   // joined in Feb: Feb counts
    expect(monthsToAccrue('2026-04-01', '2026-03-31')).toEqual([]);                             // not joined yet
    expect(monthsToAccrue('2026-11-09', '2026-11-09')).toEqual(['2026-11-01']);
  });
});

describe('loss of pay beyond the balance', () => {
  it('only the days the balance does not cover', () => {
    expect(unpaidDaysFor(3, 5)).toBe(0);
    expect(unpaidDaysFor(3, 1)).toBe(2);
    expect(unpaidDaysFor(3, 0)).toBe(3);
    expect(unpaidDaysFor(2, -1)).toBe(2);       // a negative balance never adds more than the request
    expect(unpaidDaysFor(1.5, 0.5)).toBe(1);
  });

  it('unpaid days come off the end, the last year first', () => {
    expect(paidParts([{ year: 2026, days: 2 }, { year: 2027, days: 3 }], 4)).toEqual([{ year: 2026, days: 1 }]);
    expect(paidParts([{ year: 2026, days: 2 }], 0)).toEqual([{ year: 2026, days: 2 }]);
    expect(paidParts([{ year: 2026, days: 2 }], 2)).toEqual([]);
  });

  it('in a pay period: the unpaid days after it are used up first', () => {
    // 5 days, last 2 unpaid; 3 days in November, 2 in December
    expect(unpaidInside(2, 2, 3)).toBe(0);      // November: the 2 unpaid days are in December
    expect(unpaidInside(2, 0, 2)).toBe(2);      // December
    expect(unpaidInside(4, 2, 3)).toBe(2);      // 4 unpaid: 2 in December, 2 in November
  });
});
