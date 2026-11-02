import { Global, Module } from '@nestjs/common';
import { CoreFacade } from './core.facade';
/** Shared foundation: sign-on, people, organisation, approvals, files, policies, outbox. */
@Global()
@Module({ providers: [CoreFacade], exports: [CoreFacade] })
export class CoreModule {}
