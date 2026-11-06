import { Global, Module } from '@nestjs/common';
import { CoreFacade } from './core.facade';
import { AuthModule } from './auth/auth.module';
import { PoliciesModule } from './policies/policies.module';
import { ApprovalsService } from './approvals/approvals.service';
import { AuditService } from './audit/audit.service';
import { PlacesService } from './places/places.service';
/** Shared foundation: sign-on, people, organisation, approvals, files, policies, outbox. */
@Global()
@Module({ imports: [AuthModule, PoliciesModule], providers: [CoreFacade, ApprovalsService, AuditService, PlacesService], exports: [CoreFacade] })
export class CoreModule {}
