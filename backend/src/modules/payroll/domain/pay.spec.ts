import { describe, expect, it } from 'vitest';
import { netPay, payFor } from './pay';

const monthly = 3_000_000; // ₹30,000.00
const base = { monthlyPaise: monthly, joinedOn: '2025-04-01', exitOn: null, absentDays: 0, basis: 'calendar_days' as const };

describe('payFor', () => {
  it('2 absent days in a 30-day month: loss of pay is 2/30 of the salary', () => {
    expect(payFor({ ...base, year: 2025, month: 11, absentDays: 2 }))
      .toEqual({ daysInMonth: 30, employedDays: 30, absentDays: 2, lopPaise: 200_000, salaryForMonthPaise: 2_800_000 });
  });

  it('2 absent days in a 31-day month: 2/31 of the salary, rounded to whole paise', () => {
    expect(payFor({ ...base, year: 2025, month: 12, absentDays: 2 }))
      .toEqual({ daysInMonth: 31, employedDays: 31, absentDays: 2, lopPaise: 193_548, salaryForMonthPaise: 2_806_452 });
  });

  it('a full month with no absence is the full salary, whatever the month length', () => {
    expect(payFor({ ...base, year: 2026, month: 2 }).salaryForMonthPaise).toBe(monthly);
    expect(payFor({ ...base, year: 2025, month: 12, basis: 'fixed_30' }).salaryForMonthPaise).toBe(monthly);
  });

  it('a mid-month joiner is paid only for their days', () => {
    expect(payFor({ ...base, year: 2025, month: 11, joinedOn: '2025-11-16' }))
      .toMatchObject({ employedDays: 15, salaryForMonthPaise: 1_500_000 });
  });

  it('a mid-month leaver too, and loss of pay comes off what is left', () => {
    expect(payFor({ ...base, year: 2025, month: 12, exitOn: '2025-12-10', absentDays: 1 }))
      .toMatchObject({ employedDays: 10, lopPaise: 96_774, salaryForMonthPaise: 967_742 - 96_774 });
  });

  it('a half day of absence, and the fixed 30-day basis', () => {
    expect(payFor({ ...base, year: 2025, month: 12, absentDays: 0.5, basis: 'fixed_30' })).toMatchObject({ daysInMonth: 30, lopPaise: 50_000 });
  });

  it('loss of pay never exceeds the pay for the days employed', () => {
    expect(payFor({ ...base, year: 2025, month: 11, joinedOn: '2025-11-29', absentDays: 5 })).toMatchObject({ lopPaise: 200_000, salaryForMonthPaise: 0 });
  });
});

describe('netPay', () => {
  it('adds additions and takes off deductions', () => {
    expect(netPay(2_800_000, [{ kind: 'deduction', amountPaise: 20_000 }, { kind: 'addition', amountPaise: 50_000 }, { kind: 'deduction', amountPaise: 100_000 }]))
      .toEqual({ additionsPaise: 50_000, deductionsPaise: 120_000, netPaise: 2_730_000 });
  });
});
