import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../../../../platform/http/request-context';
import { LeaveService } from '../application/leave.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/leave')
export class LeaveController {
  constructor(@Inject(LeaveService) private readonly service: LeaveService) {}
  @Public() @Get('health') health() { return this.service.health(); }
}
