import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AssignRoleRequest, CreateUserRequest, PersonAccess, ResetPasswordRequest, RoleOption } from '@ageless/shared';
import { violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext } from '../../../../platform/http/request-context';
import { requireEnv, todayIst } from '../../../../platform/time';
import { AuthRepository } from '../infrastructure/auth.repository';
import { normalizeEmail, normalizePhone } from '../domain/login';
import { BCRYPT_ROUNDS } from './auth.service';
import { sendMail } from '../../../../platform/mailer';
import { sendSms } from '../../../../platform/sms';
import { throttleKey } from '../domain/throttle';

const MANAGE = 'core.users.manage';
const TEAM = 'core.users.team';

/** Logins and roles, managed by people with core.users.manage over the whole tenant. */
@Injectable()
export class UsersService {
  private readonly logger = new Logger('UsersService');

  constructor(@Inject(AuthRepository) private readonly repo: AuthRepository) {}

  /**
   * A login with a temporary password (the person confirms an emailed code and sets their own at the first sign-in).
   * core.users.manage (scope all): for anyone. core.users.team (Supervisor, department head): only for someone in their
   * team (a job they manage, or in a department they head), never themselves; that login gets the Employee role (own).
   */
  async createUser(ctx: RequestContext, req: CreateUserRequest): Promise<{ publicId: string }> {
    const admin = ctx.permissions[MANAGE] === 'all';
    if (!admin && !ctx.permissions[TEAM]) throw new AppError('FORBIDDEN', 403, `You need the permission ${MANAGE} or ${TEAM}`);
    const personId = await this.person(ctx, req.personPublicId);
    if (!admin) {
      if (personId === ctx.personId) throw new AppError('CORE_SELF_LOGIN', 403, 'Nobody creates their own login');
      if (!(await this.repo.inTeamOf(ctx.tenantId, ctx.personId, personId))) {
        throw new AppError('CORE_NOT_YOUR_TEAM', 403, 'You can create logins only for people you manage or in a department you head');
      }
    }
    try {
      const publicId = await this.repo.insertUser({
        tenantId: ctx.tenantId, personId,
        loginPhone: req.loginPhone ? normalizePhone(req.loginPhone) : null,
        loginEmail: normalizeEmail(req.loginEmail),
        // no password given: an unguessable one nobody knows; the person sets their own with an emailed code
        passwordHash: await bcrypt.hash(req.password ?? randomBytes(24).toString('base64url'), BCRYPT_ROUNDS),
        mustChangePassword: true,
      });
      if (!admin) {
        const roleId = await this.repo.findRoleId(ctx.tenantId, 'employee');
        if (roleId) await this.repo.insertRoleAssignment({ tenantId: ctx.tenantId, personId, roleId, scope: 'own', validFrom: todayIst(), grantedBy: ctx.personId });
      }
      await this.welcome(ctx, publicId);
      return { publicId };
    } catch (err) {
      const c = violatedConstraint(err);
      if (c === 'users_person_id_unique') throw new AppError('CORE_USER_EXISTS', 409, 'This person already has a login');
      if (c === 'users_login_phone_unique' || c === 'users_login_email_unique') {
        throw new AppError('CORE_LOGIN_TAKEN', 409, 'Another login already uses this phone or email');
      }
      throw err;
    }
  }

  /** The new password ends every token the person had, and lifts a sign-in lockout of the login. */
  async resetPassword(ctx: RequestContext, userPublicId: string, req: ResetPasswordRequest): Promise<void> {
    const user = await this.repo.findUser(ctx.tenantId, userPublicId);
    if (!user) throw new AppError('CORE_USER_NOT_FOUND', 404, 'Login not found');
    // someone else chose it: the person confirms an emailed code and sets their own at the next sign-in
    await this.repo.setPassword(user.id, await bcrypt.hash(req.newPassword, BCRYPT_ROUNDS), true);
    // a reset also lifts a sign-in lockout of this login (its phone and email)
    const secret = requireEnv('JWT_SECRET');
    const keys = [user.loginPhone, user.loginEmail].filter((v): v is string => v !== null).map((v) => throttleKey('login', v, secret));
    if (keys.length) await this.repo.clearThrottle(keys);
  }

