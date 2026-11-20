import { describe, expect, it } from 'vitest';
import { ItemCsvRow, LocationCsvRow } from '@ageless/shared';
import { ExistingItem, ImportCategory, ImportLocation, ImportUnit, planItemImport } from './item-import';
import { ExistingLocation, ImportJob, planLocationImport } from './location-import';

describe('items CSV', () => {
  const categories: ImportCategory[] = [
    { id: 10, name: 'Electronic components', codePrefix: 'EC', status: 'active' },
    { id: 11, name: 'Old stuff', codePrefix: 'OLD', status: 'inactive' },
  ];
  const units: ImportUnit[] = [
    { id: 1, code: 'pcs', decimals: 0, status: 'active' },
    { id: 2, code: 'm', decimals: 2, status: 'active' },
    { id: 3, code: 'box', decimals: 0, status: 'active' },
    { id: 4, code: 'gross', decimals: 0, status: 'inactive' },
  ];
  const locations: ImportLocation[] = [{ id: 7, code: 'STORE', type: 'store', status: 'active' }, { id: 8, code: 'SCRAP', type: 'scrap', status: 'active' }];
  const items: ExistingItem[] = [{ code: 'EC-0002', name: 'Relay module 5 V' }];
  // rows as they arrive from the CSV: strings, parsed by the shared row schema
  const rows = (...r: Record<string, string>[]) => r.map((values, i) => ({ row: i + 2, data: ItemCsvRow.parse({ category: 'EC', unit: 'pcs', ...values }) }));
  const plan = (...r: Record<string, string>[]) => planItemImport(rows(...r), { categories, units, locations, items });

  it('new rows get the next codes of their category (past codes typed in the file); cells are read from text', () => {
    const { planned, problems } = plan(
      { name: 'Sensor A', category: 'electronic components', reorder_level: '1,000', default_location: 'store' },
      { name: 'Sensor B', code: 'ec-0005', hsn_code: '85365090' },
      { name: 'Wire', unit: 'M', reorder_level: '2.5', purchase_unit: 'box', purchase_factor: '100', is_stocked: 'Yes', tracking: 'Batch' },
    );
    expect(problems).toEqual([]);
    expect(planned.map((p) => [p.row, p.code, p.result])).toEqual([[2, 'EC-0006', 'created'], [3, 'EC-0005', 'created'], [4, 'EC-0007', 'created']]);
    expect(planned[0].content).toMatchObject({ reorderLevel: 1000, defaultLocationId: 7, tracking: 'none', isStocked: true });
    expect(planned[1].content?.hsnCode).toBe('85365090');
    expect(planned[2]).toMatchObject({ content: { baseUnitId: 2, reorderLevel: 2.5, tracking: 'batch' }, conversion: { unitId: 3, factor: 100 } });
  });

  it('skips duplicates by code (in the company or the file), and by name when a row has no code', () => {
    const { planned, problems } = plan(
      { name: 'Anything', code: 'EC-0002' },
      { name: 'New one', code: 'EC-0100' },
      { name: 'Other name', code: 'EC-0100' },
      { name: 'relay MODULE 5 v' },
      { name: 'Twice' },
      { name: 'twice' },
    );
    expect(problems).toEqual([]);
    expect(planned.map((p) => [p.row, p.result, p.reason])).toEqual([
      [2, 'skipped', 'This code is already used by an item of the company'],
      [3, 'created', null],
      [4, 'skipped', 'Row 3 has the same code'],
      [5, 'skipped', 'An item with this name is already there (EC-0002)'],
      [6, 'created', null],
      [7, 'skipped', 'Row 6 has the same name'],
    ]);
  });

  it('refuses unknown or inactive categories, units and locations, and names used by other items', () => {
    const { planned, problems } = plan(
      { name: 'Item A', category: 'Nope' },
      { name: 'Item B', category: 'Old stuff' },
      { name: 'Item C', unit: 'kg' },
      { name: 'Item D', purchase_unit: 'gross', purchase_factor: '144' },
      { name: 'Item E', purchase_unit: 'box' },
      { name: 'Item F', default_location: 'NOWHERE' },
      { name: 'Relay module 5 V', code: 'EC-0200' },
    );
    expect(problems.map((p) => [p.row, p.field])).toEqual([
      [2, 'category'], [3, 'category'], [4, 'unit'], [5, 'purchase_unit'], [6, 'purchase_factor'], [7, 'default_location'], [8, 'name'],
    ]);
    expect(problems[0].message).toBe('No category named "Nope" (or with that code prefix): add it first');
    expect(problems[6].message).toBe('This name is already used (item EC-0002)');
    expect(planned).toEqual([]);
  });

  it('applies the item rules to each row', () => {
    const { problems } = plan(
      { name: 'Item A', reorder_level: '1.5' },
      { name: 'Item B', purchase_unit: 'pcs', purchase_factor: '2' },
      { name: 'Item C', tracking: 'serial', unit: 'm' },
      { name: 'Item D', is_stocked: 'no', reorder_level: '5' },
      { name: 'Item E', default_location: 'SCRAP' },
    );
    expect(problems.map((p) => [p.row, p.field])).toEqual([[2, 'reorder_level'], [3, 'purchase_unit'], [4, 'tracking'], [5, 'reorder_level'], [6, 'default_location']]);
  });
});

