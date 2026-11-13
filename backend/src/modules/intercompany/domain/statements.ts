/**
 * Monthly statements: how a month's billable ticket time becomes priced lines, the statement's states, and who may act.
 * Money is integer minor units (paise); percentages are basis points (12.5 % = 1250) so nothing is a float.
 */
import { Head } from './agreements';
import { rateInForce } from './rates';

// ---- pricing ----

/** One person's time on one billable ticket on one work date (allocated time plus the heads' adjustments). */
export interface TimeEntry {
  ticketId: number; employmentId: number; workDate: string; minutes: number;
  serviceType: string; projectKind: string; projectPublicId: string;
  /** the job's designation: the grade a grade rate is for */
  designation: string | null;
}
export interface RateCardRow { serviceType: string | null; grade: string | null; rateMinor: number; effectiveFrom: string }
export interface SalaryRow { employmentId: number; monthlyMinor: number; effectiveFrom: string }
export interface Pricing {
  method: 'rate_card' | 'cost_plus';
  /** cost_plus: the percentage added to cost, in basis points */
  costPlusBp: number | null;
  /** policy intercompany.cost.hours_per_month: a monthly salary ÷ this = cost per hour */
  hoursPerMonth: number;
}

export interface LabourLine {
  projectKind: string; projectPublicId: string; serviceType: string; employmentId: number;
  /** set when the rate is a grade's */
  grade: string | null;
  minutes: number; rateMinor: number; amountMinor: number;
  /** null: no salary in payroll for some of the time */
  costPerHourMinor: number | null; costMinor: number | null;
  /** ticket id → minutes */
  tickets: Map<number, number>;
}

/** hours × rate, in minor units, rounded to the nearest. */
export const amountFor = (minutes: number, ratePerHourMinor: number): number => Math.round((minutes * ratePerHourMinor) / 60);
/** An amount with a percentage (basis points) on top. */
export const withPercent = (amountMinor: number, bp: number): number => Math.round((amountMinor * (10_000 + bp)) / 10_000);
/** "12.50" (numeric column) → 1250 basis points. */
export const toBasisPoints = (percent: string | number): number => Math.round(Number(percent) * 100);

/** The salary in force on a date: the newest row starting on or before it. */
export function salaryOn(rows: SalaryRow[], employmentId: number, date: string): number | undefined {
  let best: SalaryRow | undefined;
  for (const r of rows) if (r.employmentId === employmentId && r.effectiveFrom <= date && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  return best?.monthlyMinor;
}
export const costPerHour = (monthlyMinor: number, hoursPerMonth: number): number => Math.round(monthlyMinor / hoursPerMonth);

export interface Missing { rates: { serviceType: string; date: string }[]; costs: { employmentId: number; date: string }[] }

/**
 * Prices a month's time, line by line: one line per project, service type, person, grade and rate. Rate card: the grade
 * rate for the person's designation in force on each date, else the service type's (CA TO CONFIRM). Cost plus: the
 * person's cost per hour on each date (salary ÷ hours per month) plus the percentage. Amount = the line's hours × rate.
 * What cannot be priced is listed in `missing` (no rate; cost plus without a salary).
 */
export function priceLabour(entries: TimeEntry[], cards: RateCardRow[], salaries: SalaryRow[], pricing: Pricing): { lines: LabourLine[]; missing: Missing } {
  const missing: Missing = { rates: [], costs: [] };
  const groups = new Map<string, { line: Omit<LabourLine, 'amountMinor' | 'costPerHourMinor' | 'costMinor'>; cost: number; costKnown: boolean }>();
  for (const e of entries) {
    if (e.minutes <= 0) continue;
    const salary = salaryOn(salaries, e.employmentId, e.workDate);
    const cph = salary === undefined ? null : costPerHour(salary, pricing.hoursPerMonth);
    let rate: number;
    let grade: string | null = null;
    if (pricing.method === 'cost_plus') {
      if (cph === null) { missing.costs.push({ employmentId: e.employmentId, date: e.workDate }); continue; }
      rate = withPercent(cph, pricing.costPlusBp ?? 0);
    } else {
      const gradeCards = e.designation ? cards.filter((c) => c.grade !== null && c.grade.toLowerCase() === e.designation!.toLowerCase()) : [];
      const byGrade = gradeCards.length ? rateInForce(gradeCards, { grade: gradeCards[0].grade }, e.workDate) : undefined;
      const card = byGrade ?? rateInForce(cards, { serviceType: e.serviceType }, e.workDate);
      if (!card) { missing.rates.push({ serviceType: e.serviceType, date: e.workDate }); continue; }
      rate = card.rateMinor;
      grade = byGrade ? byGrade.grade : null;
    }
    const key = [e.projectKind, e.projectPublicId, e.serviceType, e.employmentId, grade ?? '', rate].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { line: { projectKind: e.projectKind, projectPublicId: e.projectPublicId, serviceType: e.serviceType, employmentId: e.employmentId,
        grade, minutes: 0, rateMinor: rate, tickets: new Map() }, cost: 0, costKnown: true };
      groups.set(key, g);
    }
    g.line.minutes += e.minutes;
    g.line.tickets.set(e.ticketId, (g.line.tickets.get(e.ticketId) ?? 0) + e.minutes);
    if (cph === null) g.costKnown = false;
    else g.cost += (e.minutes * cph) / 60;
  }
  const lines = [...groups.values()].map(({ line, cost, costKnown }) => {
    const costMinor = costKnown ? Math.round(cost) : null;
    return { ...line, amountMinor: amountFor(line.minutes, line.rateMinor), costMinor,
      costPerHourMinor: costMinor === null ? null : Math.round((costMinor * 60) / line.minutes) };
  });
  return { lines, missing };
}

