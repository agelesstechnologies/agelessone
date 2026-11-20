import { createHmac } from 'node:crypto';

/**
 * Sign-in throttling: failed sign-ins are counted per account (the login typed) and per IP address. Too many within the
 * window locks that account or IP for a short time. Settings come from backend/.env (read on every call):
 *   LOGIN_MAX_FAILURES         failures per account before a lockout (default 5)
 *   LOGIN_MAX_FAILURES_PER_IP  failures per IP address before a lockout (default 30; an office shares one address)
 *   LOGIN_WINDOW_MINUTES       how far back failures are counted (default 15)
 *   LOGIN_LOCKOUT_MINUTES      how long a lockout lasts (default 15)
 */
export interface ThrottleSettings { maxPerLogin: number; maxPerIp: number; windowMs: number; lockoutMs: number }

const positive = (value: string | undefined, fallback: number) => (Number(value) > 0 ? Number(value) : fallback);

export function throttleSettings(env: NodeJS.ProcessEnv = process.env): ThrottleSettings {
  return {
    maxPerLogin: Math.floor(positive(env.LOGIN_MAX_FAILURES, 5)),
    maxPerIp: Math.floor(positive(env.LOGIN_MAX_FAILURES_PER_IP, 30)),
    windowMs: positive(env.LOGIN_WINDOW_MINUTES, 15) * 60_000,
    lockoutMs: positive(env.LOGIN_LOCKOUT_MINUTES, 15) * 60_000,
  };
}

/**
 * The stored key for an account or an IP: a keyed hash, so the table never holds a phone number, email or IP address
 * (CLAUDE.md rule 7). The login must be in its stored form (parseLogin), so "+91 00000 00001" and "+910000000001" count together.
 */
export function throttleKey(kind: 'login' | 'ip' | 'machine', value: string, secret: string): string {
  return `${kind}:${createHmac('sha256', secret).update(`${kind}:${value}`).digest('hex')}`;
}

/** Whole seconds until the latest of these lockouts ends; 0 when none is in force. */
export function secondsLocked(lockedUntil: (Date | null)[], now: Date): number {
  const until = Math.max(0, ...lockedUntil.filter((d): d is Date => d !== null).map((d) => d.getTime()));
  return until > now.getTime() ? Math.ceil((until - now.getTime()) / 1000) : 0;
}

/** The message for a locked sign-in, in minutes (at least 1). */
export function lockedMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `Too many failed sign-ins. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}
