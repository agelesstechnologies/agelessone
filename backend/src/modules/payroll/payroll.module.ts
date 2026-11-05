import { Module } from '@nestjs/common';
import { PayrollController } from './api/payroll.controller';
import { PayrollService } from './application/payroll.service';
import { PayrollRepository } from './infrastructure/payroll.repository';

/** Payroll: salaries, bank details, monthly runs, adjustments, payslips. Reads attendance through HrmsFacade. */
@Module({ controllers: [PayrollController], providers: [PayrollService, PayrollRepository] })
export class PayrollModule {}
