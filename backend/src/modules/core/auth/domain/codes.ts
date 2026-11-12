import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** A sign-in code lasts 10 minutes, allows 5 wrong tries, and at most 3 are sent per login per hour. */
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 3;

/** Six random digits, e.g. "048213". */
export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** What is stored instead of the code: a keyed hash (HMAC-SHA256 with JWT_SECRET), tied to the login. */
export function hashCode(code: string, userPublicId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${userPublicId}:${code.trim()}`).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export type CodeProblem = 'none' | 'used' | 'expired' | 'too_many_tries';

/** Why the latest code can no longer be used ('none' = it still can). Pure. */
export function codeProblem(row: { expiresAt: Date; attempts: number; usedAt: Date | null } | undefined, now: Date): CodeProblem | 'missing' {
  if (!row) return 'missing';
  if (row.usedAt) return 'used';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (row.attempts >= MAX_ATTEMPTS) return 'too_many_tries';
  return 'none';
}
