import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ChangePasswordRequest, LoginRequest, LoginResponse, Me } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Public, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { AuthService } from '../application/auth.service';

/** Only: validate input, check permission, call one use case. */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly service: AuthService) {}

  @Doc({ summary: 'Sign in with a login phone or email and password', response: LoginResponse, description: 'Answers the same AUTH_FAILED for a wrong password and an unknown login.' })
  @Public() @Post('login') @HttpCode(200)
  login(@Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest) {
    return this.service.login(body);
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
