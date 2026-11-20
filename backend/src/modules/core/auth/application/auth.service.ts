import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import {
  ChangePasswordRequest, CodeSent, CompleteFirstLoginRequest, ForgotPasswordRequest, ForgotPasswordResponse, LoginRequest, LoginResponse, MachineTokenRequest, MachineTokenResponse, Me,
  ResetWithCodeRequest,
} from '@ageless/shared';
import { mailFailure, maskEmail, sendMail } from '../../../../platform/mailer';
import { sendSms, showCodesInApp } from '../../../../platform/sms';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext } from '../../../../platform/http/request-context';
import { requireEnv, todayIst } from '../../../../platform/time';
import { CoreFacade } from '../../core.facade';
import { AuthRepository } from '../infrastructure/auth.repository';
import { issuedAfterPasswordChange, parseLogin, widestScopes } from '../domain/login';
import { lockedMessage, secondsLocked, throttleKey, throttleSettings } from '../domain/throttle';
import { CODE_TTL_MS, codeProblem, hashCode, MAX_CODES_PER_HOUR, newCode, sameHash } from '../domain/codes';

export const BCRYPT_ROUNDS = 10;
/** A person's token has sub (the login); a machine's has mid (the credential) instead. */
interface TokenPayload { sub?: string; mid?: string; tid: number; iat: number }
/** Machine tokens are short: the connector signs in again when one ends. */
const MACHINE_TOKEN_SECONDS = 15 * 60;
type UserRow = NonNullable<Awaited<ReturnType<AuthRepository['findUser']>>>;

/** Sign-in with a phone or email, the token check on every request, and password changes. */
@Injectable()
export class AuthService {
  private dummyHash?: Promise<string>;
  private readonly logger = new Logger('AuthService');

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

  /**
   * The Tally connector signs in with its client id and secret. Same answer for an unknown client, a wrong secret and a revoked
   * credential. Failures are throttled per client and per IP like person sign-ins (429 AUTH_LOCKED).
   */
  async machineToken(req: MachineTokenRequest, ip: string | undefined): Promise<MachineTokenResponse> {
    const s = throttleSettings();
    const secret = requireEnv('JWT_SECRET');
    const clientKey = throttleKey('machine', req.clientId, secret);
    const ipKey = throttleKey('ip', ip ?? 'unknown', secret);
    const now = new Date();
    const locked = secondsLocked(await this.repo.lockouts([clientKey, ipKey]), now);
    if (locked > 0) throw this.lockedError(locked);

    const cred = await this.repo.findMachineByClientId(req.clientId);
    const matches = await bcrypt.compare(req.secret, cred?.secretHash ?? await this.dummy());
    if (!cred || !matches || !cred.isActive) {
      const until = [
        await this.repo.recordFailure(clientKey, now, s.maxPerLogin, s.windowMs, s.lockoutMs),
        await this.repo.recordFailure(ipKey, now, s.maxPerIp, s.windowMs, s.lockoutMs),
      ];
      const lockedNow = secondsLocked(until, now);
      if (lockedNow > 0) throw this.lockedError(lockedNow);
      throw new AppError('AUTH_FAILED', 401, 'Wrong client id or secret');
    }
    await this.repo.clearThrottle([clientKey]);
    await this.repo.markMachineUsed(cred.id);
    const token = await this.jwt.signAsync({ mid: cred.publicId, tid: cred.tenantId }, { expiresIn: MACHINE_TOKEN_SECONDS });
    return { token, expiresAt: new Date(Date.now() + MACHINE_TOKEN_SECONDS * 1000).toISOString() };
  }

