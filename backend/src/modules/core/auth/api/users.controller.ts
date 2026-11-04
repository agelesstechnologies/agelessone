import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { AssignRoleRequest, CreatedId, CreateUserRequest, ResetPasswordRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext, requireAll } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { UsersService } from '../application/users.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
const MANAGE = 'core.users.manage';

/** Only: validate input, check permission, call one use case. */
@Controller('core')
export class UsersController {
  constructor(@Inject(UsersService) private readonly service: UsersService) {}

  @Doc({ summary: 'Create a login for a person (phone, email or both)', response: CreatedId })
  @Permission(MANAGE) @Post('users')
  createUser(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateUserRequest)) body: CreateUserRequest) {
    requireAll(ctx, MANAGE);
    return this.service.createUser(ctx, body);
  }

  @Doc({ summary: 'Set a new password; the person\'s tokens stop working' })
  @Permission(MANAGE) @Post('users/:publicId/reset-password') @HttpCode(204)
  resetPassword(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ResetPasswordRequest)) body: ResetPasswordRequest) {
    requireAll(ctx, MANAGE);
    return this.service.resetPassword(ctx, publicId, body);
  }

  @Doc({ summary: 'Give a person a role with a scope (own / team / all); never to yourself', response: CreatedId })
  @Permission(MANAGE) @Post('role-assignments')
  assignRole(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(AssignRoleRequest)) body: AssignRoleRequest) {
    requireAll(ctx, MANAGE);
    return this.service.assignRole(ctx, body);
  }

  @Doc({ summary: 'End a role (kept as history)' })
  @Permission(MANAGE) @Post('role-assignments/:publicId/end') @HttpCode(204)
  endRole(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    requireAll(ctx, MANAGE);
    return this.service.endRole(ctx, publicId);
  }
}
