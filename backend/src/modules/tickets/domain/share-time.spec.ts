import { describe, expect, it } from 'vitest';
import { punchedInAt, shareTime, toMinutes } from './share-time';

const H = 3_600_000;
const at = (hours: number) => Date.UTC(2026, 9, 5, 3, 30) + hours * H; // 09:00 IST + hours
const day = [{ start: at(0), end: at(9) }];
const asObject = (m: Map<number, number>) => Object.fromEntries(m);

describe('shared ticket time (equal split)', () => {
  it('three tickets for 3 h, then two of them for 5 h: 1 h / 3.5 h / 3.5 h', () => {
    const r = shareTime([
      { ticket: 1, start: at(0), end: at(3) },
      { ticket: 2, start: at(0), end: at(8) },
      { ticket: 3, start: at(0), end: at(8) },
    ], day, 540);
    expect(asObject(r)).toEqual({ 1: 60, 2: 210, 3: 210 });
  });

  it('one ticket alone gets all of its time; staggered timers share only where they overlap', () => {
    expect(asObject(shareTime([{ ticket: 1, start: at(1), end: at(3) }], day, 540))).toEqual({ 1: 120 });
    const r = shareTime([{ ticket: 1, start: at(0), end: at(2) }, { ticket: 2, start: at(1), end: at(3) }], day, 540);
    expect(asObject(r)).toEqual({ 1: 90, 2: 90 }); // 1 h alone + 1 h shared (30 min each) + 1 h alone
  });

  it('two timers on the same ticket at once count once', () => {
    expect(asObject(shareTime([{ ticket: 1, start: at(0), end: at(2) }, { ticket: 1, start: at(1), end: at(2) }], day, 540))).toEqual({ 1: 120 });
  });

  it('time outside attendance counts for nothing (an unfinished overnight timer adds no hours)', () => {
    const attended = [{ start: at(0), end: at(2) }, { start: at(3), end: at(4) }];
    expect(asObject(shareTime([{ ticket: 1, start: at(0), end: at(20) }], attended, 180))).toEqual({ 1: 180 });
    expect(shareTime([{ ticket: 1, start: at(5), end: at(5) }], day, 540).size).toBe(0);
  });

  it('the total never exceeds the attendance minutes (ceiling)', () => {
    const r = shareTime([{ ticket: 1, start: at(0), end: at(6) }, { ticket: 2, start: at(6), end: at(9) }], day, 300);
    expect([...r.values()].reduce((a, b) => a + b, 0)).toBe(300);
    expect(asObject(r)).toEqual({ 1: 200, 2: 100 });
  });

  it('rounding keeps the total: three tickets for 10 minutes', () => {
    const r = shareTime([1, 2, 3].map((ticket) => ({ ticket, start: at(0), end: at(0) + 10 * 60000 })), day, 540);
    expect([...r.values()].sort()).toEqual([3, 3, 4]);
    expect(asObject(toMinutes(new Map(), 100))).toEqual({});
  });
});

describe('punched in for the day', () => {
  const t = new Date(at(1));
  it('only on a real, open punch-in no older than the open-punch limit', () => {
    expect(punchedInAt({ kind: 'in', at: new Date(at(0)), auto: false }, t, 16)).toBe(true);
    expect(punchedInAt(undefined, t, 16)).toBe(false);
    expect(punchedInAt({ kind: 'out', at: new Date(at(0)), auto: false }, t, 16)).toBe(false);
    expect(punchedInAt({ kind: 'in', at: new Date(at(2)), auto: false }, t, 16)).toBe(false);   // punched in later than that
    expect(punchedInAt({ kind: 'in', at: new Date(at(0)), auto: false }, new Date(at(17)), 16)).toBe(false); // a missed punch by then
  });
});
