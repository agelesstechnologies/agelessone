/**
 * Moving weighted average cost, in exact integers: quantities in ten-thousandths of a base unit (numeric(18,4)), values in
 * minor units (paise), average and unit costs in millionths of a minor unit (numeric(24,6)). No floating point, so the
 * same postings always give the same paise.
 */
export const QTY_SCALE = 10_000n;          // 4 decimals
export const COST_SCALE = 1_000_000n;      // 6 decimals

/** An item's stock in its company: quantity (×10⁴), value (minor units) and average cost (minor units ×10⁶ per base unit). */
export interface Valuation { qty: bigint; value: bigint; avg: bigint }

/** a / b rounded half away from zero (b > 0). */
export function divRound(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  return twice >= b ? q + (a < 0n ? -1n : 1n) : q;
}

/** An exact decimal ("12.5", "-0.0001", 3) as an integer with `scale` decimals; more decimals than that are rounded. */
export function toScaled(value: string | number, scale: number): bigint {
  const text = typeof value === 'number' ? value.toFixed(Math.min(scale + 2, 20)) : value.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`Not a decimal: ${value}`);
  const [, sign, whole, frac = ''] = m;
  const digits = BigInt(whole + frac.padEnd(scale + 1, '0').slice(0, scale + 1));   // one extra digit to round on
  const rounded = divRound(digits, 10n);
  return sign === '-' ? -rounded : rounded;
}

/** An integer with `scale` decimals as a decimal string ("12.5000"), for the database. */
export function fromScaled(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0');
  return scale === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** The value of a quantity at a unit cost, rounded half up to minor units. */
export function valueAt(qty: bigint, unitCost: bigint): bigint {
  return divRound(qty * unitCost, QTY_SCALE * COST_SCALE);
}

/** The unit cost (minor units ×10⁶ per base unit) of a value spread over a quantity; 0 for no quantity. */
export function unitCostOf(value: bigint, qty: bigint): bigint {
  const q = qty < 0n ? -qty : qty;
  const v = value < 0n ? -value : value;
  return q === 0n ? 0n : divRound(v * QTY_SCALE * COST_SCALE, q);
}

/** A receipt line's value: the quantity as entered (×10⁴) times the cost per entered unit in minor units, half up. */
export function lineValue(enteredQty: bigint, costPerUnitMinor: bigint): bigint {
  return divRound(enteredQty * costPerUnitMinor, QTY_SCALE);
}

/**
 * The value an outgoing quantity takes at the current average: all the remaining value when it empties the stock (so
 * nothing in stock never keeps a value), otherwise quantity × average, never more than there is.
 */
export function outgoingValue(v: Valuation, qty: bigint): bigint {
  if (qty >= v.qty) return v.value;
  const value = valueAt(qty, v.avg);
  return value > v.value ? v.value : value;
}

/**
 * Applies a change of quantity and value. `reprice` (receipts, returns, reversals that change the value) recalculates the
 * average from what is left; issues and transfers keep it. Returns null when the result is impossible: less than nothing,
 * a negative value, or value left with nothing in stock.
 */
export function applyChange(v: Valuation, qtyDelta: bigint, valueDelta: bigint, reprice: boolean): Valuation | null {
  const qty = v.qty + qtyDelta;
  const value = v.value + valueDelta;
  if (qty < 0n || value < 0n || (qty === 0n && value !== 0n)) return null;
  return { qty, value, avg: reprice && qty > 0n ? unitCostOf(value, qty) : v.avg };
}
