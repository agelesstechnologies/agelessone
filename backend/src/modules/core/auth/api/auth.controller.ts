import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ChangePasswordRequest, LoginRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Public, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { AuthService } from '../application/auth.service';

/** Only: validate input, check permission, call one use case. */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly service: AuthService) {}

  @Public() @Post('login') @HttpCode(200)
  login(@Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest) {
    return this.service.login(body);
  }

  @SignedIn() @Get('me')
  me(@Ctx() ctx: RequestContext) {
    return this.service.me(ctx);
  }

  @SignedIn() @Post('password') @HttpCode(200)
  changePassword(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ChangePasswordRequest)) body: ChangePasswordRequest) {
    return this.service.changePassword(ctx, body);
  }
}