/** A passed-on cost as billed: at cost, or with the agreement's percentage. */
export const passedCostAmount = (amountMinor: number, handling: 'at_cost' | 'percent', bp: number | null): number =>
  handling === 'percent' ? withPercent(amountMinor, bp ?? 0) : amountMinor;

// ---- states ----

export type StatementStatus = 'draft' | 'approved_by_provider' | 'sent' | 'partly_disputed' | 'accepted' | 'invoiced' | 'closed';
export type LineStatus = 'pending' | 'accepted' | 'disputed' | 'removed';
export interface LineState { id: number; status: LineStatus; resolution: string | null }

/** After the receiver's answer: accepted when no line is disputed, else partly disputed. */
export const statusAfterAnswer = (lines: LineState[]): 'accepted' | 'partly_disputed' =>
  lines.some((l) => l.status === 'disputed') ? 'partly_disputed' : 'accepted';

/** Disputed lines the provider has not yet corrected, removed or explained (sending again waits for them). */
export const openDisputes = (lines: LineState[]): LineState[] => lines.filter((l) => l.status === 'disputed' && l.resolution === null);

/** The review window: the receiver answers by sent date + review days; the day after, no answer means accepted. */
export const reviewDueOn = (sentOn: string, reviewDays: number): string => {
  const d = new Date(`${sentOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + reviewDays);
  return d.toISOString().slice(0, 10);
};
export const reviewOver = (dueOn: string, today: string): boolean => today > dueOn;

/**
 * Why this correction is not allowed (a code), or null. On a disputed line (statement partly disputed): the amount only
 * goes down. After invoicing: what is taken off (credit) must be more than 0 and no more than what is left after
 * earlier credits. Credit lines are never corrected.
 */
export function correctionProblem(line: { kind: string; amountMinor: number; creditedMinor: number }, newAmount: number | 'remove', invoiced: boolean):
  'IC_LINE_NOT_CORRECTABLE' | 'IC_AMOUNT_NOT_LOWER' | 'IC_ALREADY_CREDITED' | null {
  if (line.kind === 'credit') return 'IC_LINE_NOT_CORRECTABLE';
  const target = newAmount === 'remove' ? 0 : newAmount;
  if (!invoiced) return target < line.amountMinor ? null : 'IC_AMOUNT_NOT_LOWER';
  const left = line.amountMinor - line.creditedMinor;
  if (left <= 0) return 'IC_ALREADY_CREDITED';
  return target < left ? null : 'IC_AMOUNT_NOT_LOWER';
}

/** The credit for a correction after invoicing: what is left on the line minus the new amount. */
export const creditFor = (line: { amountMinor: number; creditedMinor: number }, newAmount: number | 'remove'): number =>
  line.amountMinor - line.creditedMinor - (newAmount === 'remove' ? 0 : newAmount);

// ---- who ----

export interface StatementPeople { providerHead: Head; receiverHead: Head; providerApprover: Head; receiverApprover: Head; departmentHeadIds: number[] }
const is = (h: Head, personId: number) => h.current && h.personId === personId;

/** The two heads and the two approvers on the agreement, the heads of departments with time on it, and the CEO (scope all). */
export function canSeeStatement(caller: { personId: number; seesAll: boolean }, p: StatementPeople): boolean {
  return caller.seesAll || [p.providerHead, p.receiverHead, p.providerApprover, p.receiverApprover].some((h) => is(h, caller.personId))
    || p.departmentHeadIds.includes(caller.personId);
}

/** Build, send, correct, explain, invoice and close: the provider's head, or the CEO (manage, scope all). */
export const canPrepare = (caller: { personId: number; managesAll: boolean }, p: StatementPeople): boolean =>
  caller.managesAll || is(p.providerHead, caller.personId);

/**
 * The provider's approval: a head of a department with ticket time on the statement, or the CEO — never whoever prepared
 * it last (who built or rebuilt it).
 */
export function approveProblem(caller: { personId: number; managesAll: boolean }, p: StatementPeople, preparedBy: number): 'IC_NOT_APPROVER' | 'IC_SELF_APPROVAL' | null {
  if (!caller.managesAll && !p.departmentHeadIds.includes(caller.personId)) return 'IC_NOT_APPROVER';
  if (preparedBy === caller.personId) return 'IC_SELF_APPROVAL';
  return null;
}

/** Accept or dispute: the receiver's head or approver (named on the agreement, job still held). */
export const canAnswer = (personId: number, p: StatementPeople): boolean => is(p.receiverHead, personId) || is(p.receiverApprover, personId);
