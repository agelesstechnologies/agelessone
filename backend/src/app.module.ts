import { Module } from '@nestjs/common';
import { DbModule } from './platform/db/db.module';
import { HttpModule } from './platform/http/http.module';
import { CoreModule } from './modules/core/core.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { HrmsModule } from './modules/hrms/hrms.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { IntercompanyModule } from './modules/intercompany/intercompany.module';
import { DesignModule } from './modules/design/design.module';

// Every module is registered here. Later: SalesModule, OperationsModule, WorkshopModule ...
@Module({ imports: [DbModule, HttpModule, CoreModule, TicketsModule, HrmsModule, PayrollModule, AccountsModule, InventoryModule, IntercompanyModule, DesignModule] })
export class AppModule {}
