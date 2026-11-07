import { Global, Module } from '@nestjs/common';
import { AccountsController } from './api/accounts.controller';
import { AccountsService } from './application/accounts.service';
import { AccountsRepository } from './infrastructure/accounts.repository';
import { AccountsFacade } from './accounts.facade';

/** Accounts: periods, posting rules, the journal and the Tally ledger map. One public facade (global, like CoreFacade). */
@Global()
@Module({ controllers: [AccountsController], providers: [AccountsService, AccountsRepository, AccountsFacade], exports: [AccountsFacade] })
export class AccountsModule {}
