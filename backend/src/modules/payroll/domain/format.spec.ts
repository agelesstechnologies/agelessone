import { describe, expect, it } from 'vitest';
import { inr, maskAccount, monthName } from './format';

describe('format', () => {
  it('rupees with Indian grouping', () => {
    expect([inr(123456789), inr(2_800_000), inr(99_900), inr(5), inr(-250)]).toEqual(['INR 12,34,567.89', 'INR 28,000.00', 'INR 999.00', 'INR 0.05', '-INR 2.50']);
  });
  it('month names and masked account numbers', () => {
    expect(monthName(2025, 11)).toBe('November 2025');
    expect(maskAccount('123456789012')).toBe('XXXXXXXX9012');
  });
});
