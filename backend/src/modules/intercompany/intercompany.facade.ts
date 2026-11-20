import { Inject, Injectable } from '@nestjs/common';
import { LinkTicketToWorkRequest } from '@ageless/shared';
import { Tx } from '../../platform/db/db.module';
import { TicketBillingService } from './application/ticket-billing.service';

/** The only Intercompany entry point other modules may use. */
@Injectable()
export class IntercompanyFacade {
  constructor(@Inject(TicketBillingService) private readonly billing: TicketBillingService) {}

  /**
   * Makes a ticket billable to another company of the group for that company's project or design request, inside the
   * caller's transaction, by the existing rule: billable by default; a not-billable decision for the same company stays.
   * The caller decides who may do it (e.g. Design: a ticket linked to a design job whose client is AE). Throws
   * IC_MONTH_BILLED when the ticket has time in a month already billed to that company, IC_SAME_COMPANY for its own company.
   */
  linkTicketToWork(tx: Tx, link: { tenantId: number; actorPersonId: number; ticketPublicId: string } & LinkTicketToWorkRequest): Promise<void> {
    const { tenantId, actorPersonId, ticketPublicId, ...req } = link;
    return this.billing.linkWithin(tx, tenantId, actorPersonId, ticketPublicId, req);
  }
}
