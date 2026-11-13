import { Module } from '@nestjs/common';
import { AgreementsController } from './api/agreements.controller';
import { TicketBillingController } from './api/ticket-billing.controller';
import { StatementsController } from './api/statements.controller';
import { IcReportsController } from './api/reports.controller';
import { AgreementsService } from './application/agreements.service';
import { TicketBillingService } from './application/ticket-billing.service';
import { StatementsService } from './application/statements.service';
import { IcReportsService } from './application/reports.service';
import { IntercompanyRepository } from './infrastructure/intercompany.repository';
import { StatementsRepository } from './infrastructure/statements.repository';

/**
 * Intercompany: services one company of the group provides to another (ATPL → AE) — agreements, rate cards, costs
 * passed on, tickets billable to the other company, monthly statements (approval, review, disputes, invoice), reports
 * and the CEO's cards. Reads tickets, jobs, departments, month locks and salaries through their schema.ts; writes only
 * intercompany.*. Guide: docs/api/intercompany.md.
 */
@Module({
  controllers: [TicketBillingController, IcReportsController, StatementsController, AgreementsController],
  providers: [AgreementsService, TicketBillingService, StatementsService, IcReportsService, IntercompanyRepository, StatementsRepository],
  exports: [StatementsService],
})
export class IntercompanyModule {}