  /** Called by the guard for every request: a valid token for a usable login, plus today's permissions. */
  async authenticate(token: string): Promise<RequestContext> {
    let payload: TokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenPayload>(token);
    } catch (err) {
      if ((err as Error).name === 'TokenExpiredError') throw new AppError('AUTH_EXPIRED', 401, 'Your sign-in has expired; sign in again');
      throw new AppError('AUTH_INVALID', 401, 'Your session has ended. Please sign in again.');
    }
    if (payload.mid) return this.authenticateMachine(payload.tid, payload.mid);
    const user = await this.repo.findUser(payload.tid, payload.sub ?? '');
    if (!user || !this.mayUse(user) || !issuedAfterPasswordChange(payload.iat, user.passwordChangedAt)) {
      throw new AppError('AUTH_INVALID', 401, 'Your session has ended. Please sign in again.');
    }
    const grants = await this.repo.grantsInForce(user.tenantId, user.personId, todayIst());
    return {
      tenantId: user.tenantId, personId: user.personId, personPublicId: user.personPublicId,
      userPublicId: user.publicId, permissions: widestScopes(grants), mustChangePassword: user.mustChangePassword,
    };
  }

  /** A machine token is good only while its credential exists in that tenant and has not been revoked. */
  private async authenticateMachine(tenantId: number, publicId: string): Promise<RequestContext> {
    const cred = await this.repo.findMachine(tenantId, publicId);
    if (!cred || !cred.isActive) throw new AppError('AUTH_INVALID', 401, 'This credential is no longer valid.');
    return {
      tenantId: cred.tenantId, personId: 0, personPublicId: '', userPublicId: '', permissions: { [cred.permission]: 'all' },
      machine: { credentialId: cred.id, publicId: cred.publicId, name: cred.name, permission: cred.permission },
    };
  }

  async me(ctx: RequestContext): Promise<Me> {
    const user = await this.repo.findUser(ctx.tenantId, ctx.userPublicId);
    if (!user) throw new AppError('AUTH_INVALID', 401, 'Your session has ended. Please sign in again.');
    return {
      person: { publicId: user.personPublicId, displayName: user.personName },
      user: { publicId: user.publicId, loginPhone: user.loginPhone, loginEmail: user.loginEmail, mustChangePassword: user.mustChangePassword },
      roles: await this.repo.rolesInForce(ctx.tenantId, ctx.personId, todayIst()),
      permissions: ctx.permissions,
    };
  }

  /** Every older token stops working; the answer is a fresh token so the caller stays signed in. */
  async changePassword(ctx: RequestContext, req: ChangePasswordRequest): Promise<LoginResponse> {
    const user = await this.repo.findUser(ctx.tenantId, ctx.userPublicId);
    if (!user) throw new AppError('AUTH_INVALID', 401, 'Your session has ended. Please sign in again.');
    if (!(await bcrypt.compare(req.currentPassword, user.passwordHash))) {
      throw new AppError('AUTH_WRONG_PASSWORD', 400, 'The current password is not correct');
    }
    await this.repo.setPassword(user.id, await bcrypt.hash(req.newPassword, BCRYPT_ROUNDS));
    return this.issueToken(user);
  }

  // ---- first sign-in and forgot password: 6-digit codes sent by email ----

  /** First sign-in: send a code to the login email and phone. Only while the password is still the one someone else chose. */
  async sendFirstLoginCode(ctx: RequestContext): Promise<CodeSent> {
    const user = await this.signedInUser(ctx);
    if (!user.mustChangePassword) throw new AppError('AUTH_SETUP_DONE', 409, 'Your password is already your own');
    if (!user.loginEmail && !user.loginPhone) throw new AppError('AUTH_NO_EMAIL', 400, 'This login has no email or phone; set your password without a code');
    return this.sendCode(user, 'first_login');
  }

  /**
   * First sign-in: the code (sent to the login email and phone) and the person's own password. Older tokens stop working;
   * the answer is a fresh token.
   */
  async completeFirstLogin(ctx: RequestContext, req: CompleteFirstLoginRequest): Promise<LoginResponse> {
    const user = await this.signedInUser(ctx);
    if (!user.mustChangePassword) throw new AppError('AUTH_SETUP_DONE', 409, 'Your password is already your own');
    if (await bcrypt.compare(req.newPassword, user.passwordHash)) {
      throw new AppError('AUTH_SAME_PASSWORD', 400, 'Choose a new password, not the one you were given');
    }
    if (user.loginEmail || user.loginPhone) await this.useCode(user, 'first_login', req.code);
    await this.repo.setPassword(user.id, await bcrypt.hash(req.newPassword, BCRYPT_ROUNDS));
    return this.issueToken(user);
  }

  /**
   * First time or forgot password: a code goes to the login's email and phone when the login exists and may be used.
   * The answer is the same in every case, so nobody can find out which logins exist.
   */
  async forgotPassword(req: ForgotPasswordRequest): Promise<ForgotPasswordResponse> {
    const message = 'If this login exists, a 6-digit code is on its way to its email and phone. It works for 10 minutes.';
    let login: ReturnType<typeof parseLogin>;
    try { login = parseLogin(req.login); } catch { return { message }; }
    const user = await this.repo.findUserByLogin(login);
    if (user && this.mayUse(user)) {
      try {
        const sent = await this.sendCode(user, 'reset');
        if (sent.devCode) return { message, devCode: sent.devCode };   // development only (DEV_SHOW_CODES)
      } catch (err) { if (!(err instanceof AppError)) throw err; }     // limits: same answer
    }
    return { message };
  }

  /** Forgot password: the code and a new password. Also lifts a sign-in lockout of the login; answers a token. */
  async resetWithCode(req: ResetWithCodeRequest): Promise<LoginResponse> {
    let login: ReturnType<typeof parseLogin>;
    try { login = parseLogin(req.login); } catch { throw this.wrongCode(); }
    const user = await this.repo.findUserByLogin(login);
    if (!user || !this.mayUse(user)) throw this.wrongCode();
    await this.useCode(user, 'reset', req.code);
    await this.repo.setPassword(user.id, await bcrypt.hash(req.newPassword, BCRYPT_ROUNDS));
    const secret = requireEnv('JWT_SECRET');
    await this.repo.clearThrottle([user.loginPhone, user.loginEmail].filter((v): v is string => v !== null).map((v) => throttleKey('login', v, secret)));
    return this.issueToken(user);
  }

  private async signedInUser(ctx: RequestContext): Promise<UserRow> {
    const user = await this.repo.findUser(ctx.tenantId, ctx.userPublicId);
    if (!user) throw new AppError('AUTH_INVALID', 401, 'Your session has ended. Please sign in again.');
    return user;
  }

  /**
   * A new code replaces older ones of the same purpose (only the newest is checked). At most 3 an hour per login. Sent by
   * email and by SMS / WhatsApp, to whichever the login has; a failed one is logged and the other is enough. When none could
   * be sent: 503 AUTH_CODE_NOT_SENT. With DEV_SHOW_CODES (development only) the answer carries the code.
   */
  private async sendCode(user: UserRow, purpose: 'first_login' | 'reset'): Promise<CodeSent> {
    const now = new Date();
    if (await this.repo.codesSentSince(user.id, new Date(now.getTime() - 3_600_000)) >= MAX_CODES_PER_HOUR) {
      throw new AppError('AUTH_CODE_LIMIT', 429, 'Too many codes asked for; try again in an hour');
    }
    const code = newCode();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    await this.repo.insertCode({ tenantId: user.tenantId, userId: user.id, purpose, codeHash: hashCode(code, user.publicId, requireEnv('JWT_SECRET')), expiresAt });
    const what = purpose === 'first_login' ? 'finish setting up your Ageless sign-in' : 'set your Ageless password';
    const sentTo: string[] = [];
    if (user.loginEmail) {
      try {
        await sendMail({
          to: user.loginEmail, subject: `Your Ageless code: ${code}`,
          text: `Hello ${user.personName},\n\nUse this code to ${what}:\n\n    ${code}\n\nIt works for 10 minutes. If you did not ask for it, `
            + 'ignore this email and tell HR.\n\nAgeless People Platform',
        });
        sentTo.push(maskEmail(user.loginEmail));
      } catch (err) {
        this.logger.warn(`Sign-in code email not sent (login ${user.publicId}): ${mailFailure(err)}`);   // never the server's text: it can hold the address
      }
    }
    if (user.loginPhone) {
      try {
        await sendSms({ to: user.loginPhone, text: `${code} is your Ageless code to ${what}. Valid 10 minutes. Do not share it.`, code });
        sentTo.push(`the phone ending ${user.loginPhone.replace(/\D/g, '').slice(-4)}`);
      } catch (err) {
        this.logger.warn(`Sign-in code message not sent (login ${user.publicId}): ${(err as Error).message}`);
      }
    }
    // one way that worked is enough; with none the person must know (the code row stays, unused, and expires)
    if (sentTo.length === 0) throw new AppError('AUTH_CODE_NOT_SENT', 503, 'Could not send the code right now; try again in a few minutes or ask HR');
    return { sentTo: sentTo.join(' and '), expiresAt: expiresAt.toISOString(), ...(showCodesInApp() && { devCode: code }) };
  }

  /** Checks the newest code; a wrong one counts a try. Used once. */
  private async useCode(user: UserRow, purpose: 'first_login' | 'reset', code: string | undefined): Promise<void> {
    const row = await this.repo.latestCode(user.id, purpose);
    const problem = codeProblem(row, new Date());
    if (problem === 'missing' || problem === 'used') throw new AppError('AUTH_CODE_NEEDED', 400, 'Ask for a sign-in code first (Send code), then enter it here.');
    if (problem === 'expired') throw new AppError('AUTH_CODE_EXPIRED', 400, 'This code has expired (codes last 10 minutes). Ask for a new one.');
    if (problem === 'too_many_tries') throw new AppError('AUTH_CODE_TOO_MANY_TRIES', 400, 'Too many wrong codes; ask for a new one');
    if (!code || !sameHash(row!.codeHash, hashCode(code, user.publicId, requireEnv('JWT_SECRET')))) {
      await this.repo.countWrongTry(row!.id);
      throw this.wrongCode();
    }
    await this.repo.useCode(row!.id);
  }

  private wrongCode(): AppError {
    return new AppError('AUTH_CODE_INVALID', 400, 'That code is not right. Check the 6 digits, or ask for a new code.');
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
