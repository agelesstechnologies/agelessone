import { describe, expect, it } from 'vitest';
import { correctionPunches, stepNotAllowed, timesOnDate } from './corrections';

describe('timesOnDate', () => {
  it('times inside the IST date are fine, the next IST midnight is not', () => {
    expect(timesOnDate('2026-07-07', ['2026-07-07T00:00:00+05:30', '2026-07-07T23:59:00+05:30', undefined])).toBe(true);
    expect(timesOnDate('2026-07-07', ['2026-07-08T00:00:00+05:30'])).toBe(false);
    expect(timesOnDate('2026-07-07', ['2026-07-06T23:59:00+05:30'])).toBe(false);
  });
  it('the same instant written in UTC counts by its IST date', () => {
    expect(timesOnDate('2026-07-07', ['2026-07-06T19:00:00Z'])).toBe(true); // 00:30 IST on the 7th
  });
});

describe('correctionPunches', () => {
  it('in then out, only the ones given', () => {
    const at = (t: string) => new Date(`2026-07-07T${t}:00+05:30`);
    expect(correctionPunches({ requestedIn: at('09:00'), requestedOut: at('18:00') })).toEqual([{ kind: 'in', at: at('09:00') }, { kind: 'out', at: at('18:00') }]);
    expect(correctionPunches({ requestedIn: null, requestedOut: at('18:00') })).toEqual([{ kind: 'out', at: at('18:00') }]);
  });
});

describe('stepNotAllowed', () => {
  it('only a submitted correction moves on', () => {
    expect(stepNotAllowed('submitted', 'approve')).toBeNull();
    expect(stepNotAllowed('approved', 'cancel')).toBe('HRMS_CORRECTION_NOT_PENDING');
  });
});
