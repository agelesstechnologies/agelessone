/**
 * Rate cards: an hourly rate for a service type or a grade, from a date. A new rate is a new row, so a month is always
 * priced with the rate in force on each of its dates — a later rate never reaches back. CA TO CONFIRM.
 */
export interface RateRow { serviceType: string | null; grade: string | null; effectiveFrom: string }

/** What a rate is for: `service:design`, `grade:G3`. */
export const rateItem = (r: { serviceType?: string | null; grade?: string | null }): string =>
  r.serviceType ? `service:${r.serviceType}` : `grade:${r.grade ?? ''}`;

/** The rate in force on a date for one service type or grade: the newest one starting on or before it; undefined before the first. */
export function rateInForce<T extends RateRow>(cards: T[], item: { serviceType?: string | null; grade?: string | null }, on: string): T | undefined {
  const key = rateItem(item);
  let best: T | undefined;
  for (const c of cards) {
    if (rateItem(c) !== key || c.effectiveFrom > on) continue;
    if (!best || c.effectiveFrom > best.effectiveFrom) best = c;
  }
  return best;
}

/** Every service type's and grade's rate in force on a date (items with no rate yet are left out). */
export function ratesInForce<T extends RateRow>(cards: T[], on: string): T[] {
  const items = new Map<string, T>();
  for (const c of cards) if (!items.has(rateItem(c))) items.set(rateItem(c), c);
  return [...items.values()].map((c) => rateInForce(cards, c, on)).filter((c): c is T => c !== undefined);
}
