import { describe, expect, it } from 'vitest';
import { proportional } from './split-suggestion';

describe('proportional', () => {
  it('keeps the suggestion when the total has not changed', () => {
    expect(proportional([300, 120, 60], 480)).toEqual([300, 120, 60]);
  });

  it('scales to a new total in whole minutes that add up exactly', () => {
    const shares = proportional([70, 20, 10], 450);   // 315 / 90 / 45
    expect(shares).toEqual([315, 90, 45]);
    const odd = proportional([1, 1, 1], 100);         // 33.3 each: one extra minute to the first
    expect(odd).toEqual([34, 33, 33]);
    expect(odd.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('gives a ticket suggested at 0 nothing, and nothing at all when the weights are 0', () => {
    expect(proportional([0, 240], 200)).toEqual([0, 200]);
    expect(proportional([0, 0], 200)).toEqual([0, 0]);
  });
});
