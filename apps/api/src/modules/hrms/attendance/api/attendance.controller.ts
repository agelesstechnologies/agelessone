import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../../../../platform/http/request-context';
import { AttendanceService } from '../application/attendance.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/attendance')
export class AttendanceController {
  constructor(@Inject(AttendanceService) private readonly service: AttendanceService) {}
  @Public() @Get('health') health() { return this.service.health(); }
}
