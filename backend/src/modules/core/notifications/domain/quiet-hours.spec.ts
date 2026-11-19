import { describe, expect, it } from 'vitest';
import { clockIst, inQuietHours } from './quiet-hours';

describe('quiet hours', () => {
  it('a same-day window is quiet from its start up to, not including, its end', () => {
    const q = { start: '13:00', end: '15:00' };
    expect(inQuietHours('12:59', q)).toBe(false);
    expect(inQuietHours('13:00', q)).toBe(true);
    expect(inQuietHours('14:59', q)).toBe(true);
    expect(inQuietHours('15:00', q)).toBe(false);
  });

  it('a window may cross midnight', () => {
    const q = { start: '22:00', end: '07:00' };
    expect(inQuietHours('21:59', q)).toBe(false);
    expect(inQuietHours('22:00', q)).toBe(true);
    expect(inQuietHours('00:00', q)).toBe(true);
    expect(inQuietHours('06:59', q)).toBe(true);
    expect(inQuietHours('07:00', q)).toBe(false);
    expect(inQuietHours('12:00', q)).toBe(false);
  });

  it('no window, or an empty one, is never quiet', () => {
    expect(inQuietHours('03:00', null)).toBe(false);
    expect(inQuietHours('03:00', { start: '08:00', end: '08:00' })).toBe(false);
  });

  it('reads the clock in IST, with midnight as 00:xx', () => {
    expect(clockIst(new Date('2026-11-19T04:30:00Z'))).toBe('10:00');
    expect(clockIst(new Date('2026-11-19T18:30:00Z'))).toBe('00:00');
    expect(clockIst(new Date('2026-11-19T18:35:00Z'))).toBe('00:05');
  });
});
