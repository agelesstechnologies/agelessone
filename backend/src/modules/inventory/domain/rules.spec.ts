import { describe, expect, it } from 'vitest';
import { locationReach, mayUseCompany, reachableCompanies } from './access';
import { nextItemCode } from './codes';
import { changedFields, conversionProblems, ItemContent, itemProblems } from './items';
import { canHoldNewStock, needsCustodian, placementProblem, responsibleFor, responsibleLocations } from './locations';
import { fitsDecimals, toBaseQuantity } from './quantities';

describe('company access', () => {
  it('scope all reaches every company; a narrower scope only the companies worked in; no permission none', () => {
    expect(reachableCompanies(['all', undefined], [1, 2], [])).toEqual([1, 2]);
    expect(reachableCompanies(['own'], [1, 2], [2])).toEqual([2]);
    expect(reachableCompanies([undefined, 'team'], [1, 2], [1, 2])).toEqual([1, 2]);
    expect(reachableCompanies([undefined, undefined], [1, 2], [1, 2])).toEqual([]);
    expect(mayUseCompany(['own'], true)).toBe(true);
    expect(mayUseCompany(['own'], false)).toBe(false);
    expect(mayUseCompany(['all'], false)).toBe(true);
    expect(mayUseCompany([undefined], true)).toBe(false);
  });
  it('locations: all reaches every one; team every one of a company worked in; own only the ones looked after', () => {
    expect(locationReach(['all'], false)).toBe('every');
    expect(locationReach(['team'], true)).toBe('every');
    expect(locationReach(['own', 'team'], true)).toBe('every');   // the widest scope wins
    expect(locationReach(['own'], true)).toBe('responsible');
    expect(locationReach(['team'], false)).toBe('none');
    expect(locationReach([undefined], true)).toBe('none');
  });
});

describe('item codes', () => {
  it('continue after the highest number of the prefix, typed codes included, other prefixes ignored', () => {
    expect(nextItemCode('EC', [])).toBe('EC-0001');
    expect(nextItemCode('EC', ['EC-0001', 'EC-0007', 'ECX-0100', 'EC-12A', 'CF-0050'])).toBe('EC-0008');
    expect(nextItemCode('EC', ['EC-9999'])).toBe('EC-10000');
  });
});

describe('quantities and unit conversion', () => {
  it('fit a unit\'s decimals, compared as whole ten-thousandths', () => {
    expect(fitsDecimals(3, 0)).toBe(true);
    expect(fitsDecimals(1.5, 0)).toBe(false);
    expect(fitsDecimals(1.25, 2)).toBe(true);
    expect(fitsDecimals(0.1 + 0.2, 1)).toBe(true);   // 0.30000000000000004
    expect(fitsDecimals(1.125, 2)).toBe(false);
    expect(fitsDecimals(0.0001, 4)).toBe(true);
    expect(fitsDecimals(0.00005, 4)).toBe(false);
  });
  it('converts to base units exactly, rounding half up to the base unit\'s decimals', () => {
    expect(toBaseQuantity(3, 100, 0)).toBe(300);                 // 3 boxes of 100 pieces
    expect(toBaseQuantity(2.5, 1, 3)).toBe(2.5);                 // 2.5 spools of 1 kg
    expect(toBaseQuantity(7, 0.3048, 2)).toBe(2.13);             // 7 ft = 2.1336 m
    expect(toBaseQuantity(7, 0.3048, 4)).toBe(2.1336);
    expect(toBaseQuantity(1.5, 12, 0)).toBe(18);                 // 1.5 dozen
    expect(toBaseQuantity(0.1, 3, 1)).toBe(0.3);                 // no 0.30000000000000004
    expect(toBaseQuantity(0.125, 1, 2)).toBe(0.13);              // half up
    expect(toBaseQuantity(0.0001, 0.000001, 4)).toBe(0);
    expect(toBaseQuantity(999_999_999, 1_000_000, 0)).toBe(999_999_999_000_000);
  });
});

