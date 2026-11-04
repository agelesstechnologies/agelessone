import { describe, expect, it } from 'vitest';
import { calendarDays, isWeeklyOff, RulePeriod, WeeklyOffRule } from './work-calendar';

// November 2026 starts on a Sunday: Saturdays are 7, 14, 21, 28; Sundays 1, 8, 15, 22, 29.
const SUNDAY_AND_2ND_4TH_SATURDAY: WeeklyOffRule = { weekdays: [0], nthWeekdays: [{ weekday: 6, nth: [2, 4] }] };
const company: RulePeriod[] = [{ validFrom: '2025-04-01', validTo: null, rule: SUNDAY_AND_2ND_4TH_SATURDAY }];
const kinds = (dates: string[], personRules: RulePeriod[] = [], holidays = [] as { date: string; name: string; optional: boolean }[]) =>
  calendarDays(dates, company, personRules, holidays).map((d) => d.kind);

describe('isWeeklyOff', () => {
  it('every Sunday and only the 2nd and 4th Saturday', () => {
    expect(['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28'].map((d) => isWeeklyOff(d, SUNDAY_AND_2ND_4TH_SATURDAY)))
      .toEqual([false, true, false, true]);
    expect(['2026-11-01', '2026-11-29'].every((d) => isWeeklyOff(d, SUNDAY_AND_2ND_4TH_SATURDAY))).toBe(true);
    expect(isWeeklyOff('2026-11-02', SUNDAY_AND_2ND_4TH_SATURDAY)).toBe(false); // Monday
  });

  it('a 5th Saturday counts only when the rule names it', () => {
    // August 2026: Saturdays 1, 8, 15, 22, 29
    expect(isWeeklyOff('2026-08-29', SUNDAY_AND_2ND_4TH_SATURDAY)).toBe(false);
    expect(isWeeklyOff('2026-08-29', { weekdays: [], nthWeekdays: [{ weekday: 6, nth: [5] }] })).toBe(true);
  });
});

describe('calendarDays', () => {
  it('uses the company rule when the person has none', () => {
    expect(kinds(['2026-11-13', '2026-11-14', '2026-11-15'])).toEqual(['working', 'weekly_off', 'weekly_off']);
  });

  it('the person\'s own rule wins while it is in force', () => {
    const fridays: RulePeriod[] = [{ validFrom: '2026-11-10', validTo: '2026-11-20', rule: { weekdays: [5], nthWeekdays: [] } }];
    // Fri 6 (before), Fri 13 and Sun 15 (inside: Friday off, Sunday worked), Sun 22 (after: company rule again)
    expect(kinds(['2026-11-06', '2026-11-13', '2026-11-15', '2026-11-22'], fridays)).toEqual(['working', 'weekly_off', 'working', 'weekly_off']);
  });

  it('with no rule at all every day is a working day', () => {
    expect(calendarDays(['2026-11-15'], [], [], []).map((d) => d.kind)).toEqual(['working']);
  });

  it('a holiday wins over a weekly off and is named; an optional holiday stays a working day', () => {
    const days = calendarDays(['2026-11-08', '2026-11-09', '2026-11-10'], company, [], [
      { date: '2026-11-08', name: 'Diwali', optional: false },
      { date: '2026-11-09', name: 'Govardhan Puja', optional: false },
      { date: '2026-11-10', name: 'Bhai Dooj', optional: true },
    ]);
    expect(days).toEqual([
      { date: '2026-11-08', kind: 'holiday', holiday: 'Diwali', optionalHoliday: null },
      { date: '2026-11-09', kind: 'holiday', holiday: 'Govardhan Puja', optionalHoliday: null },
      { date: '2026-11-10', kind: 'working', holiday: null, optionalHoliday: 'Bhai Dooj' },
    ]);
  });
});
