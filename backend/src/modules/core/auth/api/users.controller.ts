import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { AssignRoleRequest, CreatedId, CreateUserRequest, PersonAccess, ResetPasswordRequest, RoleOption } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext, requireAll } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { UsersService } from '../application/users.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
const MANAGE = 'core.users.manage';
const TEAM = 'core.users.team';

/** Only: validate input, check permission, call one use case. */
@Controller('core')
export class UsersController {
  constructor(@Inject(UsersService) private readonly service: UsersService) {}

  @Doc({ summary: 'Create a login (email required, phone optional) with a temporary password; the person sets their own at the first sign-in', response: CreatedId,
    description: 'core.users.manage (scope all): anyone. core.users.team (Supervisor, department head): someone you manage or in a department you head; that login gets the Employee role.' })
  @Permission(MANAGE, TEAM) @Post('users')
  createUser(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateUserRequest)) body: CreateUserRequest) {
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

  @Doc({ summary: 'The roles that can be given', response: z.array(RoleOption) })
  @Permission(MANAGE) @Get('roles')
  roles(@Ctx() ctx: RequestContext) {
    requireAll(ctx, MANAGE);
    return this.service.roles(ctx);
  }

  @Doc({ summary: "A person's login (null: none yet) and the roles they hold today", response: PersonAccess })
  @Permission(MANAGE) @Get('people/:publicId/access')
  personAccess(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    requireAll(ctx, MANAGE);
    return this.service.personAccess(ctx, publicId);
  }

  @Doc({ summary: 'End a role (kept as history)' })
  @Permission(MANAGE) @Post('role-assignments/:publicId/end') @HttpCode(204)
  endRole(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    requireAll(ctx, MANAGE);
    return this.service.endRole(ctx, publicId);
  }
}
