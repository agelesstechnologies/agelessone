import { describe, it, expect } from 'vitest';
import { isValidExitDate, pickNextPrimary } from './employments';

describe('isValidExitDate', () => {
  it('same day or later is fine', () => {
    expect(isValidExitDate('2026-01-05', '2026-01-05')).toBe(true);
    expect(isValidExitDate('2026-01-05', '2026-03-31')).toBe(true);
  });
  it('before joining is refused', () => expect(isValidExitDate('2026-01-05', '2025-12-31')).toBe(false));
});

describe('pickNextPrimary', () => {
  it('latest joined wins', () => expect(pickNextPrimary([{ id: 1, joinedOn: '2025-04-01' }, { id: 2, joinedOn: '2026-01-05' }])).toBe(2));
  it('same day: the newer record wins', () => expect(pickNextPrimary([{ id: 7, joinedOn: '2026-01-05' }, { id: 3, joinedOn: '2026-01-05' }])).toBe(7));
  it('nothing left: no primary', () => expect(pickNextPrimary([])).toBeUndefined());
});
