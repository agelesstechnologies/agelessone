import { Controller, Get } from '@nestjs/common';
import { LeaveService } from '../application/leave.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/leave')
export class LeaveController {
  constructor(private readonly service: LeaveService) {}
  @Get('health') health() { return this.service.health(); }
}
