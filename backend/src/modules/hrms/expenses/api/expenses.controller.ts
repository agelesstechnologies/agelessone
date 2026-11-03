import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../../../../platform/http/request-context';
import { ExpensesService } from '../application/expenses.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/expenses')
export class ExpensesController {
  constructor(@Inject(ExpensesService) private readonly service: ExpensesService) {}
  @Public() @Get('health') health() { return this.service.health(); }
}
