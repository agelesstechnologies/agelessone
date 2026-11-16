import { Injectable } from '@nestjs/common';

/**
 * Whether Accounts has closed the month a stock document is dated in. Accounts periods (accounts.periods, open /
 * soft_closed / closed per company and month) live on the Accounts branch, not yet merged here, so for now no month is
 * closed. When the Accounts module is merged, answer from its facade (closed = state 'closed') and add the test that a
 * document dated in a closed month is refused (INVENTORY_MONTH_CLOSED).
 */
@Injectable()
export class ClosedMonths {
  async isClosed(_tenantId: number, _legalEntityId: number, _date: string): Promise<boolean> {
    return false;
  }
}
