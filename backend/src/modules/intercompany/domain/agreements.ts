/** Agreement rules: who sees and works on an agreement, its terms, its status, and its billed months. */

/** Largest bill file accepted for a passed-on cost, in bytes. */
export const MAX_BILL_BYTES = 10 * 1024 * 1024;

/** A job counts while it is held (active, or serving notice); a head who left the company no longer sees the agreement. */
export const isCurrentJob = (status: string): boolean => status === 'active' || status === 'notice';

/** A side's head as the rules need it: whose job it is, and whether that job is still held. */
export interface Head { personId: number; current: boolean }

/** The two companies' heads (named on the agreement, job still held) and holders of view or manage with scope all (the CEO). */
export function canSeeAgreement(caller: { personId: number; seesAll: boolean }, heads: { provider: Head; receiver: Head }): boolean {
  if (caller.seesAll) return true;
  return [heads.provider, heads.receiver].some((h) => h.current && h.personId === caller.personId);
}

/** Costs passed on are the provider's to record: its head, or manage with scope all (the CEO). */
export function canRecordCosts(caller: { personId: number; managesAll: boolean }, providerHead: Head): boolean {
  return caller.managesAll || (providerHead.current && providerHead.personId === caller.personId);
}

export interface Terms {
  services: string[];
  pricingMethod: 'rate_card' | 'cost_plus';
  costPlusPercent: number | null;
  passedCostHandling: 'at_cost' | 'percent';
  passedCostPercent: number | null;
}

/** Why the terms do not fit together, as an error code; null when they do. */
export function termsProblem(t: Terms): 'IC_COST_PLUS_PERCENT' | 'IC_PASSED_COST_PERCENT' | null {
  if ((t.pricingMethod === 'cost_plus') !== (t.costPlusPercent !== null)) return 'IC_COST_PLUS_PERCENT';
  if ((t.passedCostHandling === 'percent') !== (t.passedCostPercent !== null)) return 'IC_PASSED_COST_PERCENT';
  return null;
}

/** The terms that price a month: once a month is billed they stay as they are. */
export function pricingChanged(a: Terms, b: Terms): boolean {
  return [...a.services].sort().join() !== [...b.services].sort().join() || a.pricingMethod !== b.pricingMethod
    || a.costPlusPercent !== b.costPlusPercent || a.passedCostHandling !== b.passedCostHandling || a.passedCostPercent !== b.passedCostPercent;
}

export type AgreementStatus = 'draft' | 'active' | 'ended';

/** draft → active → ended, or draft → ended (a draft dropped); an ended agreement never changes. Null: allowed (or no change). */
export function statusChangeProblem(from: AgreementStatus, to: AgreementStatus): 'IC_AGREEMENT_ENDED' | 'IC_STATUS_CHANGE' | null {
  if (from === 'ended') return 'IC_AGREEMENT_ENDED';
  if (from === to) return null;
  if (to === 'ended' || (from === 'draft' && to === 'active')) return null;
  return 'IC_STATUS_CHANGE';
}

// ---- months ----

export interface YearMonth { year: number; month: number }
const pad = (n: number) => String(n).padStart(2, '0');

export const monthOf = (date: string): YearMonth => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) });
export const monthStart = (m: YearMonth): string => `${m.year}-${pad(m.month)}-01`;
/** The last date of a month (YYYY-MM-DD). */
export function monthEnd(m: YearMonth): string {
  return `${m.year}-${pad(m.month)}-${pad(new Date(Date.UTC(m.year, m.month, 0)).getUTCDate())}`;
}
export const monthLabel = (m: YearMonth): string => `${m.year}-${pad(m.month)}`;

/** The billed month a date falls in, if any. */
export const billedMonthOf = (billed: YearMonth[], date: string): YearMonth | undefined => {
  const m = monthOf(date);
  return billed.find((b) => b.year === m.year && b.month === m.month);
};

/** A rate from this date would be in force in (or before) a billed month: the first such month, if any. */
export const billedMonthReachedBy = (billed: YearMonth[], effectiveFrom: string): YearMonth | undefined =>
  billed.find((b) => monthEnd(b) >= effectiveFrom);

/** Why this month cannot be billed now: outside the agreement's dates, or not over yet (today is an IST date). */
export function billMonthProblem(m: YearMonth, agreement: { startDate: string; endDate: string | null }, today: string): 'IC_MONTH_OUTSIDE_AGREEMENT' | 'IC_MONTH_NOT_OVER' | null {
  if (monthEnd(m) < agreement.startDate || (agreement.endDate !== null && monthStart(m) > agreement.endDate)) return 'IC_MONTH_OUTSIDE_AGREEMENT';
  if (monthEnd(m) >= today) return 'IC_MONTH_NOT_OVER';
  return null;
}
