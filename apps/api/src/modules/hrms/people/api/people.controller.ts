import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../../../../platform/http/request-context';
import { PeopleService } from '../application/people.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/people')
export class PeopleController {
  constructor(@Inject(PeopleService) private readonly service: PeopleService) {}
  @Public() @Get('health') health() { return this.service.health(); }
}
