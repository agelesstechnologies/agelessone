import { Module } from '@nestjs/common';
import { PeopleController } from './api/people.controller';
import { ContactsController } from './api/contacts.controller';
import { EmploymentsController } from './api/employments.controller';
import { OrganisationController } from './api/organisation.controller';
import { PrivateController } from './api/private.controller';
import { PeopleService } from './application/people.service';
import { OrganisationService } from './application/organisation.service';
import { PrivateService } from './application/private.service';
import { PeopleRepository } from './infrastructure/people.repository';
import { OrganisationRepository } from './infrastructure/organisation.repository';
import { PrivateRepository } from './infrastructure/private.repository';

@Module({
  controllers: [PeopleController, ContactsController, EmploymentsController, OrganisationController, PrivateController],
  providers: [PeopleService, PeopleRepository, OrganisationService, OrganisationRepository, PrivateService, PrivateRepository],
  exports: [PeopleService],
})
export class PeopleModule {}
