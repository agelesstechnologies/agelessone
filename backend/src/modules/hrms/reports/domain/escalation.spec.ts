import { describe, expect, it } from 'vitest';
import { waitedTooLong } from './escalation';

describe('sending a waiting request to the CEO', () => {
  it('goes once it has waited the whole number of days, not before', () => {
    expect(waitedTooLong('2026-11-01', '2026-11-05', 5)).toBe(false); // 4 days
    expect(waitedTooLong('2026-11-01', '2026-11-06', 5)).toBe(true);  // 5 days
    expect(waitedTooLong('2026-10-20', '2026-11-06', 5)).toBe(true);
  });

  it('a policy of 1 day sends yesterday\'s requests, never today\'s', () => {
    expect(waitedTooLong('2026-11-06', '2026-11-06', 1)).toBe(false);
    expect(waitedTooLong('2026-11-05', '2026-11-06', 1)).toBe(true);
  });
});
