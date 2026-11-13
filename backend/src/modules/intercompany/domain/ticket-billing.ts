/**
 * A ticket's billing to another company of the group. A ticket linked to the other company's project or design request
 * is billable to that company by default; the provider's department head may set it not billable, with a reason.
 */
export interface TicketBillingState {
  billableToCompanyId: number; billable: boolean; notBillableReason: string | null;
  /** what the time is billed as (rate card line); null only on links made before service types were asked */
  serviceType: string | null;
}

/**
 * Billing after linking a ticket (of ticketCompanyId) to work of linkedCompanyId, billed as serviceType. Another company:
 * billable to it by default — linking again to the same company keeps the decision already taken. The ticket's own
 * company: nothing to bill.
 */
export function billingAfterLink(current: TicketBillingState | null, ticketCompanyId: number, linkedCompanyId: number, serviceType: string): TicketBillingState | 'SAME_COMPANY' {
  if (linkedCompanyId === ticketCompanyId) return 'SAME_COMPANY';
  if (current && current.billableToCompanyId === linkedCompanyId) return { ...current, serviceType };
  return { billableToCompanyId: linkedCompanyId, billable: true, notBillableReason: null, serviceType };
}

/** The amount billed could change: another company, billable turned on or off, or another service type (another rate). */
export function billingChanged(before: TicketBillingState | null, after: TicketBillingState): boolean {
  if (!before) return after.billable;
  return before.billableToCompanyId !== after.billableToCompanyId || before.billable !== after.billable || before.serviceType !== after.serviceType;
}
