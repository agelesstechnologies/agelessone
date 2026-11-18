import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ImportCsvRequest, ImportResult, LOCATION_CSV_COLUMNS, LocationCsvRow } from '@ageless/shared';
import { DB, Db, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { InventoryRepository } from '../infrastructure/inventory.repository';
import { LocationsRepository } from '../infrastructure/locations.repository';
import { planLocationImport } from '../domain/location-import';
import { INVENTORY } from '../domain/permissions';
import { CompanyAccess } from './company-access.service';
import { CsvUpload, readCsvRows, refuseFile } from './csv-upload';
import { addNeedsTeam } from './locations.service';

/**
 * Loads a company's store locations from a CSV file (code, name, type, parent code, custodian employee code). Rows whose
 * code the company already uses (or an earlier row used) are skipped; any other problem refuses the whole file. Parents
 * may be rows of the same file: they are created first. A dry run checks without saving.
 */
@Injectable()
export class LocationImportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(LocationsRepository) private readonly repo: LocationsRepository,
    @Inject(InventoryRepository) private readonly base: InventoryRepository,
    @Inject(CompanyAccess) private readonly access: CompanyAccess,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async import(ctx: RequestContext, req: ImportCsvRequest, file: CsvUpload | undefined): Promise<ImportResult> {
    const company = await this.access.require(ctx, [INVENTORY.locations], req.company);
    if (!(await this.access.reachesEveryLocation(ctx, [INVENTORY.locations], company.id))) throw addNeedsTeam();
    const csv = readCsvRows(file, LocationCsvRow, LOCATION_CSV_COLUMNS, ['code', 'name', 'type']);
    try {
      return await this.db.transaction(async (tx) => {
        const [existing, jobs] = await Promise.all([this.repo.companyLocations(tx, company.id), this.base.companyJobs(tx, company.id)]);
        const { planned, problems } = planLocationImport(csv.valid, { locations: existing, jobs });
        const codes = new Set(existing.map((l) => l.code));
        for (const bad of csv.invalid) {
          const code = (bad.values.code ?? '').trim().toUpperCase();
          if (codes.has(code)) planned.push({ row: bad.row, code, name: (bad.values.name ?? '').trim(), type: 'store', result: 'skipped',
            reason: 'This code is already used by a location of the company', parent: null, custodianEmploymentId: null });
          else problems.push(...bad.problems);
        }
        if (problems.length) throw refuseFile(problems);

        const created = planned.filter((p) => p.result === 'created');    // parents first
        if (!req.dryRun && created.length) {
          const idOfCode = new Map<string, number>();
          for (const p of created) {
            const parentId = p.parent === null ? null : 'id' in p.parent ? p.parent.id : idOfCode.get(p.parent.code) ?? null;
            idOfCode.set(p.code, await this.repo.insert(tx, { tenantId: ctx.tenantId, publicId: randomUUID(), legalEntityId: company.id, type: p.type,
              code: p.code, name: p.name, parentId, custodianEmploymentId: p.custodianEmploymentId, createdBy: ctx.personId }));
          }
          await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'inventory.locations.imported', entity: 'inventory_location',
            legalEntityId: company.id, summary: `Imported ${created.length} locations into ${company.code}`,
            details: { created: created.length, skipped: planned.length - created.length, codes: created.map((p) => p.code) } });
        }
        return {
          company: company.code, dryRun: req.dryRun, created: created.length, skipped: planned.length - created.length,
          rows: [...planned].sort((a, b) => a.row - b.row).map((p) => ({ row: p.row, code: p.code, name: p.name, result: p.result, reason: p.reason })),
        };
      });
    } catch (err) {
      if (violatedConstraint(err) === 'locations_company_code_unique') {
        throw new AppError('INVENTORY_IMPORT_CONFLICT', 409, 'Someone added a location with the same code at the same moment; send the file again');
      }
      throw err;
    }
  }
}
