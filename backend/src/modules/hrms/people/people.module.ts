import { Module } from '@nestjs/common';
import { PeopleController } from './api/people.controller';
import { ContactsController } from './api/contacts.controller';
import { EmploymentsController } from './api/employments.controller';
import { OrganisationController } from './api/organisation.controller';
import { PeopleService } from './application/people.service';
import { OrganisationService } from './application/organisation.service';
import { PeopleRepository } from './infrastructure/people.repository';
import { OrganisationRepository } from './infrastructure/organisation.repository';

@Module({
  controllers: [PeopleController, ContactsController, EmploymentsController, OrganisationController],
  providers: [PeopleService, PeopleRepository, OrganisationService, OrganisationRepository],
  exports: [PeopleService],
})
export class PeopleModule {}
