import { Global, Module } from '@nestjs/common';
import { AccountsController } from './api/accounts.controller';
import { TallyConnectorController } from './api/tally-connector.controller';
import { TallySyncController } from './api/tally-sync.controller';
import { AccountsService } from './application/accounts.service';
import { TallyConnectorService } from './application/tally-connector.service';
import { TallySyncService } from './application/tally-sync.service';
import { AccountsRepository } from './infrastructure/accounts.repository';
import { TallySyncRepository } from './infrastructure/tally-sync.repository';
import { AccountsFacade } from './accounts.facade';

/** Accounts: periods, posting rules, the journal, the Tally ledger map and the Tally sync (batches of XML files, no connection to Tally). One public facade (global, like CoreFacade). */
@Global()
@Module({ controllers: [AccountsController, TallySyncController, TallyConnectorController],
  providers: [AccountsService, AccountsRepository, AccountsFacade, TallySyncService, TallyConnectorService, TallySyncRepository], exports: [AccountsFacade] })
export class AccountsModule {}
