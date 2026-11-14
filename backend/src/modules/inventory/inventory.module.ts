import { Module } from '@nestjs/common';
import { UnitsController } from './api/units.controller';
import { CategoriesController } from './api/categories.controller';
import { ItemsController } from './api/items.controller';
import { LocationsController } from './api/locations.controller';
import { CompanyAccess } from './application/company-access.service';
import { UnitsService } from './application/units.service';
import { CategoriesService } from './application/categories.service';
import { ItemsService } from './application/items.service';
import { ItemImportService } from './application/item-import.service';
import { LocationImportService } from './application/location-import.service';
import { LocationsService } from './application/locations.service';
import { InventoryRepository } from './infrastructure/inventory.repository';
import { CatalogRepository } from './infrastructure/catalog.repository';
import { LocationsRepository } from './infrastructure/locations.repository';

/**
 * Inventory: each company's units, item categories, items (unit conversions, copy, CSV import) and store locations (CSV import).
 * The companies are kept apart: records of one company never point at another's, and people reach only the companies
 * they work in (scope all: every company). Stock, documents and costs come in the next steps.
 */
@Module({
  controllers: [UnitsController, CategoriesController, ItemsController, LocationsController],
  providers: [CompanyAccess, UnitsService, CategoriesService, ItemsService, ItemImportService, LocationImportService, LocationsService,
    InventoryRepository, CatalogRepository, LocationsRepository],
})
export class InventoryModule {}
