import { Body, Controller, Get, HttpCode, Inject, Ip, Post } from '@nestjs/common';
import { ChangePasswordRequest, LoginRequest, LoginResponse, Me } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Public, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { AuthService } from '../application/auth.service';

/** Only: validate input, check permission, call one use case. */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly service: AuthService) {}

  @Doc({ summary: 'Sign in with a login phone or email and password', response: LoginResponse,
    description: 'Answers the same AUTH_FAILED for a wrong password and an unknown login. Too many failed sign-ins for one account '
      + '(default 5) or from one IP address (default 30) within 15 minutes lock it for 15 minutes: 429 AUTH_LOCKED with a Retry-After '
      + 'header and details.retryAfterSeconds, even with the right password.' })
  @Public() @Post('login') @HttpCode(200)
  login(@Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest, @Ip() ip: string) {
    return this.service.login(body, ip);
  }

  @Doc({ summary: 'Who am I: person, login, roles and permissions (widest scope per permission)', response: Me })
  @SignedIn() @Get('me')
  me(@Ctx() ctx: RequestContext) {
    return this.service.me(ctx);
  }

  @Doc({ summary: 'Change my password; older tokens stop working', response: LoginResponse })
  @SignedIn() @Post('password') @HttpCode(200)
  changePassword(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ChangePasswordRequest)) body: ChangePasswordRequest) {
    return this.service.changePassword(ctx, body);
  }
}
