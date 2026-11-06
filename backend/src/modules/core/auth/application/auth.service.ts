import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { ChangePasswordRequest, LoginRequest, LoginResponse, Me } from '@ageless/shared';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext } from '../../../../platform/http/request-context';
import { requireEnv, todayIst } from '../../../../platform/time';
import { CoreFacade } from '../../core.facade';
import { AuthRepository } from '../infrastructure/auth.repository';
import { issuedAfterPasswordChange, parseLogin, widestScopes } from '../domain/login';
import { lockedMessage, secondsLocked, throttleKey, throttleSettings } from '../domain/throttle';

export const BCRYPT_ROUNDS = 10;
interface TokenPayload { sub: string; tid: number; iat: number }
type UserRow = NonNullable<Awaited<ReturnType<AuthRepository['findUser']>>>;

/** Sign-in with a phone or email, the token check on every request, and password changes. */
@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(AuthRepository) private readonly repo: AuthRepository,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /**
   * Same answer for unknown login, wrong password, or a login that may no longer be used. Failed sign-ins are counted per
   * account and per IP address; too many in the window lock that account / IP briefly (429 AUTH_LOCKED, Retry-After),
   * even with the right password, and unknown logins lock the same way (nothing tells whether an account exists).
   */
  async login(req: LoginRequest, ip: string | undefined): Promise<LoginResponse> {
    const s = throttleSettings();
    const login = parseLogin(req.login);
    const secret = requireEnv('JWT_SECRET');
    const loginKey = throttleKey('login', 'email' in login ? login.email : login.phone, secret);
    const ipKey = throttleKey('ip', ip ?? 'unknown', secret);
    const now = new Date();
    const locked = secondsLocked(await this.repo.lockouts([loginKey, ipKey]), now);
    if (locked > 0) throw this.lockedError(locked);

    const user = await this.repo.findUserByLogin(login);
    // compare against a dummy hash when there is no user, so both cases take the same time
    const matches = await bcrypt.compare(req.password, user?.passwordHash ?? await this.dummy());
    if (!user || !matches || !this.mayUse(user)) {
      const until = [
        await this.repo.recordFailure(loginKey, now, s.maxPerLogin, s.windowMs, s.lockoutMs),
        await this.repo.recordFailure(ipKey, now, s.maxPerIp, s.windowMs, s.lockoutMs),
      ];
      await this.repo.forgetOldThrottles(new Date(now.getTime() - 24 * 3_600_000), now);
      const lockedNow = secondsLocked(until, now);
      if (lockedNow > 0) throw this.lockedError(lockedNow);
      throw new AppError('AUTH_FAILED', 401, 'Wrong login or password');
    }
    await this.repo.clearThrottle([loginKey]); // the IP count stays: signing in to your own account does not reset it
    await this.repo.markLoggedIn(user.id);
    return this.issueToken(user);
  }

  private lockedError(seconds: number): AppError {
    return new AppError('AUTH_LOCKED', 429, lockedMessage(seconds), { retryAfterSeconds: seconds });
  }

  /** Called by the guard for every request: a valid token for a usable login, plus today's permissions. */
  async authenticate(token: string): Promise<RequestContext> {
    let payload: TokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenPayload>(token);
    } catch (err) {
      if ((err as Error).name === 'TokenExpiredError') throw new AppError('AUTH_EXPIRED', 401, 'Your sign-in has expired; sign in again');
      throw new AppError('AUTH_INVALID', 401, 'Sign in again');
    }
    const user = await this.repo.findUser(payload.tid, payload.sub);
    if (!user || !this.mayUse(user) || !issuedAfterPasswordChange(payload.iat, user.passwordChangedAt)) {
      throw new AppError('AUTH_INVALID', 401, 'Sign in again');
    }
    const grants = await this.repo.grantsInForce(user.tenantId, user.personId, todayIst());
    return {
      tenantId: user.tenantId, personId: user.personId, personPublicId: user.personPublicId,
      userPublicId: user.publicId, permissions: widestScopes(grants),
    };
  }

  async me(ctx: RequestContext): Promise<Me> {
    const user = await this.repo.findUser(ctx.tenantId, ctx.userPublicId);
    if (!user) throw new AppError('AUTH_INVALID', 401, 'Sign in again');
    return {
      person: { publicId: user.personPublicId, displayName: user.personName },
      user: { publicId: user.publicId, loginPhone: user.loginPhone, loginEmail: user.loginEmail },
      roles: await this.repo.rolesInForce(ctx.tenantId, ctx.personId, todayIst()),
      permissions: ctx.permissions,
    };
  }

  /** Every older token stops working; the answer is a fresh token so the caller stays signed in. */
  async changePassword(ctx: RequestContext, req: ChangePasswordRequest): Promise<LoginResponse> {
    const user = await this.repo.findUser(ctx.tenantId, ctx.userPublicId);
    if (!user) throw new AppError('AUTH_INVALID', 401, 'Sign in again');
    if (!(await bcrypt.compare(req.currentPassword, user.passwordHash))) {
      throw new AppError('AUTH_WRONG_PASSWORD', 400, 'The current password is not correct');
    }
    await this.repo.setPassword(user.id, await bcrypt.hash(req.newPassword, BCRYPT_ROUNDS));
    return this.issueToken(user);
  }

  /** A login works only while it is active and the person is active (an inactive person has no active job). */
  private mayUse(user: UserRow): boolean {
    return user.isActive && user.personStatus === 'active';
  }

  private async issueToken(user: UserRow): Promise<LoginResponse> {
    const hours = await this.core.getPolicy(user.tenantId, 'core.auth.session_hours', null, todayIst());
    const token = await this.jwt.signAsync({ sub: user.publicId, tid: user.tenantId }, { expiresIn: hours * 3600 });
    return { token, expiresAt: new Date(Date.now() + hours * 3600 * 1000).toISOString() };
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= bcrypt.hash('no-such-user', BCRYPT_ROUNDS);
    return this.dummyHash;
  }
}
