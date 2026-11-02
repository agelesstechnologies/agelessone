import { Module } from '@nestjs/common';
import { ExpensesController } from './api/expenses.controller';
import { ExpensesService } from './application/expenses.service';
import { ExpensesRepository } from './infrastructure/expenses.repository';

@Module({ controllers: [ExpensesController], providers: [ExpensesService, ExpensesRepository], exports: [ExpensesService] })
export class ExpensesModule {}
