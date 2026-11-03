import { CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { z } from 'zod';
import { AppError } from './app-error';

/** Who is calling and for which tenant. person = core.persons.public_id. */
export interface RequestContext { tenantId: number; personPublicId: string }

// TEMP: replace with login. The caller is taken from headers until sign-in exists.
const CallerHeaders = z.object({
  'x-tenant-id': z.coerce.number().int().positive(),
  'x-person-id': z.string().uuid(),
});

const IS_PUBLIC = 'isPublic';
/** Marks a route that needs no caller (health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Global guard: every non-public request must name its caller. */
@Injectable()
export class RequestContextGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown>; context?: RequestContext }>();
    // TEMP: replace with login. Read tenant and person from the session/token instead of headers.
    const parsed = CallerHeaders.safeParse(req.headers);
    if (!parsed.success) {
      throw new AppError('AUTH_MISSING', 401, 'Send x-tenant-id (number) and x-person-id (uuid) headers');
    }
    req.context = { tenantId: parsed.data['x-tenant-id'], personPublicId: parsed.data['x-person-id'] };
    return true;
  }
}

/** Controller parameter: @Ctx() ctx: RequestContext */
export const Ctx = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestContext =>
  ctx.switchToHttp().getRequest<{ context: RequestContext }>().context);
