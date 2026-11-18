import type { ImportProblem, ItemCsvRow, LocationType } from '@ageless/shared';
import { nextItemCode } from './codes';
import { conversionProblems, ItemContent, itemProblems, UnitFacts } from './items';

export interface ImportCategory { id: number; name: string; codePrefix: string; status: string }
export interface ImportUnit extends UnitFacts { status: string }
export interface ImportLocation { id: number; code: string; type: LocationType; status: string }
export interface ExistingItem { code: string; name: string }
export interface PlannedItem {
  row: number; code: string; name: string; result: 'created' | 'skipped'; reason: string | null;
  content?: ItemContent; conversion?: { unitId: number; factor: number };
}

/**
 * Checks an items CSV against the company's categories, units, locations and items, and says what each row would do
 * (rows are spreadsheet row numbers). Duplicates are skipped, not refused: a code the company already uses or an earlier
 * row used; without a code, a name already there or on an earlier row. Every other row must be valid (known, active
 * category and units; a default location that can hold stock; the item rules; a name not used by another item) or the
 * whole file is refused. A row without a code gets the next code of its category, past every code in use or in the file.
 */
export function planItemImport(
  rows: { row: number; data: ItemCsvRow }[],
  known: { categories: ImportCategory[]; units: ImportUnit[]; locations: ImportLocation[]; items: ExistingItem[] },
): { planned: PlannedItem[]; problems: ImportProblem[] } {
  const categoryByName = new Map(known.categories.map((c) => [c.name.toLowerCase(), c]));
  const categoryByPrefix = new Map(known.categories.map((c) => [c.codePrefix, c]));
  const unitByCode = new Map(known.units.map((u) => [u.code, u]));
  const locationByCode = new Map(known.locations.map((l) => [l.code, l]));
  const itemByCode = new Map(known.items.map((i) => [i.code, i]));
  const itemByName = new Map(known.items.map((i) => [i.name.toLowerCase(), i]));
  const usedCodes = new Set([...itemByCode.keys(), ...rows.flatMap((r) => (r.data.code ? [r.data.code] : []))]);
  const rowOfCode = new Map<string, number>();
  const rowOfName = new Map<string, number>();
  const planned: PlannedItem[] = [];
  const problems: ImportProblem[] = [];

  for (const { row, data: r } of rows) {
    const skip = (reason: string) => planned.push({ row, code: r.code ?? '', name: r.name, result: 'skipped', reason });
    const nameKey = r.name.toLowerCase();
    if (r.code) {
      if (itemByCode.has(r.code)) { skip('This code is already used by an item of the company'); continue; }
      const earlier = rowOfCode.get(r.code);
      if (earlier) { skip(`Row ${earlier} has the same code`); continue; }
    } else {
      const existing = itemByName.get(nameKey);
      if (existing) { skip(`An item with this name is already there (${existing.code})`); continue; }
      const earlier = rowOfName.get(nameKey);
      if (earlier) { skip(`Row ${earlier} has the same name`); continue; }
    }

    const before = problems.length;
    const add = (field: string, message: string) => problems.push({ row, field, message });
    const activeUnit = (code: string, field: string) => {
      const u = unitByCode.get(code.toLowerCase());
      if (!u) add(field, `No unit with the code "${code}": add it first`);
      else if (u.status !== 'active') add(field, `The unit "${u.code}" is inactive`);
      return u?.status === 'active' ? u : undefined;
    };
    const category = categoryByName.get(r.category.toLowerCase()) ?? categoryByPrefix.get(r.category.toUpperCase());
    if (!category) add('category', `No category named "${r.category}" (or with that code prefix): add it first`);
    else if (category.status !== 'active') add('category', `The category "${category.name}" is inactive`);
    const baseUnit = activeUnit(r.unit, 'unit');
    let purchaseUnit: ImportUnit | undefined;
    if ((r.purchase_unit === undefined) !== (r.purchase_factor === undefined)) {
      add('purchase_factor', 'Give the purchase unit and how many base units it holds together');
    } else if (r.purchase_unit !== undefined) {
      purchaseUnit = activeUnit(r.purchase_unit, 'purchase_unit');
    }
    let location: ImportLocation | undefined;
    if (r.default_location) {
      location = locationByCode.get(r.default_location);
      if (!location) add('default_location', `No location with the code ${r.default_location}`);
      else if (location.status !== 'active') add('default_location', `The location ${location.code} is inactive`);
    }
    const sameName = itemByName.get(nameKey) ?? (rowOfName.has(nameKey) ? { code: `on row ${rowOfName.get(nameKey)}` } : undefined);
    if (sameName) add('name', `This name is already used (item ${sameName.code})`);
    rowOfName.set(nameKey, row);
    if (r.code) rowOfCode.set(r.code, row);
    if (problems.length > before || !category || !baseUnit) continue;

    const content: ItemContent = {
      name: r.name, description: r.description ?? null, categoryId: category.id, baseUnitId: baseUnit.id, tracking: r.tracking ?? 'none',
      hsnCode: r.hsn_code ?? null, isStocked: r.is_stocked ?? true, reorderLevel: r.reorder_level ?? null, reorderQty: r.reorder_qty ?? null,
      defaultLocationId: location?.id ?? null,
    };
    const rules = [...itemProblems(content, baseUnit, location?.type ?? null),
      ...(purchaseUnit ? conversionProblems(baseUnit.id, [{ unitId: purchaseUnit.id, unitCode: purchaseUnit.code }]) : [])];
    for (const p of rules) add(CSV_FIELD[p.field] ?? p.field, p.message);
    if (problems.length > before) continue;

    const code = r.code ?? nextItemCode(category.codePrefix, usedCodes);
    usedCodes.add(code);
    planned.push({ row, code, name: r.name, result: 'created', reason: null, content,
      conversion: purchaseUnit && r.purchase_factor !== undefined ? { unitId: purchaseUnit.id, factor: r.purchase_factor } : undefined });
  }
  return { planned, problems };
}

/** Item rule fields as the CSV columns name them. */
const CSV_FIELD: Record<string, string> = {
  reorderLevel: 'reorder_level', reorderQty: 'reorder_qty', defaultLocation: 'default_location', conversions: 'purchase_unit',
};
