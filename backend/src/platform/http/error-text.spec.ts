import { describe, expect, it } from 'vitest';
import { fieldLabel, issuesText } from '@ageless/shared';

describe('plain field names and messages', () => {
  it('turns API field names into words', () => {
    expect(fieldLabel(['employmentPublicId'])).toBe('Employment');
    expect(fieldLabel(['amountPaise'])).toBe('Amount');
    expect(fieldLabel(['approvedAmountPaise'])).toBe('Approved amount');
    expect(fieldLabel(['monthlyPaise'])).toBe('Monthly amount');
    expect(fieldLabel(['items', 0, 'ticketPublicId'])).toBe('Item 1 ticket');
    expect(fieldLabel([])).toBe('Value');
  });

  it('one message per field, at most three, then "and N more"', () => {
    const issues = [
      { path: ['spentOn'], message: 'Use YYYY-MM-DD' }, { path: ['spentOn'], message: 'Not a real date' },
      { path: ['amountPaise'], message: 'Amount must be more than 0' }, { path: ['a'], message: 'A is required' },
      { path: ['b'], message: 'B is required' },
    ];
    expect(issuesText(issues)).toBe('Spent on: Use YYYY-MM-DD. Amount must be more than 0. A is required. And 1 more.');
  });
});
