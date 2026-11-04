import { describe, expect, it } from 'vitest';
import { balanceAllows, daysPerYear, fitToTotal, leaveOn, stepNotAllowed } from './requests';

describe('daysPerYear', () => {
  it('a leave inside one year is one part', () => {
    expect(daysPerYear('2026-11-02', '2026-11-04', 'second_half', 'full', [])).toEqual([{ year: 2026, days: 2.5 }]);
  });
  it('across the year end: Wed 30 Dec 2026 – Mon 4 Jan 2027, Sunday 3 Jan and 1 Jan off, ending at midday', () => {
    expect(daysPerYear('2026-12-30', '2027-01-04', 'full', 'first_half', ['2027-01-01', '2027-01-03']))
      .toEqual([{ year: 2026, days: 2 }, { year: 2027, days: 1.5 }]);
  });
  it('a year with only days off is left out', () => {
    expect(daysPerYear('2026-12-31', '2027-01-02', 'full', 'full', ['2026-12-31'])).toEqual([{ year: 2027, days: 2 }]);
  });
});

describe('fitToTotal', () => {
  it('parts that already add up stay as they are', () => {
    expect(fitToTotal([{ year: 2026, days: 2 }, { year: 2027, days: 1.5 }], 3.5)).toEqual([{ year: 2026, days: 2 }, { year: 2027, days: 1.5 }]);
  });
  it('a difference goes to the last year', () => {
    expect(fitToTotal([{ year: 2026, days: 2 }, { year: 2027, days: 1 }], 3.5)).toEqual([{ year: 2026, days: 2 }, { year: 2027, days: 1.5 }]);
  });
});

describe('leaveOn', () => {
  const r = { fromDate: '2026-11-02', toDate: '2026-11-04', fromHalf: 'second_half', toHalf: 'first_half' };
  it('half on the first and last day, full in between, none outside', () => {
    expect(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'].map((d) => leaveOn(r, d)))
      .toEqual([null, 'half', 'full', 'half', null]);
  });
});

describe('balanceAllows', () => {
  it('with the check off anything goes', () => expect(balanceAllows(0, 5, false)).toBe(true));
  it('with the check on the balance may reach zero but not go below', () => {
    expect(balanceAllows(2, 2, true)).toBe(true);
    expect(balanceAllows(2, 2.5, true)).toBe(false);
  });
});

describe('stepNotAllowed', () => {
  it('only a submitted request can be approved or rejected', () => {
    expect(stepNotAllowed('submitted', 'approve')).toBeNull();
    expect(stepNotAllowed('approved', 'reject')).toBe('HRMS_LEAVE_NOT_PENDING');
  });
  it('submitted and approved requests can be cancelled; rejected and cancelled ones are closed', () => {
    expect(stepNotAllowed('approved', 'cancel')).toBeNull();
    expect(stepNotAllowed('rejected', 'cancel')).toBe('HRMS_LEAVE_CLOSED');
    expect(stepNotAllowed('cancelled', 'cancel')).toBe('HRMS_LEAVE_CLOSED');
  });
});