describe('item rules', () => {
  const pcs = { id: 1, code: 'pcs', decimals: 0 };
  const m = { id: 2, code: 'm', decimals: 2 };
  const item = (over: Partial<ItemContent> = {}): ItemContent => ({
    name: 'Relay module', description: null, categoryId: 9, baseUnitId: 1, tracking: 'none', hsnCode: null, isStocked: true,
    reorderLevel: null, reorderQty: null, defaultLocationId: null, ...over,
  });
  const fields = (c: ItemContent, unit = pcs, location: Parameters<typeof itemProblems>[2] = null) => itemProblems(c, unit, location).map((p) => p.field);

  it('accepts a plain stocked item and a non-stocked one', () => {
    expect(fields(item({ reorderLevel: 20, reorderQty: 100, defaultLocationId: 5 }), pcs, 'bin')).toEqual([]);
    expect(fields(item({ isStocked: false }))).toEqual([]);
  });
  it('a non-stocked item has no tracking, reorder values or default location', () => {
    expect(fields(item({ isStocked: false, tracking: 'batch', reorderLevel: 5, defaultLocationId: 5 }), pcs, 'store'))
      .toEqual(['tracking', 'reorderLevel', 'defaultLocation']);
  });
  it('quantities fit the base unit\'s decimals; serial items use a whole-number unit', () => {
    expect(fields(item({ reorderLevel: 1.5, reorderQty: 2.5 }))).toEqual(['reorderLevel', 'reorderQty']);
    expect(fields(item({ baseUnitId: 2, reorderLevel: 1.5 }), m)).toEqual([]);
    expect(itemProblems(item({ reorderLevel: 1.5 }), pcs, null)[0].message).toBe('Use whole numbers for pcs');
    expect(fields(item({ tracking: 'serial' }))).toEqual([]);
    expect(fields(item({ baseUnitId: 2, tracking: 'serial' }), m)).toEqual(['tracking']);
  });
  it('the default location can hold new stock', () => {
    for (const type of ['store', 'rack', 'bin', 'work_area', 'testing'] as const) expect(canHoldNewStock(type)).toBe(true);
    expect(fields(item({ defaultLocationId: 5 }), pcs, 'scrap')).toEqual(['defaultLocation']);
    expect(fields(item({ defaultLocationId: 5 }), pcs, 'transit')).toEqual(['defaultLocation']);
  });
  it('a conversion is for another unit than the base, each unit once', () => {
    expect(conversionProblems(1, [{ unitId: 3, unitCode: 'box' }, { unitId: 4, unitCode: 'pack' }])).toEqual([]);
    expect(conversionProblems(1, [{ unitId: 1, unitCode: 'pcs' }]).map((p) => p.message)).toEqual(['pcs is the base unit; a conversion is for another unit']);
    expect(conversionProblems(1, [{ unitId: 3, unitCode: 'box' }, { unitId: 3, unitCode: 'box' }]).map((p) => p.message)).toEqual(['box is listed twice']);
  });
  it('lists the fields that changed', () => {
    expect(changedFields(item(), item())).toEqual([]);
    expect(changedFields(item(), item({ name: 'Relay', hsnCode: '8536' }))).toEqual(['name', 'hsnCode']);
  });
});

describe('location rules', () => {
  it('a rack goes in a store, a bin in a store or rack, everything else stands alone', () => {
    expect(placementProblem('store', null)).toBeNull();
    expect(placementProblem('rack', 'store')).toBeNull();
    expect(placementProblem('bin', 'rack')).toBeNull();
    expect(placementProblem('bin', 'store')).toBeNull();
    expect(placementProblem('rack', null)).toBe('a rack goes inside a store: give its parent');
    expect(placementProblem('rack', 'work_area')).toBe('a rack goes inside a store, not a work area');
    expect(placementProblem('bin', 'bin')).toBe('a bin goes inside a store or rack, not a bin');
    expect(placementProblem('quarantine', 'store')).toBe('a quarantine location stands on its own; it cannot be inside another location');
  });
  it('racks and bins may leave the custodian to their parent', () => {
    expect(needsCustodian('store')).toBe(true);
    expect(needsCustodian('scrap')).toBe(true);
    expect(needsCustodian('rack')).toBe(false);
    expect(needsCustodian('bin')).toBe(false);
  });
  it('the responsible person is the location\'s own custodian, else the nearest parent\'s', () => {
    const byId = new Map([
      [1, { parentId: null, custodian: 'keeper' }],
      [2, { parentId: 1, custodian: null }],
      [3, { parentId: 2, custodian: null }],
      [4, { parentId: 1, custodian: 'other' }],
    ]);
    expect(responsibleFor(3, byId)).toBe('keeper');
    expect(responsibleFor(4, byId)).toBe('other');
    expect(responsibleFor(99, byId)).toBeNull();
  });
  it('a person is responsible for the locations they keep, and the racks and bins that fall back to them', () => {
    const all = [
      { id: 1, parentId: null, custodianEmploymentId: 50 },   // store kept by job 50
      { id: 2, parentId: 1, custodianEmploymentId: null },    // its rack
      { id: 3, parentId: 2, custodianEmploymentId: null },    // a bin in the rack
      { id: 4, parentId: 1, custodianEmploymentId: 60 },      // a rack someone else keeps
      { id: 5, parentId: null, custodianEmploymentId: 60 },
    ];
    expect([...responsibleLocations(all, [50])].sort()).toEqual([1, 2, 3]);
    expect([...responsibleLocations(all, [60])].sort()).toEqual([4, 5]);
    expect(responsibleLocations(all, []).size).toBe(0);
  });
});
