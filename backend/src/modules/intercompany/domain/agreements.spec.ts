import { describe, expect, it } from 'vitest';
import {
  billedMonthOf, billedMonthReachedBy, billMonthProblem, canRecordCosts, canSeeAgreement, monthEnd, pricingChanged, statusChangeProblem, termsProblem, Terms,
} from './agreements';

const heads = { provider: { personId: 1, current: true }, receiver: { personId: 2, current: true } };

describe('who sees an agreement', () => {
  it('the two companies\' heads and the CEO (scope all); nobody else', () => {
    expect(canSeeAgreement({ personId: 1, seesAll: false }, heads)).toBe(true);
    expect(canSeeAgreement({ personId: 2, seesAll: false }, heads)).toBe(true);
    expect(canSeeAgreement({ personId: 9, seesAll: true }, heads)).toBe(true);
    expect(canSeeAgreement({ personId: 3, seesAll: false }, heads)).toBe(false);
  });
  it('a head who left the company no longer sees it', () => {
    expect(canSeeAgreement({ personId: 1, seesAll: false }, { ...heads, provider: { personId: 1, current: false } })).toBe(false);
  });
  it('passed-on costs: the provider\'s head or the CEO, never the receiver\'s head', () => {
    expect(canRecordCosts({ personId: 1, managesAll: false }, heads.provider)).toBe(true);
    expect(canRecordCosts({ personId: 2, managesAll: false }, heads.provider)).toBe(false);
    expect(canRecordCosts({ personId: 9, managesAll: true }, heads.provider)).toBe(true);
  });
});

describe('terms and status', () => {
  const t: Terms = { services: ['design'], pricingMethod: 'rate_card', costPlusPercent: null, passedCostHandling: 'at_cost', passedCostPercent: null };
  it('cost plus needs its percentage, percent handling needs its percentage', () => {
    expect(termsProblem(t)).toBeNull();
    expect(termsProblem({ ...t, pricingMethod: 'cost_plus' })).toBe('IC_COST_PLUS_PERCENT');
    expect(termsProblem({ ...t, costPlusPercent: 10 })).toBe('IC_COST_PLUS_PERCENT');
    expect(termsProblem({ ...t, passedCostHandling: 'percent' })).toBe('IC_PASSED_COST_PERCENT');
    expect(termsProblem({ ...t, passedCostHandling: 'percent', passedCostPercent: 5 })).toBeNull();
  });
  it('pricing changes: services (any order), method, percentages', () => {
    expect(pricingChanged(t, { ...t })).toBe(false);
    expect(pricingChanged({ ...t, services: ['design', 'cgi'] }, { ...t, services: ['cgi', 'design'] })).toBe(false);
    expect(pricingChanged(t, { ...t, services: ['design', 'cgi'] })).toBe(true);
    expect(pricingChanged(t, { ...t, pricingMethod: 'cost_plus', costPlusPercent: 12.5 })).toBe(true);
  });
  it('draft → active → ended, or a draft dropped; ended never changes', () => {
    expect(statusChangeProblem('draft', 'active')).toBeNull();
    expect(statusChangeProblem('draft', 'ended')).toBeNull();
    expect(statusChangeProblem('active', 'ended')).toBeNull();
    expect(statusChangeProblem('active', 'active')).toBeNull();
    expect(statusChangeProblem('active', 'draft')).toBe('IC_STATUS_CHANGE');
    expect(statusChangeProblem('ended', 'active')).toBe('IC_AGREEMENT_ENDED');
  });
});

describe('billed months', () => {
  const billed = [{ year: 2026, month: 9 }];
  it('a date in a billed month', () => {
    expect(billedMonthOf(billed, '2026-09-30')).toEqual({ year: 2026, month: 9 });
    expect(billedMonthOf(billed, '2026-10-01')).toBeUndefined();
  });
  it('a new rate may not reach back into a billed month', () => {
    expect(billedMonthReachedBy(billed, '2026-09-30')).toEqual({ year: 2026, month: 9 });
    expect(billedMonthReachedBy(billed, '2026-01-01')).toEqual({ year: 2026, month: 9 });
    expect(billedMonthReachedBy(billed, '2026-10-01')).toBeUndefined();
  });
  it('month ends, leap years included', () => {
    expect(monthEnd({ year: 2028, month: 2 })).toBe('2028-02-29');
    expect(monthEnd({ year: 2026, month: 2 })).toBe('2026-02-28');
    expect(monthEnd({ year: 2026, month: 12 })).toBe('2026-12-31');
  });
  it('only a finished month inside the agreement\'s dates is billed', () => {
    const a = { startDate: '2026-04-15', endDate: null };
    expect(billMonthProblem({ year: 2026, month: 4 }, a, '2026-11-13')).toBeNull();
    expect(billMonthProblem({ year: 2026, month: 3 }, a, '2026-11-13')).toBe('IC_MONTH_OUTSIDE_AGREEMENT');
    expect(billMonthProblem({ year: 2026, month: 11 }, a, '2026-11-13')).toBe('IC_MONTH_NOT_OVER');
    expect(billMonthProblem({ year: 2026, month: 9 }, { ...a, endDate: '2026-08-31' }, '2026-11-13')).toBe('IC_MONTH_OUTSIDE_AGREEMENT');
  });
});
