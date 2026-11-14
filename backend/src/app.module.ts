import { Module } from '@nestjs/common';
import { DbModule } from './platform/db/db.module';
import { HttpModule } from './platform/http/http.module';
import { CoreModule } from './modules/core/core.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { HrmsModule } from './modules/hrms/hrms.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { InventoryModule } from './modules/inventory/inventory.module';

// Every module is registered here. Later: SalesModule, OperationsModule, WorkshopModule ...
@Module({ imports: [DbModule, HttpModule, CoreModule, TicketsModule, HrmsModule, PayrollModule, InventoryModule] })
export class AppModule {}
