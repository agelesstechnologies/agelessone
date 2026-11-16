/** Split suggestions: pure rules. */

/**
 * Shares `total` minutes in proportion to `weights` (a suggested split), in whole minutes that add up to exactly `total`:
 * each gets its rounded-down share, and the minutes left go one each to the largest remainders (the earlier one on a tie).
 * Used when the tickets' minutes changed between the suggestion and its approval (e.g. a corrected punch).
 */
export function proportional(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w * total) / sum);
  const shares = exact.map(Math.floor);
  let left = total - shares.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] += 1;
    left -= 1;
  }
  return shares;
}
