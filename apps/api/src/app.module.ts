import { Module } from '@nestjs/common';
import { DbModule } from './platform/db/db.module';
import { CoreModule } from './modules/core/core.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { HrmsModule } from './modules/hrms/hrms.module';

// Every module is registered here. Later: SalesModule, OperationsModule, InventoryModule, WorkshopModule ...
@Module({ imports: [DbModule, CoreModule, TicketsModule, HrmsModule] })
export class AppModule {}
