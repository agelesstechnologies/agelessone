import { Controller, Get } from '@nestjs/common';
import { ReportsService } from '../application/reports.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}
  @Get('health') health() { return this.service.health(); }
}
