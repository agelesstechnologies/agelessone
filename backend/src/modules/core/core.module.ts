import { Global, Module } from '@nestjs/common';
import { CoreFacade } from './core.facade';
import { AuthModule } from './auth/auth.module';
import { PoliciesModule } from './policies/policies.module';
import { ApprovalsService } from './approvals/approvals.service';
/** Shared foundation: sign-on, people, organisation, approvals, files, policies, outbox. */
@Global()
@Module({ imports: [AuthModule, PoliciesModule], providers: [CoreFacade, ApprovalsService], exports: [CoreFacade] })
export class CoreModule {}
