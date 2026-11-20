import { createHash } from 'node:crypto';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModuleOptions } from '@nestjs/throttler';
import { ThrottlerLimitDetail } from '@nestjs/throttler/dist/throttler.guard.interface';
import { AppError } from './app-error';

/**
 * Rate limiting for every route (limits are settings in backend/.env, read on each request; none is a company policy):
 *  - "user": RATE_LIMIT_PER_MIN (default 120) per signed-in person. The key is a hash of the bearer token, so people
 *    in one office (one IP address) never share a count; without a token it is the IP address.
 *  - "ip": RATE_LIMIT_IP_PER_MIN (default 600) per IP address. It stops someone who sends made-up tokens to get
 *    a new "user" count every time.
 *  - Routes that take no token and guess secrets (sign-in, codes) use LOGIN_LIMIT on "user" (RATE_LIMIT_LOGIN_PER_MIN, default 10).
 * Health routes are not counted. Counts are kept in memory: right for one API process; use a shared store for several.
 */
const MINUTE = 60_000;
const fromEnv = (name: string, fallback: number) => () => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const ipOf = (req: Record<string, any>): string => String(req.ip ?? req.socket?.remoteAddress ?? 'unknown');

function userKey(req: Record<string, any>): string {
  const header = String(req.headers?.authorization ?? '');
  const token = /^Bearer\s+(\S+)/i.exec(header)?.[1];
  return token ? `u:${createHash('sha256').update(token).digest('hex').slice(0, 32)}` : `i:${ipOf(req)}`;
}

export const RATE_LIMIT_OPTIONS: ThrottlerModuleOptions = {
  throttlers: [
    { name: 'user', ttl: MINUTE, limit: fromEnv('RATE_LIMIT_PER_MIN', 120), getTracker: userKey },
    { name: 'ip', ttl: MINUTE, limit: fromEnv('RATE_LIMIT_IP_PER_MIN', 600), getTracker: ipOf },
  ],
  skipIf: (context) => {
    const req = context.switchToHttp().getRequest<{ path?: string; url?: string }>();
    return (req.path ?? req.url ?? '').split('?')[0]!.replace(/\/$/, '').endsWith('/health');
  },
};

/** For @Throttle on routes that need no token and could be used to guess secrets. */
export const LOGIN_LIMIT = { user: { ttl: MINUTE, limit: fromEnv('RATE_LIMIT_LOGIN_PER_MIN', 10) } };

/** Answers 429 RATE_LIMITED in the usual error format, with a Retry-After header (the filter sets it from details). */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(_context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const wait = Math.max(1, Math.ceil(detail.isBlocked ? detail.timeToBlockExpire : detail.timeToExpire));
    throw new AppError('RATE_LIMITED', 429, 'Too many requests. Wait a little and try again.', { retryAfterSeconds: wait });
  }
}
