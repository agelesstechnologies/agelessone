import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { AppError } from './app-error';

export type Scope = 'own' | 'team' | 'all';

/**
 * The signed-in caller, set by the auth guard from the login token.
 * personId is internal (for queries); APIs only ever show public ids.
 */
export interface RequestContext {
  tenantId: number;
  personId: number;
  personPublicId: string;
  userPublicId: string;
  /** permission code → widest scope the caller holds it with */
  permissions: Record<string, Scope>;
}

export const IS_PUBLIC = 'access:public';
export const REQUIRED_PERMISSION = 'access:permission';
export const ANY_SIGNED_IN = '*';

/** A route that needs no sign-in (health checks, login). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** A route the caller may use only with this permission — or any one of several (scope checked again by the service). */
export const Permission = (...codes: [string, ...string[]]) => SetMetadata(REQUIRED_PERMISSION, codes.length === 1 ? codes[0] : codes);
/** A route any signed-in person may use (their own profile, password). */
export const SignedIn = () => SetMetadata(REQUIRED_PERMISSION, ANY_SIGNED_IN);

/** For actions that only make sense over the whole tenant (create people, manage logins): the permission must have scope all. */
export function requireAll(ctx: RequestContext, permission: string): void {
  if (ctx.permissions[permission] !== 'all') throw new AppError('FORBIDDEN', 403, `This needs ${permission} for everyone`);
}

/** Management (role Management, scope all): reads every HRMS record and decides any pending request. */
export const MANAGEMENT = 'hrms.management';
export const isManagement = (ctx: RequestContext) => ctx.permissions[MANAGEMENT] === 'all';

/** For reading tenant-wide data: the permission with scope all, or Management. */
export function requireReadAll(ctx: RequestContext, permission: string): void {
  if (ctx.permissions[permission] !== 'all' && !isManagement(ctx)) throw new AppError('FORBIDDEN', 403, `This needs ${permission} for everyone`);
}

/** How a decision was made: by the request's named approver, as Management, or by HR (scope all). */
export type DecidedAs = 'approver' | 'hr' | 'management' | 'no_approval_required';
export function decidedAs(ctx: RequestContext, namedApprover: boolean): DecidedAs {
  if (namedApprover) return 'approver';
  return isManagement(ctx) ? 'management' : 'hr';
}

/** Controller parameter: @Ctx() ctx: RequestContext */
export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestContext =>
  ctx.switchToHttp().getRequest<{ context: RequestContext }>().context);
