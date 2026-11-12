/**
 * Leave entitlement and loss of pay. Pure: no database.
 * - Monthly entitlement: on the 1st of every month an active job gets its days (policy hrms.leave.monthly_accrual,
 *   e.g. 1 sick + 1 earned), from the month it joined.
 * - Loss of pay: days beyond the balance when leave is approved; they are the LAST days of the request.
 */

/** First days of the months of `today`'s year from the joining month (or January) up to this month: '2026-03-01' … */
export function monthsToAccrue(joinedOn: string, today: string): string[] {
  const year = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7));
  const joinYear = Number(joinedOn.slice(0, 4));
  if (joinYear > year || (joinYear === year && Number(joinedOn.slice(5, 7)) > thisMonth)) return [];
  const first = joinYear === year ? Number(joinedOn.slice(5, 7)) : 1;
  return Array.from({ length: thisMonth - first + 1 }, (_, i) => `${year}-${String(first + i).padStart(2, '0')}-01`);
}

/** Days beyond the balance (never below 0, never more than the request). */
export function unpaidDaysFor(days: number, balance: number): number {
  return Math.min(days, Math.max(0, days - Math.max(0, balance)));
}

/** The yearly parts of a request without its unpaid days, which come off the end (the last year first). */
export function paidParts(parts: { year: number; days: number }[], unpaid: number): { year: number; days: number }[] {
  let left = unpaid;
  const out = [...parts].reverse().map((p) => {
    const cut = Math.min(p.days, left);
    left -= cut;
    return { year: p.year, days: p.days - cut };
  });
  return out.reverse().filter((p) => p.days > 0);
}

/**
 * Unpaid days of a request that fall inside a pay period: the unpaid days are its last ones, so those after the period
 * are used up first. daysAfter = the request's leave days after the period; daysInside = its leave days inside it.
 */
export function unpaidInside(unpaid: number, daysAfter: number, daysInside: number): number {
  return Math.min(daysInside, Math.max(0, unpaid - daysAfter));
}
