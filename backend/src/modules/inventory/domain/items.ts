import type { ItemTracking, LocationType } from '@ageless/shared';
import { canHoldNewStock, locationLabel } from './locations';
import { fitsDecimals } from './quantities';

/** What an item says about itself (ids of its own company's category, unit and location). */
export interface ItemContent {
  name: string;
  description: string | null;
  categoryId: number;
  baseUnitId: number;
  tracking: ItemTracking;
  hsnCode: string | null;
  isStocked: boolean;
  reorderLevel: number | null;
  reorderQty: number | null;
  defaultLocationId: number | null;
}

export interface UnitFacts { id: number; code: string; decimals: number }
export interface Problem { field: string; message: string }

const KEYS: (keyof ItemContent)[] = ['name', 'description', 'categoryId', 'baseUnitId', 'tracking', 'hsnCode', 'isStocked', 'reorderLevel',
  'reorderQty', 'defaultLocationId'];

/** "whole numbers" for a unit with 0 decimals, else "at most 2 decimals". */
const allowed = (u: UnitFacts) => (u.decimals === 0 ? `whole numbers for ${u.code}` : `at most ${u.decimals} decimals for ${u.code}`);

/**
 * What is wrong with an item as it would be saved (empty: nothing). A non-stocked item has no tracking, reorder values or
 * default location; serial items are counted in whole pieces; reorder quantities fit the base unit's decimals; the
 * default location can hold new stock (not transit, quarantine or scrap).
 */
export function itemProblems(c: ItemContent, baseUnit: UnitFacts, defaultLocationType: LocationType | null): Problem[] {
  const problems: Problem[] = [];
  if (!c.isStocked) {
    if (c.tracking !== 'none') problems.push({ field: 'tracking', message: 'A non-stocked item has no batch or serial tracking' });
    if (c.reorderLevel !== null || c.reorderQty !== null) problems.push({ field: 'reorderLevel', message: 'A non-stocked item has no reorder level or quantity' });
    if (c.defaultLocationId !== null) problems.push({ field: 'defaultLocation', message: 'A non-stocked item has no default location' });
  }
  if (c.tracking === 'serial' && baseUnit.decimals > 0) {
    problems.push({ field: 'tracking', message: `Serial-numbered items are counted in whole pieces: use a unit with 0 decimals, not ${baseUnit.code}` });
  }
  for (const field of ['reorderLevel', 'reorderQty'] as const) {
    const q = c[field];
    if (q !== null && !fitsDecimals(q, baseUnit.decimals)) problems.push({ field, message: `Use ${allowed(baseUnit)}` });
  }
  if (defaultLocationType !== null && !canHoldNewStock(defaultLocationType)) {
    problems.push({ field: 'defaultLocation', message: `The default location must be a store, rack, bin, work area or testing space, not a ${locationLabel(defaultLocationType)}` });
  }
  return problems;
}

/** What is wrong with an item's unit conversions: a unit listed twice, or the base unit itself. */
export function conversionProblems(baseUnitId: number, conversions: { unitId: number; unitCode: string }[]): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<number>();
  for (const c of conversions) {
    if (c.unitId === baseUnitId) problems.push({ field: 'conversions', message: `${c.unitCode} is the base unit; a conversion is for another unit` });
    else if (seen.has(c.unitId)) problems.push({ field: 'conversions', message: `${c.unitCode} is listed twice` });
    seen.add(c.unitId);
  }
  return problems;
}

/** The fields that differ between two versions of an item (empty: the same). */
export function changedFields(before: ItemContent, after: ItemContent): (keyof ItemContent)[] {
  return KEYS.filter((k) => before[k] !== after[k]);
}
