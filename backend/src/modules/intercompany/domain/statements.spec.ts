import { describe, expect, it } from 'vitest';
import {
  amountFor, approveProblem, canAnswer, canSeeStatement, correctionProblem, creditFor, openDisputes, passedCostAmount, priceLabour, reviewDueOn,
  reviewOver, StatementPeople, statusAfterAnswer, TimeEntry, toBasisPoints,
} from './statements';

const entry = (over: Partial<TimeEntry>): TimeEntry => ({ ticketId: 1, employmentId: 10, workDate: '2025-08-05', minutes: 60, serviceType: 'design',
  projectKind: 'project', projectPublicId: 'p1', designation: null, ...over });
const cards = [
  { serviceType: 'design', grade: null, rateMinor: 150_000, effectiveFrom: '2025-01-01' },
  { serviceType: 'design', grade: null, rateMinor: 180_000, effectiveFrom: '2025-08-16' },
  { serviceType: 'software', grade: null, rateMinor: 200_000, effectiveFrom: '2025-01-01' },
  { serviceType: null, grade: 'Senior Designer', rateMinor: 250_000, effectiveFrom: '2025-01-01' },
];
const salaries = [{ employmentId: 10, monthlyMinor: 4_160_000, effectiveFrom: '2025-01-01' }];   // 41,600 ÷ 208 h = 200 an hour
const rateCard = { method: 'rate_card' as const, costPlusBp: null, hoursPerMonth: 208 };

describe('pricing a month', () => {
  it('totals equal hours × the rate in force on each date; one line per project, service, person and rate', () => {
    const { lines, missing } = priceLabour([
      entry({ ticketId: 1, minutes: 120 }), entry({ ticketId: 2, minutes: 30, workDate: '2025-08-06' }),   // same line, two tickets
      entry({ ticketId: 1, minutes: 60, workDate: '2025-08-20' }),                                        // the new rate from the 16th
      entry({ ticketId: 3, minutes: 90, serviceType: 'software', employmentId: 11 }),
    ], cards, salaries, rateCard);
    expect(missing).toEqual({ rates: [], costs: [] });
    const byRate = Object.fromEntries(lines.map((l) => [`${l.serviceType}@${l.rateMinor}`, l]));
    expect(byRate['design@150000']).toMatchObject({ minutes: 150, amountMinor: 375_000, costMinor: 50_000, costPerHourMinor: 20_000 });
    expect([...byRate['design@150000'].tickets]).toEqual([[1, 120], [2, 30]]);
    expect(byRate['design@180000']).toMatchObject({ minutes: 60, amountMinor: 180_000 });
    expect(byRate['software@200000']).toMatchObject({ minutes: 90, amountMinor: 300_000, costMinor: null });   // no salary: cost unknown
  });

  it('a grade rate (the job\'s designation, any case) comes before the service type\'s', () => {
    const { lines } = priceLabour([entry({ designation: 'senior designer' })], cards, salaries, rateCard);
    expect(lines[0]).toMatchObject({ grade: 'Senior Designer', rateMinor: 250_000, amountMinor: 250_000 });
  });

  it('cost plus: cost per hour from the salary plus the percentage; without a salary it cannot be priced', () => {
    const { lines, missing } = priceLabour([entry({ minutes: 90 }), entry({ employmentId: 11 })], cards, salaries,
      { method: 'cost_plus', costPlusBp: toBasisPoints('12.50'), hoursPerMonth: 208 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ rateMinor: 22_500, minutes: 90, amountMinor: 33_750, costMinor: 30_000 });
    expect(missing.costs).toEqual([{ employmentId: 11, date: '2025-08-05' }]);
  });

  it('no rate in force is listed, not guessed', () => {
    const { lines, missing } = priceLabour([entry({ serviceType: 'cgi' }), entry({ workDate: '2024-12-31' })], cards, salaries, rateCard);
    expect(lines).toEqual([]);
    expect(missing.rates).toEqual([{ serviceType: 'cgi', date: '2025-08-05' }, { serviceType: 'design', date: '2024-12-31' }]);
  });

  it('amounts round to the nearest paisa; passed-on costs at cost or with the percentage', () => {
    expect(amountFor(7, 100_001)).toBe(11_667);
    expect(passedCostAmount(100_000, 'at_cost', null)).toBe(100_000);
    expect(passedCostAmount(100_000, 'percent', 1000)).toBe(110_000);
  });
});

