import { describe, expect, it } from 'vitest';
import { billingAfterLink, billingChanged } from './ticket-billing';

const ATPL = 2;
const AE = 1;

describe('billable default from the link', () => {
  it('a ticket linked to the other company\'s project or design request is billable to that company', () => {
    expect(billingAfterLink(null, ATPL, AE, 'design')).toEqual({ billableToCompanyId: AE, billable: true, notBillableReason: null, serviceType: 'design' });
  });
  it('linked to its own company\'s work: nothing to bill', () => {
    expect(billingAfterLink(null, ATPL, ATPL, 'design')).toBe('SAME_COMPANY');
  });
  it('linked again to the same company: the head\'s decision is kept; another company starts again as billable', () => {
    const notBillable = { billableToCompanyId: AE, billable: false, notBillableReason: 'Warranty work', serviceType: 'design' };
    expect(billingAfterLink(notBillable, ATPL, AE, 'cgi')).toEqual({ ...notBillable, serviceType: 'cgi' });
    expect(billingAfterLink(notBillable, ATPL, 3, 'design')).toEqual({ billableToCompanyId: 3, billable: true, notBillableReason: null, serviceType: 'design' });
  });
  it('what changes the billed amount', () => {
    const billable = { billableToCompanyId: AE, billable: true, notBillableReason: null, serviceType: 'design' };
    expect(billingChanged(null, billable)).toBe(true);
    expect(billingChanged(billable, { ...billable })).toBe(false);
    expect(billingChanged(billable, { ...billable, billable: false, notBillableReason: 'Rework' })).toBe(true);
    expect(billingChanged(billable, { ...billable, serviceType: 'software' })).toBe(true);
    expect(billingChanged({ ...billable, billable: false, notBillableReason: 'a' }, { ...billable, billable: false, notBillableReason: 'b' })).toBe(false);
  });
});
