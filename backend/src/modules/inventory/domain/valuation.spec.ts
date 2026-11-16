import { describe, expect, it } from 'vitest';
import { applyChange, divRound, fromScaled, lineValue, outgoingValue, toScaled, unitCostOf, Valuation, valueAt } from './valuation';
import { documentDateProblem, documentNumber, itemStockProblem, locationUseProblem, returnLocationTypes } from './stock-rules';

const empty: Valuation = { qty: 0n, value: 0n, avg: 0n };
const qty = (n: number) => toScaled(n, 4);

describe('exact numbers', () => {
  it('reads and writes decimals as scaled integers, rounding half away from zero', () => {
    expect(toScaled('12.5', 4)).toBe(125000n);
    expect(toScaled('-0.0001', 4)).toBe(-1n);
    expect(toScaled(3, 4)).toBe(30000n);
    expect(toScaled('1.23456', 4)).toBe(12346n);
    expect(toScaled('1333.3333335', 6)).toBe(1333333334n);
    expect(fromScaled(125000n, 4)).toBe('12.5000');
    expect(fromScaled(-1n, 4)).toBe('-0.0001');
    expect(fromScaled(7n, 0)).toBe('7');
    expect([divRound(5n, 2n), divRound(-5n, 2n), divRound(4n, 3n), divRound(-4n, 3n)]).toEqual([3n, -3n, 1n, -1n]);
  });
  it('values and unit costs: half up to paise, costs to millionths', () => {
    expect(unitCostOf(1000n, qty(3))).toBe(333_333_333n);          // ₹10 for 3 pieces: 333.333333 paise each
    expect(valueAt(qty(3), 333_333_333n)).toBe(1000n);
    expect(lineValue(qty(2.5), 1999n)).toBe(4998n);                 // 2.5 × 19.99 = 49.975 → 49.98
    expect(lineValue(qty(3), 0n)).toBe(0n);
  });
});

describe('moving weighted average', () => {
  it('receipts recalculate the average from what is in stock', () => {
    const first = applyChange(empty, qty(10), 1000n, true) as Valuation;
    expect(first).toEqual({ qty: qty(10), value: 1000n, avg: 100_000_000n });             // 100 paise each
    const second = applyChange(first, qty(10), 3000n, true) as Valuation;
    expect(second).toEqual({ qty: qty(20), value: 4000n, avg: 200_000_000n });
    const third = applyChange(second, qty(10), 0n, true) as Valuation;                    // free samples lower it
    expect(third.avg).toBe(133_333_333n);
  });

  it('issues take the average and keep it; emptying the stock takes all the value', () => {
    const v: Valuation = { qty: qty(30), value: 40000n, avg: 1_333_333_333n };
    expect(outgoingValue(v, qty(3))).toBe(4000n);
    const after = applyChange(v, -qty(3), -4000n, false) as Valuation;
    expect(after).toEqual({ qty: qty(27), value: 36000n, avg: 1_333_333_333n });
    expect(outgoingValue(after, qty(27))).toBe(36000n);
    expect(outgoingValue({ qty: qty(3), value: 1000n, avg: 333_333_334n }, qty(2))).toBe(667n);
    expect(outgoingValue({ qty: qty(2), value: 1n, avg: 900_000n }, qty(1))).toBe(1n);   // never more than there is
  });

  it('refuses what cannot be: less than nothing, negative value, value with nothing in stock', () => {
    const v: Valuation = { qty: qty(5), value: 500n, avg: 100_000_000n };
    expect(applyChange(v, -qty(6), -600n, false)).toBeNull();
    expect(applyChange(v, -qty(1), -600n, false)).toBeNull();
    expect(applyChange(v, -qty(5), -400n, true)).toBeNull();
    expect(applyChange(v, -qty(5), -500n, true)).toEqual({ qty: 0n, value: 0n, avg: 100_000_000n });   // empty keeps the last average
  });
});

describe('stock rules', () => {
  it('locations by use', () => {
    expect(locationUseProblem('receive', 'bin')).toBeNull();
    expect(locationUseProblem('issue', 'quarantine')).toBe('Issued stock is kept in a store, rack, bin, work area or testing space, not a quarantine location');
    expect(locationUseProblem('repair', 'quarantine')).toBeNull();
    expect(locationUseProblem('repair', 'store')).toBe('A part for repair goes to a quarantine location, not a store');
    expect(locationUseProblem('scrap', 'scrap')).toBeNull();
    expect(locationUseProblem('transfer_to', 'scrap')).toBeNull();
    expect(locationUseProblem('transfer_from', 'transit')).not.toBeNull();
    expect(locationUseProblem('transit', 'store')).toBe('The transit location must be of type transit, not a store');
    expect(returnLocationTypes('scrap')).toEqual(['scrap']);
  });
  it('numbers, dates and items', () => {
    expect(documentNumber('receipt', 1)).toBe('GRN-00001');
    expect(documentNumber('issue', 123456)).toBe('ISS-123456');
    expect(documentDateProblem('2026-11-15', '2026-11-14', false)).toBe('A stock document cannot be dated in the future');
    expect(documentDateProblem('2026-10-31', '2026-11-14', true)).toBe('Accounts has closed 2026-10: date the document in an open month');
    expect(documentDateProblem('2026-11-14', '2026-11-14', false)).toBeNull();
    expect(itemStockProblem({ code: 'X-1', isStocked: false, tracking: 'none' })).toContain('not a stocked item');
    expect(itemStockProblem({ code: 'X-1', isStocked: true, tracking: 'serial' })).toContain('tracked by serial');
    expect(itemStockProblem({ code: 'X-1', isStocked: true, tracking: 'none' })).toBeNull();
  });
});