describe('locations CSV', () => {
  const existing: ExistingLocation[] = [{ id: 1, code: 'STORE', type: 'store', status: 'active' }, { id: 2, code: 'OLD', type: 'store', status: 'inactive' }];
  const jobs: ImportJob[] = [{ id: 50, employeeCode: 'ATH001', current: true }, { id: 51, employeeCode: 'ATH002', current: false }];
  const rows = (...r: Record<string, string>[]) => r.map((values, i) => ({ row: i + 2, data: LocationCsvRow.parse(values) }));
  const plan = (...r: Record<string, string>[]) => planLocationImport(rows(...r), { locations: existing, jobs });

  it('creates parents from the same file first, finds existing parents, and reads custodians by employee code', () => {
    const { planned, problems } = plan(
      { code: 'LAB-BIN-1', name: 'Lab bin', type: 'bin', parent: 'LAB-RACK' },
      { code: 'LAB-RACK', name: 'Lab rack', type: 'Rack', parent: 'LAB' },
      { code: 'LAB', name: 'Lab store', type: 'store', custodian: 'ath001' },
      { code: 'STORE-B', name: 'Rack B', type: 'rack', parent: 'STORE' },
      { code: 'STORE', name: 'Again', type: 'store', custodian: 'ATH001' },
      { code: 'WA', name: 'Work area', type: 'work area', custodian: 'ATH001' },
    );
    expect(problems).toEqual([]);
    expect(planned.map((p) => [p.code, p.result])).toEqual([
      ['LAB', 'created'], ['WA', 'created'], ['LAB-RACK', 'created'], ['STORE-B', 'created'], ['LAB-BIN-1', 'created'], ['STORE', 'skipped'],
    ]);
    expect(planned[0].custodianEmploymentId).toBe(50);
    expect(planned.find((p) => p.code === 'LAB-RACK')?.parent).toEqual({ code: 'LAB' });
    expect(planned.find((p) => p.code === 'STORE-B')?.parent).toEqual({ id: 1 });
  });

  it('refuses unknown or inactive parents, wrong placement and missing or past custodians', () => {
    const { problems } = plan(
      { code: 'R1', name: 'Rack one', type: 'rack', parent: 'NOPE' },
      { code: 'R2', name: 'Rack two', type: 'rack', parent: 'OLD' },
      { code: 'R3', name: 'Rack three', type: 'rack' },
      { code: 'Q1', name: 'Quarantine', type: 'quarantine', parent: 'STORE', custodian: 'ATH001' },
      { code: 'S1', name: 'Store one', type: 'store' },
      { code: 'S2', name: 'Store two', type: 'store', custodian: 'ATH002' },
      { code: 'S3', name: 'Store three', type: 'store', custodian: 'XYZ' },
    );
    expect(problems.map((p) => [p.row, p.field])).toEqual([[2, 'parent'], [3, 'parent'], [4, 'parent'], [5, 'parent'], [6, 'custodian'], [7, 'custodian'], [8, 'custodian']]);
    expect(problems[2].message).toBe('A rack goes inside a store: give its parent');
    expect(problems[5].message).toBe('The job ATH002 is not current');
  });
});
