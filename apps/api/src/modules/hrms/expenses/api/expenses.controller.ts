import { Controller, Get } from '@nestjs/common';
import { ExpensesService } from '../application/expenses.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/expenses')
export class ExpensesController {
  constructor(private readonly service: ExpensesService) {}
  @Get('health') health() { return this.service.health(); }
}
