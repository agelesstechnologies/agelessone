import { describe, expect, it } from 'vitest';
import { rateInForce, ratesInForce } from './rates';

const card = (item: { serviceType?: string; grade?: string }, effectiveFrom: string, rateMinor: number) =>
  ({ serviceType: item.serviceType ?? null, grade: item.grade ?? null, effectiveFrom, rateMinor });

describe('rate in force by date', () => {
  const cards = [
    card({ serviceType: 'design' }, '2026-04-01', 150_000),
    card({ serviceType: 'design' }, '2026-10-01', 180_000),   // a new rate is a new row
    card({ serviceType: 'software' }, '2026-04-01', 200_000),
    card({ grade: 'G3' }, '2026-06-15', 90_000),
  ];

  it('a past month keeps the rate in force then; the new rate counts from its first day', () => {
    expect(rateInForce(cards, { serviceType: 'design' }, '2026-09-30')?.rateMinor).toBe(150_000);
    expect(rateInForce(cards, { serviceType: 'design' }, '2026-10-01')?.rateMinor).toBe(180_000);
    expect(rateInForce(cards, { serviceType: 'design' }, '2027-01-15')?.rateMinor).toBe(180_000);
  });

  it('no rate before the first one; a grade is its own item', () => {
    expect(rateInForce(cards, { serviceType: 'design' }, '2026-03-31')).toBeUndefined();
    expect(rateInForce(cards, { serviceType: 'cgi' }, '2026-10-01')).toBeUndefined();
    expect(rateInForce(cards, { grade: 'G3' }, '2026-06-14')).toBeUndefined();
    expect(rateInForce(cards, { grade: 'G3' }, '2026-06-15')?.rateMinor).toBe(90_000);
  });

  it('every item\'s rate on a date (the order of the rows does not matter)', () => {
    const on = (date: string) => ratesInForce([...cards].reverse(), date).map((c) => [c.serviceType ?? c.grade, c.rateMinor]);
    expect(on('2026-05-01')).toEqual(expect.arrayContaining([['design', 150_000], ['software', 200_000]]));
    expect(on('2026-05-01')).toHaveLength(2);
    expect(on('2026-11-01')).toEqual(expect.arrayContaining([['design', 180_000], ['software', 200_000], ['G3', 90_000]]));
  });
});
