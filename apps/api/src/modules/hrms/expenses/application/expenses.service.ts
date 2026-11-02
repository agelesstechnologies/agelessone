import { Injectable } from '@nestjs/common';
import { ExpensesRepository } from '../infrastructure/expenses.repository';

/** Use cases live here: open the transaction, call repositories and other facades, write the outbox event. */
@Injectable()
export class ExpensesService {
  constructor(private readonly repo: ExpensesRepository) {}
  health() { return { module: 'hrms', sub: 'expenses', ok: true }; }
}
