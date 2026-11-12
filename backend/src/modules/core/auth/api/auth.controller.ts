import { Body, Controller, Get, HttpCode, Inject, Ip, Post } from '@nestjs/common';
import {
  ChangePasswordRequest, CodeSent, CompleteFirstLoginRequest, ForgotPasswordRequest, ForgotPasswordResponse, LoginRequest, LoginResponse, Me,
  ResetWithCodeRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, DuringPasswordSetup, Public, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { AuthService } from '../application/auth.service';

/** Only: validate input, check permission, call one use case. */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly service: AuthService) {}

  @Doc({ summary: 'Sign in with a login phone or email and password', response: LoginResponse,
    description: 'Answers the same AUTH_FAILED for a wrong password and an unknown login. Too many failed sign-ins for one account '
      + '(default 5) or from one IP address (default 30) within 15 minutes lock it for 15 minutes: 429 AUTH_LOCKED with a Retry-After '
      + 'header and details.retryAfterSeconds, even with the right password. A login whose password someone else chose '
      + '(new, or reset by an admin) gets a token that only opens /auth/me and /auth/first-login until the person sets their own.' })
  @Public() @Post('login') @HttpCode(200)
  login(@Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest, @Ip() ip: string) {
    return this.service.login(body, ip);
  }

  @Doc({ summary: 'Who am I: person, login (mustChangePassword), roles and permissions (widest scope per permission)', response: Me })
  @SignedIn() @DuringPasswordSetup() @Get('me')
  me(@Ctx() ctx: RequestContext) {
    return this.service.me(ctx);
  }

  @Doc({ summary: 'Change my password; older tokens stop working', response: LoginResponse })
  @SignedIn() @Post('password') @HttpCode(200)
  changePassword(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ChangePasswordRequest)) body: ChangePasswordRequest) {
    return this.service.changePassword(ctx, body);
  }

  @Doc({ summary: 'First sign-in: email a 6-digit code to my login email (valid 10 minutes; at most 3 an hour)', response: CodeSent })
  @SignedIn() @DuringPasswordSetup() @Post('first-login/code') @HttpCode(200)
  firstLoginCode(@Ctx() ctx: RequestContext) {
    return this.service.sendFirstLoginCode(ctx);
  }

  @Doc({ summary: 'First sign-in: confirm the emailed code and set my own password; answers a fresh token', response: LoginResponse })
  @SignedIn() @DuringPasswordSetup() @Post('first-login') @HttpCode(200)
  completeFirstLogin(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CompleteFirstLoginRequest)) body: CompleteFirstLoginRequest) {
    return this.service.completeFirstLogin(ctx, body);
  }

  @Doc({ summary: 'Forgot password: email a code to the login (same answer whether or not the login exists)', response: ForgotPasswordResponse })
  @Public() @Post('forgot-password') @HttpCode(200)
  forgotPassword(@Body(new ZodValidationPipe(ForgotPasswordRequest)) body: ForgotPasswordRequest) {
    return this.service.forgotPassword(body);
  }

  @Doc({ summary: 'Forgot password: the emailed code and a new password; answers a token (signed in)', response: LoginResponse })
  @Public() @Post('reset-password') @HttpCode(200)
  resetPassword(@Body(new ZodValidationPipe(ResetWithCodeRequest)) body: ResetWithCodeRequest) {
    return this.service.resetWithCode(body);
  }
}
