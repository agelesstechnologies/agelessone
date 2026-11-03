import { Global, Module } from '@nestjs/common';
import { CoreFacade } from './core.facade';
import { AuthModule } from './auth/auth.module';
/** Shared foundation: sign-on, people, organisation, approvals, files, policies, outbox. */
@Global()
@Module({ imports: [AuthModule], providers: [CoreFacade], exports: [CoreFacade] })
export class CoreModule {}
