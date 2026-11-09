import { describe, expect, it } from 'vitest';
import { codeProblem, hashCode, MAX_ATTEMPTS, newCode, sameHash } from './codes';

const now = new Date('2026-11-09T05:00:00Z');
const later = (min: number) => new Date(now.getTime() + min * 60_000);

describe('sign-in codes', () => {
  it('six digits', () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^\d{6}$/);
  });

  it('the stored hash matches only the same code for the same login', () => {
    const h = hashCode('048213', 'user-1', 'secret');
    expect(sameHash(h, hashCode(' 048213 ', 'user-1', 'secret'))).toBe(true);
    expect(sameHash(h, hashCode('048214', 'user-1', 'secret'))).toBe(false);
    expect(sameHash(h, hashCode('048213', 'user-2', 'secret'))).toBe(false);
    expect(h).not.toContain('048213');
  });

  it('usable until used, expired or tried too often', () => {
    const fresh = { expiresAt: later(10), attempts: 0, usedAt: null };
    expect(codeProblem(fresh, now)).toBe('none');
    expect(codeProblem(undefined, now)).toBe('missing');
    expect(codeProblem({ ...fresh, usedAt: now }, now)).toBe('used');
    expect(codeProblem(fresh, later(10))).toBe('expired');
    expect(codeProblem({ ...fresh, attempts: MAX_ATTEMPTS }, now)).toBe('too_many_tries');
  });
});
