/**
 * Quantities have at most 4 decimals and factors at most 6 (checked when they arrive), so they are handled as whole
 * ten-thousandths and millionths: no floating-point noise in comparisons or conversions.
 */
const QTY_SCALE = 4;
const FACTOR_SCALE = 6;

const scaled = (n: number, scale: number): bigint => BigInt(Math.round(n * 10 ** scale));

/** Whether a quantity can be written with at most `decimals` decimals (a unit's limit: pieces 0, metres 2, kilograms 3). */
export function fitsDecimals(quantity: number, decimals: number): boolean {
  const exact = quantity * 10 ** QTY_SCALE;
  if (Math.abs(exact - Math.round(exact)) > 1e-3) return false;
  return scaled(quantity, QTY_SCALE) % 10n ** BigInt(QTY_SCALE - Math.min(Math.max(decimals, 0), QTY_SCALE)) === 0n;
}

/**
 * A quantity in another unit, in base units: quantity × factor, rounded half up to the base unit's decimals.
 * 3 boxes of 100 pieces → 300; 7 ft at 0.3048 m → 2.1336 m → 2.13 in a 2-decimal unit.
 */
export function toBaseQuantity(quantity: number, factor: number, baseDecimals: number): number {
  const product = scaled(quantity, QTY_SCALE) * scaled(factor, FACTOR_SCALE);           // in units of 10^-(4+6)
  const divisor = 10n ** BigInt(QTY_SCALE + FACTOR_SCALE - baseDecimals);
  const rounded = (product + divisor / 2n) / divisor;                                     // half up (never negative)
  return Number(rounded) / 10 ** baseDecimals;
}