  async assignRole(ctx: RequestContext, req: AssignRoleRequest): Promise<{ publicId: string }> {
    const personId = await this.person(ctx, req.personPublicId);
    if (personId === ctx.personId) throw new AppError('CORE_SELF_GRANT', 403, 'Nobody can give a role to themselves');
    const roleId = await this.repo.findRoleId(ctx.tenantId, req.roleCode);
    if (!roleId) throw new AppError('CORE_UNKNOWN_ROLE', 400, `Unknown role ${req.roleCode}`);
    const publicId = await this.repo.insertRoleAssignment({
      tenantId: ctx.tenantId, personId, roleId, scope: req.scope,
      validFrom: req.validFrom ?? todayIst(), validTo: req.validTo, grantedBy: ctx.personId,
    });
    return { publicId };
  }

  /** Takes effect on the person's next request. The record stays as history. */
  /** A person's login (if any) and the roles they hold today: for the System admin on the person's profile. */
  async personAccess(ctx: RequestContext, personPublicId: string): Promise<PersonAccess> {
    const personId = await this.person(ctx, personPublicId);
    const login = await this.repo.loginOfPerson(personId);
    return { login: login ?? null, roles: await this.repo.rolesInForce(ctx.tenantId, personId, todayIst()) };
  }

  roles(ctx: RequestContext): Promise<RoleOption[]> {
    return this.repo.allRoles(ctx.tenantId);
  }

  async endRole(ctx: RequestContext, assignmentPublicId: string): Promise<void> {
    const a = await this.repo.findRoleAssignment(ctx.tenantId, assignmentPublicId);
    if (!a) throw new AppError('CORE_ROLE_ASSIGNMENT_NOT_FOUND', 404, 'Role assignment not found');
    if (a.endedAt) throw new AppError('CORE_ROLE_ALREADY_ENDED', 409, 'This role has already ended');
    await this.repo.endRoleAssignment(a.id);
  }

  /**
   * The welcome email: how to set a password with a code ("First time or forgot your password?" on the sign-in page).
   * A mail failure does not undo the login: the person can still ask for a code, or HR sends the email again.
   */
  private async welcome(ctx: RequestContext, userPublicId: string): Promise<void> {
    const user = await this.repo.findUser(ctx.tenantId, userPublicId);
    if (!user?.loginEmail) return;
    const site = (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
    try {
      await sendMail({
        to: user.loginEmail, subject: 'Your Ageless account is ready',
        text: `Hello ${user.personName},\n\nAn account has been created for you on the Ageless People Platform.\n\n`
          + `1. Open ${site}\n2. Choose "First time or forgot your password?"\n3. Enter this email address: ${user.loginEmail}\n`
          + '4. We email you a 6-digit code; enter it and choose your own password.\n\n'
          + `After that, sign in with ${user.loginEmail}${user.loginPhone ? ' or your phone number' : ''} and your password.\n\n`
          + 'Ageless People Platform',
      });
    } catch (err) {
      this.logger.warn(`Welcome email not sent (login ${userPublicId}): ${(err as Error).message}`);
    }
    if (user.loginPhone) {
      try {
        await sendSms({ to: user.loginPhone, text: `Your Ageless account is ready. Open ${site}, choose "First time or forgot your password?" and enter this phone number to get a code.` });
      } catch (err) {
        this.logger.warn(`Welcome SMS not sent (login ${userPublicId}): ${(err as Error).message}`);
      }
    }
  }

  private async person(ctx: RequestContext, publicId: string): Promise<number> {
    const id = await this.repo.findPersonId(ctx.tenantId, publicId);
    if (!id) throw new AppError('CORE_PERSON_NOT_FOUND', 404, 'Person not found');
    return id;
  }
}
