import { Global, Module } from '@nestjs/common';
import { UnitsController } from './api/units.controller';
import { CategoriesController } from './api/categories.controller';
import { ItemsController } from './api/items.controller';
import { LocationsController } from './api/locations.controller';
import { StockController } from './api/stock.controller';
import { RequestsController } from './api/requests.controller';
import { RequestsService } from './application/requests.service';
import { GrantsService } from './application/grants.service';
import { RequestsRepository } from './infrastructure/requests.repository';
import { InventoryFacade } from './inventory.facade';
import { CompanyAccess } from './application/company-access.service';
import { UnitsService } from './application/units.service';
import { CategoriesService } from './application/categories.service';
import { ItemsService } from './application/items.service';
import { ItemImportService } from './application/item-import.service';
import { LocationImportService } from './application/location-import.service';
import { LocationsService } from './application/locations.service';
import { ClosedMonths } from './application/closed-months';
import { StockPosting } from './application/stock-posting.service';
import { StockDocumentsService } from './application/stock-documents.service';
import { StockQueriesService } from './application/stock-queries.service';
import { StockRebuildService } from './application/stock-rebuild.service';
import { InventoryRepository } from './infrastructure/inventory.repository';
import { CatalogRepository } from './infrastructure/catalog.repository';
import { LocationsRepository } from './infrastructure/locations.repository';
import { StockRepository } from './infrastructure/stock.repository';
import { StockQueriesRepository } from './infrastructure/stock-queries.repository';

/**
 * Inventory: each company's units, item categories, items (unit conversions, copy, CSV import) and store locations (CSV import).
 * The companies are kept apart: records of one company never point at another's, and people reach only the companies
 * they work in (scope all: every company). Stock moves through documents (receipt, issue, return, transfer, reversal) at the
 * moving average cost; the nightly job rebuilds balances from the moves. Part requests reserve stock once approved; cross-company
 * grants let a person of another company request for one ticket. Global: other modules use InventoryFacade.
 */
@Global()
@Module({
  controllers: [UnitsController, CategoriesController, ItemsController, LocationsController, StockController, RequestsController],
  providers: [CompanyAccess, UnitsService, CategoriesService, ItemsService, ItemImportService, LocationImportService, LocationsService,
    ClosedMonths, StockPosting, StockDocumentsService, StockQueriesService, StockRebuildService, RequestsService, GrantsService, InventoryFacade,
    InventoryRepository, CatalogRepository, LocationsRepository, StockRepository, StockQueriesRepository, RequestsRepository],
  exports: [InventoryFacade, StockRebuildService, RequestsService],
})
export class InventoryModule {}
