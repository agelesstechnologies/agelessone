import { calculateLeaveDays, FromHalf, ToHalf } from '../leave-days';

export type LeaveStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled';
export type LeaveAction = 'approve' | 'reject' | 'cancel';

/**
 * The leave's days per calendar year (a leave from 30 Dec to 4 Jan takes from two years' balances).
 * Years with no working day are left out. The parts add up to calculateLeaveDays for the whole range.
 */
export function daysPerYear(from: string, to: string, fromHalf: FromHalf, toHalf: ToHalf, daysOff: string[]): { year: number; days: number }[] {
  const out: { year: number; days: number }[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    const start = year === Number(from.slice(0, 4)) ? from : `${year}-01-01`;
    const end = year === Number(to.slice(0, 4)) ? to : `${year}-12-31`;
    const days = calculateLeaveDays(start, end, start === from ? fromHalf : 'full', end === to ? toHalf : 'full', daysOff);
    if (days > 0) out.push({ year, days });
  }
  return out;
}

/**
 * Makes the yearly parts add up to the days saved on the request (the calendar may have changed since applying):
 * the difference goes to the last year; a part left at zero or below is dropped.
 */
export function fitToTotal(parts: { year: number; days: number }[], total: number): { year: number; days: number }[] {
  if (parts.length === 0) return [];
  const diff = total - parts.reduce((sum, p) => sum + p.days, 0);
  return parts.map((p, i) => (i === parts.length - 1 ? { ...p, days: p.days + diff } : p)).filter((p) => p.days > 0);
}

/** How much of `date` the leave covers: the whole day, half of it, or none. */
export function leaveOn(r: { fromDate: string; toDate: string; fromHalf: string; toHalf: string }, date: string): 'full' | 'half' | null {
  if (date < r.fromDate || date > r.toDate) return null;
  if ((date === r.fromDate && r.fromHalf === 'second_half') || (date === r.toDate && r.toHalf === 'first_half')) return 'half';
  return 'full';
}

/** With the balance check on (company policy), leave may not take the balance below zero. */
export function balanceAllows(balance: number, days: number, checkOn: boolean): boolean {
  return !checkOn || balance - days >= 0;
}

/** Why a step is not allowed from this status, or null when it is. */
export function stepNotAllowed(status: LeaveStatus, action: LeaveAction): 'HRMS_LEAVE_NOT_PENDING' | 'HRMS_LEAVE_CLOSED' | null {
  if (action === 'cancel') return status === 'submitted' || status === 'approved' || status === 'draft' ? null : 'HRMS_LEAVE_CLOSED';
  return status === 'submitted' ? null : 'HRMS_LEAVE_NOT_PENDING';
}
