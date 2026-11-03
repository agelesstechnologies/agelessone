import { Module } from '@nestjs/common';
import { PeopleController } from './api/people.controller';
import { ContactsController } from './api/contacts.controller';
import { EmploymentsController } from './api/employments.controller';
import { PeopleService } from './application/people.service';
import { PeopleRepository } from './infrastructure/people.repository';

@Module({ controllers: [PeopleController, ContactsController, EmploymentsController], providers: [PeopleService, PeopleRepository], exports: [PeopleService] })
export class PeopleModule {}
