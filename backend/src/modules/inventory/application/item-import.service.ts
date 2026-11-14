import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ImportCsvRequest, ImportResult, ITEM_CSV_COLUMNS, ItemCsvRow } from '@ageless/shared';
import { DB, Db, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { CatalogRepository } from '../infrastructure/catalog.repository';
import { LocationsRepository } from '../infrastructure/locations.repository';
import { PlannedItem, planItemImport } from '../domain/item-import';
import { INVENTORY } from '../domain/permissions';
import { CompanyAccess } from './company-access.service';
import { CsvUpload, readCsvRows, refuseFile } from './csv-upload';

/**
 * Loads a company's items from a CSV file. Rows whose code the company already uses (or an earlier row used) are skipped;
 * any other problem refuses the whole file and names the rows. A dry run checks and shows the codes without saving.
 */
@Injectable()
export class ItemImportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CatalogRepository) private readonly repo: CatalogRepository,
    @Inject(LocationsRepository) private readonly locations: LocationsRepository,
    @Inject(CompanyAccess) private readonly access: CompanyAccess,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async import(ctx: RequestContext, req: ImportCsvRequest, file: CsvUpload | undefined): Promise<ImportResult> {
    const company = await this.access.require(ctx, [INVENTORY.items], req.company);
    const csv = readCsvRows(file, ItemCsvRow, ITEM_CSV_COLUMNS, ['name', 'category', 'unit']);
    try {
      return await this.db.transaction(async (tx) => {
        if (!req.dryRun) await this.repo.lockCategories(tx, company.id);   // codes made now cannot collide with another create
        const [categories, units, locations, existing] = await Promise.all([this.repo.companyCategories(tx, company.id),
          this.repo.companyUnits(tx, company.id), this.locations.companyLocations(tx, company.id), this.repo.companyItemNames(tx, company.id)]);
        const { planned, problems } = planItemImport(csv.valid, { categories, units, locations, items: existing });
        // a row that breaks the column rules but repeats a code the company uses is skipped like any duplicate
        const codes = new Set(existing.map((i) => i.code));
        for (const bad of csv.invalid) {
          const code = (bad.values.code ?? '').trim().toUpperCase();
          if (codes.has(code)) planned.push({ row: bad.row, code, name: (bad.values.name ?? '').trim(), result: 'skipped', reason: 'This code is already used by an item of the company' });
          else problems.push(...bad.problems);
        }
        if (problems.length) throw refuseFile(problems);

        const created = planned.filter((p): p is PlannedItem & Required<Pick<PlannedItem, 'content'>> => p.result === 'created' && p.content !== undefined);
        if (!req.dryRun && created.length) {
          const ids = await this.repo.insertItems(tx, created.map((p) => ({
            tenantId: ctx.tenantId, publicId: randomUUID(), legalEntityId: company.id, code: p.code, createdBy: ctx.personId, ...p.content,
          })));
          await this.repo.insertConversions(tx, created.flatMap((p, i) => (p.conversion
            ? [{ tenantId: ctx.tenantId, legalEntityId: company.id, itemId: ids[i], unitId: p.conversion.unitId, factor: p.conversion.factor, createdBy: ctx.personId }]
            : [])));
          await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'inventory.items.imported', entity: 'inventory_item',
            legalEntityId: company.id, summary: `Imported ${created.length} items into ${company.code}`,
            details: { created: created.length, skipped: planned.length - created.length, codes: created.map((p) => p.code) } });
        }
        return {
          company: company.code, dryRun: req.dryRun, created: created.length, skipped: planned.length - created.length,
          rows: planned.sort((a, b) => a.row - b.row).map((p) => ({ row: p.row, code: p.code, name: p.name, result: p.result, reason: p.reason })),
        };
      });
    } catch (err) {
      const constraint = violatedConstraint(err);
      if (constraint === 'items_company_code_unique' || constraint === 'items_company_name_unique') {
        throw new AppError('INVENTORY_IMPORT_CONFLICT', 409, 'Someone added an item with the same code or name at the same moment; send the file again');
      }
      throw err;
    }
  }
}
