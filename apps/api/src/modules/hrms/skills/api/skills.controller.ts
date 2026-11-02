import { Controller, Get } from '@nestjs/common';
import { SkillsService } from '../application/skills.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/skills')
export class SkillsController {
  constructor(private readonly service: SkillsService) {}
  @Get('health') health() { return this.service.health(); }
}
