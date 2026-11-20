import { Global, Module } from '@nestjs/common';
import { CoreFacade } from './core.facade';
import { AuthModule } from './auth/auth.module';
import { PoliciesModule } from './policies/policies.module';
import { ApprovalsService } from './approvals/approvals.service';
import { AuditService } from './audit/audit.service';
import { PlacesService } from './places/places.service';
import { NotificationsService } from './notifications/application/notifications.service';
import { NotificationEmailService } from './notifications/application/notification-email.service';
import { NotificationPreferencesService } from './notifications/application/notification-preferences.service';
import { NotificationsController } from './notifications/api/notifications.controller';
import { CustomersController } from './customers/api/customers.controller';
import { CustomersService } from './customers/application/customers.service';
import { CustomersRepository } from './customers/infrastructure/customers.repository';
/** Shared foundation: sign-on, people, organisation, approvals, files, policies, outbox, alerts, the customer list. */
@Global()
@Module({
  imports: [AuthModule, PoliciesModule], controllers: [NotificationsController, CustomersController],
  providers: [CoreFacade, ApprovalsService, AuditService, PlacesService, NotificationsService, NotificationEmailService, NotificationPreferencesService,
    CustomersService, CustomersRepository], exports: [CoreFacade],
})
export class CoreModule {}
