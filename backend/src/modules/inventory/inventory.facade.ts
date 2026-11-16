import { Inject, Injectable } from '@nestjs/common';
import { Tx } from '../../platform/db/db.module';
import { RequestsService } from './application/requests.service';

/** The only inventory entry point other modules may use. */
@Injectable()
export class InventoryFacade {
  constructor(@Inject(RequestsService) private readonly requests: RequestsService) {}

  /**
   * A ticket was completed or cancelled (call inside that transaction): its open part requests close and the stock they
   * reserved is free again.
   */
  ticketClosed(tx: Tx, tenantId: number, ticketId: number): Promise<void> {
    return this.requests.releaseForTicket(tx, tenantId, ticketId);
  }
}
