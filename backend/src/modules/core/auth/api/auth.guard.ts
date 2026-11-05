import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../../platform/http/app-error';
import { ANY_SIGNED_IN, IS_PUBLIC, REQUIRED_PERMISSION, RequestContext } from '../../../../platform/http/request-context';
import { AuthService } from '../application/auth.service';

/**
 * Global guard. Every route is closed unless marked: @Public(), @SignedIn(), or @Permission('code').
 * Reads "Authorization: Bearer <token>", checks the login and loads today's permissions into the request context.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger('AuthGuard');

  constructor(@Inject(Reflector) private readonly reflector: Reflector, @Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; context?: RequestContext }>();
    const [kind, token] = (req.headers.authorization ?? '').split(' ');
    if (kind !== 'Bearer' || !token) throw new AppError('AUTH_MISSING', 401, 'Sign in first (Authorization: Bearer <token>)');
    req.context = await this.auth.authenticate(token);

    const required = this.reflector.getAllAndOverride<string | string[] | undefined>(REQUIRED_PERMISSION, targets);
    if (!required) {
      this.logger.error(`Route without access rule: ${ctx.getClass().name}.${ctx.getHandler().name}`);
      throw new AppError('FORBIDDEN', 403, 'This route has no access rule');
    }
    const anyOf = Array.isArray(required) ? required : [required];
    const permissions = req.context.permissions;
    if (required !== ANY_SIGNED_IN && !anyOf.some((p) => permissions[p])) {
      throw new AppError('FORBIDDEN', 403, `You need the permission ${anyOf.join(' or ')}`);
    }
    return true;
  }
}
