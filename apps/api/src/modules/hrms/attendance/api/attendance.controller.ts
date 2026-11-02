import { Controller, Get } from '@nestjs/common';
import { AttendanceService } from '../application/attendance.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/attendance')
export class AttendanceController {
  constructor(private readonly service: AttendanceService) {}
  @Get('health') health() { return this.service.health(); }
}
