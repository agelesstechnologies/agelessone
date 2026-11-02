import { Controller, Get } from '@nestjs/common';
import { PeopleService } from '../application/people.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/people')
export class PeopleController {
  constructor(private readonly service: PeopleService) {}
  @Get('health') health() { return this.service.health(); }
}
