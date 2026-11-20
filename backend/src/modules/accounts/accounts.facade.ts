import { Inject, Injectable } from '@nestjs/common';
import { Tx } from '../../platform/db/db.module';
import { AccountsService, PostEntry } from './application/accounts.service';

/** The only Accounts entry point other modules may use. Write calls take the caller's transaction, so one use case stays one transaction. */
@Injectable()
export class AccountsFacade {
  constructor(@Inject(AccountsService) private readonly service: AccountsService) {}

  /** Writes the balanced journal entry of a source document (once: posting it again returns the stored entry). Refused in a closed month. */
  postEntry(tx: Tx, entry: PostEntry) { return this.service.post(tx, entry); }

  /** Posts the reversal of an entry (once). */
  reverseEntry(tx: Tx, tenantId: number, entryPublicId: string, by: number | null, reason: string) { return this.service.reverse(tx, tenantId, entryPublicId, by, reason); }
}
export type { PostEntry };
