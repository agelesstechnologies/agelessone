import { Module } from '@nestjs/common';
import { TicketTypesController } from './api/ticket-types.controller';
import { TicketTimeController } from './api/ticket-time.controller';
import { TicketsController } from './api/tickets.controller';
import { TicketTypesService } from './application/ticket-types.service';
import { TicketsService } from './application/tickets.service';
import { TicketWorkService } from './application/ticket-work.service';
import { TicketTimeService } from './application/ticket-time.service';
import { TicketTypesRepository } from './infrastructure/ticket-types.repository';
import { TicketsRepository } from './infrastructure/tickets.repository';
import { TicketTimeRepository } from './infrastructure/ticket-time.repository';

/**
 * Ticket engine: ticket types, tickets (assignees, checklist, files, sign-off, links, timeline, reassignment) and ticket
 * time (ticket punch, shared time per day, adjustments, daily updates). Controllers with fixed paths come first, so
 * /tickets/types and /tickets/time/... are matched before /tickets/:publicId.
 */
@Module({
  controllers: [TicketTypesController, TicketTimeController, TicketsController],
  providers: [TicketTypesService, TicketsService, TicketWorkService, TicketTimeService, TicketTypesRepository, TicketsRepository, TicketTimeRepository],
  exports: [TicketTypesService, TicketsService, TicketTimeService],
})
export class TicketsModule {}
