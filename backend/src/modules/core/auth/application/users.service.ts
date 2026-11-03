import { Inject, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AssignRoleRequest, CreateUserRequest, ResetPasswordRequest } from '@ageless/shared';
import { violatedConstraint } from '../../../../platform/db/db.module';
import { AppError } from '../../../../platform/http/app-error';
import { RequestContext } from '../../../../platform/http/request-context';
import { todayIst } from '../../../../platform/time';
import { AuthRepository } from '../infrastructure/auth.repository';
import { normalizeEmail, normalizePhone } from '../domain/login';
import { BCRYPT_ROUNDS } from './auth.service';

/** Logins and roles, managed by people with core.users.manage over the whole tenant. */
@Injectable()
export class UsersService {
  constructor(@Inject(AuthRepository) private readonly repo: AuthRepository) {}

  async createUser(ctx: RequestContext, req: CreateUserRequest): Promise<{ publicId: string }> {
    const personId = await this.person(ctx, req.personPublicId);
    try {
      const publicId = await this.repo.insertUser({
        tenantId: ctx.tenantId, personId,
        loginPhone: req.loginPhone ? normalizePhone(req.loginPhone) : null,
        loginEmail: req.loginEmail ? normalizeEmail(req.loginEmail) : null,
        passwordHash: await bcrypt.hash(req.password, BCRYPT_ROUNDS),
      });
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

  /** The new password ends every token the person had. */
  async resetPassword(ctx: RequestContext, userPublicId: string, req: ResetPasswordRequest): Promise<void> {
    const user = await this.repo.findUser(ctx.tenantId, userPublicId);
    if (!user) throw new AppError('CORE_USER_NOT_FOUND', 404, 'Login not found');
    await this.repo.setPassword(user.id, await bcrypt.hash(req.newPassword, BCRYPT_ROUNDS));
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
  async endRole(ctx: RequestContext, assignmentPublicId: string): Promise<void> {
    const a = await this.repo.findRoleAssignment(ctx.tenantId, assignmentPublicId);
    if (!a) throw new AppError('CORE_ROLE_ASSIGNMENT_NOT_FOUND', 404, 'Role assignment not found');
    if (a.endedAt) throw new AppError('CORE_ROLE_ALREADY_ENDED', 409, 'This role has already ended');
    await this.repo.endRoleAssignment(a.id);
  }

  private async person(ctx: RequestContext, publicId: string): Promise<number> {
    const id = await this.repo.findPersonId(ctx.tenantId, publicId);
    if (!id) throw new AppError('CORE_PERSON_NOT_FOUND', 404, 'Person not found');
    return id;
  }
}
