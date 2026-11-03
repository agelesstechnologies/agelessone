import { describe, it, expect } from 'vitest';
import { calculateLeaveDays } from './leave-days';

// Week used below: Mon 2 Nov 2026 … Sun 8 Nov 2026.
const SUNDAY_OFF = [0];
const WEEKEND_OFF = [0, 6];

describe('calculateLeaveDays', () => {
  it('the dates used here fall on the weekdays the tests assume', () => {
    expect(new Date('2026-11-02T00:00:00Z').getUTCDay()).toBe(1); // Monday
    expect(new Date('2026-11-08T00:00:00Z').getUTCDay()).toBe(0); // Sunday
  });

  describe('single day', () => {
    it('a full day is 1', () => expect(calculateLeaveDays('2026-11-04', '2026-11-04', 'full', 'full', [], SUNDAY_OFF)).toBe(1));
    it('the second half only is 0.5', () => expect(calculateLeaveDays('2026-11-04', '2026-11-04', 'second_half', 'full', [], SUNDAY_OFF)).toBe(0.5));
    it('the first half only is 0.5', () => expect(calculateLeaveDays('2026-11-04', '2026-11-04', 'full', 'first_half', [], SUNDAY_OFF)).toBe(0.5));
    it('"second half to first half" of one day is refused', () =>
      expect(() => calculateLeaveDays('2026-11-04', '2026-11-04', 'second_half', 'first_half', [], SUNDAY_OFF)).toThrow(RangeError));
  });

  describe('half days on longer leave', () => {
    it('Mon afternoon to Wed morning is 2 days', () =>
      expect(calculateLeaveDays('2026-11-02', '2026-11-04', 'second_half', 'first_half', [], SUNDAY_OFF)).toBe(2));
    it('Mon full to Tue morning is 1.5 days', () =>
      expect(calculateLeaveDays('2026-11-02', '2026-11-03', 'full', 'first_half', [], SUNDAY_OFF)).toBe(1.5));
  });

  describe('a holiday inside', () => {
    it('Mon–Fri with a Wednesday holiday is 4 days', () =>
      expect(calculateLeaveDays('2026-11-02', '2026-11-06', 'full', 'full', ['2026-11-04'], SUNDAY_OFF)).toBe(4));
    it('a holiday outside the leave changes nothing', () =>
      expect(calculateLeaveDays('2026-11-02', '2026-11-03', 'full', 'full', ['2026-11-20'], SUNDAY_OFF)).toBe(2));
    it('leave only on a holiday is 0', () =>
      expect(calculateLeaveDays('2026-11-04', '2026-11-04', 'full', 'full', ['2026-11-04'], SUNDAY_OFF)).toBe(0));
    it('a half day that falls on a holiday takes nothing off', () =>
      expect(calculateLeaveDays('2026-11-04', '2026-11-05', 'second_half', 'full', ['2026-11-04'], SUNDAY_OFF)).toBe(1));
  });

  describe('a weekend inside', () => {
    it('Fri–Mon with Sunday off is 3 days (Saturday is a working day)', () =>
      expect(calculateLeaveDays('2026-11-06', '2026-11-09', 'full', 'full', [], SUNDAY_OFF)).toBe(3));
    it('Fri–Mon with Saturday and Sunday off is 2 days', () =>
      expect(calculateLeaveDays('2026-11-06', '2026-11-09', 'full', 'full', [], WEEKEND_OFF)).toBe(2));
    it('a holiday on the weekly off is not taken off twice', () =>
      expect(calculateLeaveDays('2026-11-02', '2026-11-08', 'full', 'full', ['2026-11-08'], SUNDAY_OFF)).toBe(6));
    it('across a month and year end: Wed 30 Dec 2026 – Mon 4 Jan 2027, Sunday off, 1 Jan holiday', () =>
      expect(calculateLeaveDays('2026-12-30', '2027-01-04', 'full', 'full', ['2027-01-01'], SUNDAY_OFF)).toBe(4));
  });

  describe('bad input', () => {
    it('refuses an end before the start', () =>
      expect(() => calculateLeaveDays('2026-11-05', '2026-11-04', 'full', 'full', [], SUNDAY_OFF)).toThrow(/before it starts/));
    it('refuses a date that does not exist', () =>
      expect(() => calculateLeaveDays('2026-02-30', '2026-03-02', 'full', 'full', [], SUNDAY_OFF)).toThrow(/Not a real date/));
  });
});
