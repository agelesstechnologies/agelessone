import { describe, expect, it } from 'vitest';
import { lockedMessage, secondsLocked, throttleKey, throttleSettings } from './throttle';

describe('sign-in throttling rules', () => {
  it('settings default to 5 per account, 30 per IP, 15-minute window and lockout; .env overrides them', () => {
    expect(throttleSettings({})).toEqual({ maxPerLogin: 5, maxPerIp: 30, windowMs: 900_000, lockoutMs: 900_000 });
    expect(throttleSettings({ LOGIN_MAX_FAILURES: '3', LOGIN_MAX_FAILURES_PER_IP: '10', LOGIN_WINDOW_MINUTES: '5', LOGIN_LOCKOUT_MINUTES: '2' }))
      .toEqual({ maxPerLogin: 3, maxPerIp: 10, windowMs: 300_000, lockoutMs: 120_000 });
    expect(throttleSettings({ LOGIN_MAX_FAILURES: 'zero', LOGIN_LOCKOUT_MINUTES: '-1' })).toMatchObject({ maxPerLogin: 5, lockoutMs: 900_000 });
  });

  it('keys are keyed hashes: never the login or address itself; account and IP keys differ', () => {
    const k = throttleKey('login', 'demo.hr@example.com', 'secret');
    expect(k).toMatch(/^login:[0-9a-f]{64}$/);
    expect(k).not.toContain('example');
    expect(throttleKey('login', 'demo.hr@example.com', 'secret')).toBe(k);
    expect(throttleKey('login', 'demo.hr@example.com', 'other secret')).not.toBe(k);
    expect(throttleKey('ip', 'demo.hr@example.com', 'secret').slice(3)).not.toBe(k.slice(6));
  });

  it('the latest lockout in force counts; past ones do not', () => {
    const now = new Date('2026-11-06T10:00:00Z');
    expect(secondsLocked([null, new Date('2026-11-06T09:59:00Z')], now)).toBe(0);
    expect(secondsLocked([new Date('2026-11-06T10:05:00Z'), new Date('2026-11-06T10:14:59.5Z')], now)).toBe(900);
    expect(lockedMessage(900)).toBe('Too many failed sign-ins. Try again in 15 minutes.');
    expect(lockedMessage(20)).toBe('Too many failed sign-ins. Try again in 1 minute.');
  });
});
