/**
 * Weekly offs: every listed weekday, plus the nth time a weekday comes in the month (0 = Sunday … 6 = Saturday).
 * { weekdays: [0], nthWeekdays: [{ weekday: 6, nth: [2, 4] }] } = every Sunday and the 2nd and 4th Saturday.
 */
export interface WeeklyOffRule { weekdays: number[]; nthWeekdays: { weekday: number; nth: number[] }[] }
/** A rule in force from validFrom to validTo (both included; null = until changed). */
export interface RulePeriod { validFrom: string; validTo: string | null; rule: WeeklyOffRule }
export interface HolidayDate { date: string; name: string; optional: boolean }
export type DayKind = 'working' | 'weekly_off' | 'holiday';
export interface CalendarDay { date: string; kind: DayKind; holiday: string | null; optionalHoliday: string | null }

/** The weekday (0 = Sunday) and which one of that weekday in the month it is (1st … 5th). */
function weekdayOf(date: string): { weekday: number; nth: number } {
  const d = new Date(`${date}T00:00:00Z`);
  return { weekday: d.getUTCDay(), nth: Math.ceil(d.getUTCDate() / 7) };
}

export function isWeeklyOff(date: string, rule: WeeklyOffRule): boolean {
  const { weekday, nth } = weekdayOf(date);
  return rule.weekdays.includes(weekday) || rule.nthWeekdays.some((n) => n.weekday === weekday && n.nth.includes(nth));
}

const inForce = (periods: RulePeriod[], date: string) =>
  periods.find((p) => p.validFrom <= date && (p.validTo === null || date <= p.validTo));

/**
 * One job's calendar. The person's own rule wins over the company's; with neither, there is no weekly off.
 * A holiday wins over a weekly off (to show its name). An optional (restricted) holiday is still a working day:
 * the person takes it as leave. Pure: no database, no clock.
 */
export function calendarDays(dates: string[], companyRules: RulePeriod[], personRules: RulePeriod[], holidays: HolidayDate[]): CalendarDay[] {
  return dates.map((date) => {
    const fixed = holidays.find((h) => h.date === date && !h.optional);
    const optional = holidays.find((h) => h.date === date && h.optional);
    const rule = inForce(personRules, date) ?? inForce(companyRules, date);
    const kind: DayKind = fixed ? 'holiday' : rule && isWeeklyOff(date, rule.rule) ? 'weekly_off' : 'working';
    return { date, kind, holiday: fixed?.name ?? null, optionalHoliday: optional?.name ?? null };
  });
}
