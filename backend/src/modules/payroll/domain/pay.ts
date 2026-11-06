export type LopBasis = 'calendar_days' | 'fixed_30';

export interface PayInput {
  monthlyPaise: number;          // the salary in force for the month
  year: number; month: number;   // 1–12
  joinedOn: string;              // the employment's dates (YYYY-MM-DD)
  exitOn: string | null;
  absentDays: number;            // in steps of 0.5 (absences and unpaid leave)
  basis: LopBasis;
}

export interface Pay {
  daysInMonth: number;           // what the salary is divided by (calendar days, or 30)
  employedDays: number;          // days of the month inside the employment
  absentDays: number;
  lopPaise: number;              // loss of pay for the absent days
  salaryForMonthPaise: number;   // salary for the days employed, minus loss of pay
}

const DAY_MS = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Rounds a non-negative amount to whole paise, half up. */
const paise = (x: number) => Math.round(x);

/**
 * One person's pay for a month, in whole paise. Pure: no database, no clock.
 * - employed days: the month's days between joining and exit (a mid-month joiner or leaver is paid for those days only);
 * - divided by the month's calendar days (28–31) or always 30 (policy payroll.lop_basis); with 30, a full month is
 *   paid in full even in a 31-day month;
 * - loss of pay = monthly salary × absent days ÷ that number; never more than the pay for the days employed.
 */
export function payFor(i: PayInput): Pay {
  const first = Date.UTC(i.year, i.month - 1, 1);
  const last = Date.UTC(i.year, i.month, 0);
  const calendarDays = Math.round((last - first) / DAY_MS) + 1;
  const from = Math.max(first, utc(i.joinedOn));
  const to = Math.min(last, i.exitOn ? utc(i.exitOn) : last);
  const employedDays = to < from ? 0 : Math.round((to - from) / DAY_MS) + 1;

  const daysInMonth = i.basis === 'fixed_30' ? 30 : calendarDays;
  const paidDays = Math.min(employedDays === calendarDays ? daysInMonth : employedDays, daysInMonth);
  const forDaysEmployed = paise((i.monthlyPaise * paidDays) / daysInMonth);
  const lopPaise = Math.min(forDaysEmployed, paise((i.monthlyPaise * i.absentDays) / daysInMonth));
  return { daysInMonth, employedDays, absentDays: i.absentDays, lopPaise, salaryForMonthPaise: forDaysEmployed - lopPaise };
}

/** Net pay: salary for the month plus additions minus deductions (each adjustment is more than zero). */
export function netPay(salaryForMonthPaise: number, adjustments: { kind: 'addition' | 'deduction'; amountPaise: number }[]) {
  const additions = adjustments.filter((a) => a.kind === 'addition').reduce((s, a) => s + a.amountPaise, 0);
  const deductions = adjustments.filter((a) => a.kind === 'deduction').reduce((s, a) => s + a.amountPaise, 0);
  return { additionsPaise: additions, deductionsPaise: deductions, netPaise: salaryForMonthPaise + additions - deductions };
}

/** First and last date of a month (YYYY-MM-DD). */
export function monthDates(year: number, month: number): { from: string; to: string } {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}
