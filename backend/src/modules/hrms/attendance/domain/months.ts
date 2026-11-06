export interface YearMonth { year: number; month: number }

/** Every calendar month touched by from..to (YYYY-MM-DD, both included). */
export function monthsBetween(from: string, to: string): YearMonth[] {
  const out: YearMonth[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ year: y, month: m });
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }
  return out;
}

/** First and last date of a month. */
export function monthRange({ year, month }: YearMonth): { from: string; to: string } {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}

/** A month can be locked once its last day is over. */
export function monthEnded(ym: YearMonth, today: string): boolean {
  return monthRange(ym).to < today;
}
