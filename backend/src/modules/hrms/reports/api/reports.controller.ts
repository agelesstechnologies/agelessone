import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../../../../platform/http/request-context';
import { ReportsService } from '../application/reports.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/reports')
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly service: ReportsService) {}
  @Public() @Get('health') health() { return this.service.health(); }
}
