import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../../../../platform/http/request-context';
import { SkillsService } from '../application/skills.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/skills')
export class SkillsController {
  constructor(@Inject(SkillsService) private readonly service: SkillsService) {}
  @Public() @Get('health') health() { return this.service.health(); }
}
