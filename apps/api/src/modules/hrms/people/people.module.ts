import { Module } from '@nestjs/common';
import { PeopleController } from './api/people.controller';
import { PeopleService } from './application/people.service';
import { PeopleRepository } from './infrastructure/people.repository';

@Module({ controllers: [PeopleController], providers: [PeopleService, PeopleRepository], exports: [PeopleService] })
export class PeopleModule {}
