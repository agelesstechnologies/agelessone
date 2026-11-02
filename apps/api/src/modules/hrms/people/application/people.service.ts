import { Injectable } from '@nestjs/common';
import { PeopleRepository } from '../infrastructure/people.repository';

/** Use cases live here: open the transaction, call repositories and other facades, write the outbox event. */
@Injectable()
export class PeopleService {
  constructor(private readonly repo: PeopleRepository) {}
  health() { return { module: 'hrms', sub: 'people', ok: true }; }
}
