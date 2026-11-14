import type { ImportProblem, LocationCsvRow, LocationType } from '@ageless/shared';
import { creationOrder, needsCustodian, placementProblem } from './locations';

export interface ExistingLocation { id: number; code: string; type: LocationType; status: string }
/** A job of the company, by employee code; current: active or on notice. */
export interface ImportJob { id: number; employeeCode: string; current: boolean }
export interface PlannedLocation {
  row: number; code: string; name: string; type: LocationType; result: 'created' | 'skipped'; reason: string | null;
  /** an existing location's id, or the code of a location created earlier from the same file */
  parent: { id: number } | { code: string } | null;
  custodianEmploymentId: number | null;
}

/**
 * Checks a locations CSV against the company's locations and jobs. Rows whose code the company already uses, or an
 * earlier row used, are skipped. Every other row must be valid or the whole file is refused: its parent (an existing
 * active location, or another row of the file) fits its type (rack in a store, bin in a store or rack); the custodian is
 * the employee code of a current job in the company, needed except for racks and bins. The rows to create come back
 * parents first.
 */
export function planLocationImport(
  rows: { row: number; data: LocationCsvRow }[],
  known: { locations: ExistingLocation[]; jobs: ImportJob[] },
): { planned: PlannedLocation[]; problems: ImportProblem[] } {
  const existingByCode = new Map(known.locations.map((l) => [l.code, l]));
  const jobByCode = new Map(known.jobs.map((j) => [j.employeeCode.toUpperCase(), j]));
  const fileByCode = new Map<string, { row: number; type: LocationType }>();
  for (const { row, data } of rows) if (!existingByCode.has(data.code) && !fileByCode.has(data.code)) fileByCode.set(data.code, { row, type: data.type });

  const planned: PlannedLocation[] = [];
  const problems: ImportProblem[] = [];
  for (const { row, data: r } of rows) {
    const base = { row, code: r.code, name: r.name, type: r.type, parent: null, custodianEmploymentId: null };
    if (existingByCode.has(r.code)) { planned.push({ ...base, result: 'skipped', reason: 'This code is already used by a location of the company' }); continue; }
    const first = fileByCode.get(r.code);
    if (first && first.row !== row) { planned.push({ ...base, result: 'skipped', reason: `Row ${first.row} has the same code` }); continue; }

    const before = problems.length;
    const add = (field: string, message: string) => problems.push({ row, field, message });
    let parent: PlannedLocation['parent'] = null;
    let parentType: LocationType | null = null;
    if (r.parent) {
      const existing = existingByCode.get(r.parent);
      const inFile = fileByCode.get(r.parent);
      if (r.parent === r.code) add('parent', 'A location cannot be its own parent');
      else if (existing) {
        if (existing.status !== 'active') add('parent', `The location ${existing.code} is inactive`);
        parent = { id: existing.id };
        parentType = existing.type;
      } else if (inFile) {
        parent = { code: r.parent };
        parentType = inFile.type;
      } else add('parent', `No location with the code ${r.parent}, in the company or in this file`);
    }
    if (problems.length === before) {
      const placement = placementProblem(r.type, parentType);
      if (placement) add('parent', placement.charAt(0).toUpperCase() + placement.slice(1));
    }
    let custodianEmploymentId: number | null = null;
    if (r.custodian) {
      const job = jobByCode.get(r.custodian.toUpperCase());
      if (!job) add('custodian', `No job with the employee code ${r.custodian} in this company`);
      else if (!job.current) add('custodian', `The job ${job.employeeCode} is not current`);
      else custodianEmploymentId = job.id;
    } else if (needsCustodian(r.type)) {
      add('custodian', 'Give the custodian (employee code): only racks and bins can leave it to their parent');
    }
    if (problems.length > before) continue;
    planned.push({ ...base, result: 'created', reason: null, parent, custodianEmploymentId });
  }
  const created = planned.filter((p) => p.result === 'created').sort((a, b) => creationOrder(a.type) - creationOrder(b.type));
  return { planned: [...created, ...planned.filter((p) => p.result === 'skipped')], problems };
}
