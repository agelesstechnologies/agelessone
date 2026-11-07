import { daysBetween } from './dashboard';

/**
 * A request waiting since `submittedOn` (IST date) goes to the CEO once it has waited `afterDays` whole days
 * (policy hrms.approvals.escalate_after_days). Pure.
 */
export function waitedTooLong(submittedOn: string, today: string, afterDays: number): boolean {
  return daysBetween(submittedOn, today) >= afterDays;
}
