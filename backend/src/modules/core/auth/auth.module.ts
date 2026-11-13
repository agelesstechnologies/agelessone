import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { requireEnv } from '../../../platform/time';
import { AuthController } from './api/auth.controller';
import { AuthGuard } from './api/auth.guard';
import { MachineCredentialsController } from './api/machine-credentials.controller';
import { UsersController } from './api/users.controller';
import { AuthService } from './application/auth.service';
import { MachineCredentialsService } from './application/machine-credentials.service';
import { UsersService } from './application/users.service';
import { AuthRepository } from './infrastructure/auth.repository';

/** Sign-in (JWT), the global access guard, logins and roles. */
@Module({
  imports: [JwtModule.registerAsync({ useFactory: () => ({ secret: requireEnv('JWT_SECRET') }) })],
  controllers: [AuthController, UsersController, MachineCredentialsController],
  providers: [AuthService, UsersService, MachineCredentialsService, AuthRepository, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
