import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../../platform/http/app-error';
import { ANY_SIGNED_IN, DURING_PASSWORD_SETUP, IS_PUBLIC, REQUIRED_PERMISSION, RequestContext } from '../../../../platform/http/request-context';
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
    if (kind !== 'Bearer' || !token) throw new AppError('AUTH_MISSING', 401, 'Please sign in first.');
    req.context = await this.auth.authenticate(token);
    if (req.context.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(DURING_PASSWORD_SETUP, targets)) {
      throw new AppError('AUTH_PASSWORD_CHANGE_REQUIRED', 403, 'Set your own password first: open Change password and choose a new one.');
    }

    const required = this.reflector.getAllAndOverride<string | string[] | undefined>(REQUIRED_PERMISSION, targets);
    if (!required) {
      this.logger.error(`Route without access rule: ${ctx.getClass().name}.${ctx.getHandler().name}`);
      throw new AppError('FORBIDDEN', 403, 'This action is not available (no access rule is set for it). Tell support.');
    }
    const anyOf = Array.isArray(required) ? required : [required];
    // A machine credential (the Tally connector) may use only routes that name its own permission: never @SignedIn() routes,
    // never a route it shares only through a person's permission.
    if (req.context.machine && !anyOf.includes(req.context.machine.permission)) {
      throw new AppError('FORBIDDEN', 403, 'A machine credential cannot use this route.');
    }
    const permissions = req.context.permissions;
    if (required !== ANY_SIGNED_IN && !anyOf.some((p) => permissions[p])) {
      throw new AppError('FORBIDDEN', 403, `You do not have permission to do this. Ask HR or an admin for access (${anyOf.join(' or ')}).`, { needs: anyOf });
    }
    return true;
  }
}
