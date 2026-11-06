import { describe, expect, it } from 'vitest';
import { daysLeft, statusOn } from './certificates';

describe('certificate expiry', () => {
  it('past its date a certificate is expired; on its last day it is still valid', () => {
    expect(statusOn('verified', '2026-11-03', '2026-11-04')).toBe('expired');
    expect(statusOn('verified', '2026-11-04', '2026-11-04')).toBe('verified');
    expect(statusOn('review', null, '2026-11-04')).toBe('review');
  });
  it('days left counts whole days', () => {
    expect(daysLeft('2026-11-04', '2026-11-04')).toBe(0);
    expect(daysLeft('2026-12-04', '2026-11-04')).toBe(30);
  });
});