describe('states', () => {
  it('accepted only when nothing is disputed; sending again waits for every dispute to be answered', () => {
    expect(statusAfterAnswer([{ id: 1, status: 'accepted', resolution: null }, { id: 2, status: 'removed', resolution: 'removed' }])).toBe('accepted');
    const lines = [{ id: 1, status: 'accepted' as const, resolution: null }, { id: 2, status: 'disputed' as const, resolution: null }];
    expect(statusAfterAnswer(lines)).toBe('partly_disputed');
    expect(openDisputes(lines).map((l) => l.id)).toEqual([2]);
    expect(openDisputes([{ id: 2, status: 'disputed', resolution: 'explained' }])).toEqual([]);
  });
  it('the review window: answer by sent date + review days; the next day it is over', () => {
    expect(reviewDueOn('2025-12-29', 5)).toBe('2026-01-03');
    expect(reviewOver('2026-01-03', '2026-01-03')).toBe(false);
    expect(reviewOver('2026-01-03', '2026-01-04')).toBe(true);
  });
  it('corrections: only down; after invoicing a credit of what is taken off, never more than is left', () => {
    const line = { kind: 'labour', amountMinor: 1000, creditedMinor: 0 };
    expect(correctionProblem(line, 800, false)).toBeNull();
    expect(correctionProblem(line, 1000, false)).toBe('IC_AMOUNT_NOT_LOWER');
    expect(correctionProblem({ ...line, kind: 'credit' }, 'remove', false)).toBe('IC_LINE_NOT_CORRECTABLE');
    expect(creditFor(line, 800)).toBe(200);
    expect(correctionProblem({ ...line, creditedMinor: 200 }, 800, true)).toBe('IC_AMOUNT_NOT_LOWER');
    expect(creditFor({ ...line, creditedMinor: 200 }, 'remove')).toBe(800);
    expect(correctionProblem({ ...line, creditedMinor: 1000 }, 'remove', true)).toBe('IC_ALREADY_CREDITED');
  });
});

describe('who', () => {
  const h = (personId: number) => ({ personId, current: true });
  const p: StatementPeople = { providerHead: h(1), receiverHead: h(2), providerApprover: h(3), receiverApprover: h(4), departmentHeadIds: [5] };
  it('sees: heads, approvers, department heads with time on it, the CEO', () => {
    for (const id of [1, 2, 3, 4, 5]) expect(canSeeStatement({ personId: id, seesAll: false }, p)).toBe(true);
    expect(canSeeStatement({ personId: 6, seesAll: false }, p)).toBe(false);
    expect(canSeeStatement({ personId: 6, seesAll: true }, p)).toBe(true);
  });
  it('approves: a department head or the CEO, never whoever prepared it', () => {
    expect(approveProblem({ personId: 5, managesAll: false }, p, 1)).toBeNull();
    expect(approveProblem({ personId: 9, managesAll: true }, p, 1)).toBeNull();
    expect(approveProblem({ personId: 9, managesAll: true }, p, 9)).toBe('IC_SELF_APPROVAL');
    expect(approveProblem({ personId: 1, managesAll: false }, p, 9)).toBe('IC_NOT_APPROVER');
  });
  it('answers: the receiver\'s head or approver only', () => {
    expect([1, 2, 3, 4, 5].map((id) => canAnswer(id, p))).toEqual([false, true, false, true, false]);
  });
});
