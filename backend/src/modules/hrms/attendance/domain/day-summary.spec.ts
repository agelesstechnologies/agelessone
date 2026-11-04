import { describe, it, expect } from 'vitest';
import { approvedOvertime, summarizeDay } from './day-summary';

// Times in IST for readability.
const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00+05:30`);
const policy = { fullDayMinutes: 480, halfDayMinutes: 240, maxOpenPunchHours: 16 };

describe('summarizeDay', () => {
  it('two sessions with a lunch break: minutes, first in, last out', () => {
    const s = summarizeDay([{ kind: 'in', at: at('09:00') }, { kind: 'out', at: at('13:00') }, { kind: 'in', at: at('14:00') }, { kind: 'out', at: at('18:30') }], policy);
    expect(s).toMatchObject({ workedMinutes: 510, extraMinutes: 30, status: 'present', running: false });
    expect(s.firstIn).toEqual(at('09:00'));
    expect(s.lastOut).toEqual(at('18:30'));
  });

  it('an open punch-in is a missed punch-out when stored', () => {
    const s = summarizeDay([{ kind: 'in', at: at('09:00') }], policy);
    expect(s).toMatchObject({ status: 'missed_punch', workedMinutes: 0, running: false, lastOut: null });
  });

  it('today, an open punch-in counts up to now and shows as working', () => {
    const s = summarizeDay([{ kind: 'in', at: at('09:00') }], policy, at('10:30'));
    expect(s).toMatchObject({ status: 'working', workedMinutes: 90, running: true });
  });

  it('no overtime up to the threshold', () => {
    const s = summarizeDay([{ kind: 'in', at: at('09:00') }, { kind: 'out', at: at('17:00') }], policy);
    expect(s.extraMinutes).toBe(0);
  });

  it('on a weekly off or holiday, no work or a short stint is not an absence', () => {
    expect(summarizeDay([], policy, undefined, 'weekly_off').status).toBe('weekly_off');
    expect(summarizeDay([{ kind: 'in', at: at('10:00') }, { kind: 'out', at: at('11:00') }], policy, undefined, 'holiday'))
      .toMatchObject({ status: 'holiday', workedMinutes: 60 });
  });

  it('a full day worked on a holiday is still present', () => {
    expect(summarizeDay([{ kind: 'in', at: at('09:00') }, { kind: 'out', at: at('17:00') }], policy, undefined, 'holiday').status).toBe('present');
  });

  it('an open punch-in older than the max hours stops running and is a missed punch-out', () => {
    const s = summarizeDay([{ kind: 'in', at: at('09:00') }], { ...policy, maxOpenPunchHours: 2 }, at('12:00'));
    expect(s).toMatchObject({ status: 'missed_punch', running: false, workedMinutes: 0 });
  });

  it('a day closed by an automatic punch-out counts its minutes but stays a missed punch', () => {
    const s = summarizeDay([{ kind: 'in', at: at('09:00') }, { kind: 'out', at: at('17:00'), auto: true }], policy);
    expect(s).toMatchObject({ status: 'missed_punch', workedMinutes: 480, absentDays: 0 });
  });

  it('approved overtime is what the approved requests allow, capped at the extra time', () => {
    expect(approvedOvertime(30, [])).toBe(0);       // extra time alone is not overtime
    expect(approvedOvertime(30, [60])).toBe(30);    // capped at the extra time
    expect(approvedOvertime(90, [30, 20])).toBe(50);
  });

  describe('leave and absent days', () => {
    const half = [{ kind: 'in' as const, at: at('09:00') }, { kind: 'out' as const, at: at('13:00') }];
    const full = [{ kind: 'in' as const, at: at('09:00') }, { kind: 'out' as const, at: at('17:00') }];
    const split = (punches: typeof half, leave: 'full' | 'half' | null, kind: 'working' | 'weekly_off' = 'working') => {
      const s = summarizeDay(punches, policy, undefined, kind, leave);
      return [s.status, s.leaveDays, s.absentDays, s.workedOnLeave];
    };
    it('no leave: present, half day (half absent), absent', () => {
      expect(split(full, null)).toEqual(['present', 0, 0, false]);
      expect(split(half, null)).toEqual(['half_day', 0, 0.5, false]);
      expect(split([], null)).toEqual(['absent', 0, 1, false]);
    });
    it('half leave: with no work the day is half leave and half absent', () => {
      expect(split([], 'half')).toEqual(['half_day', 0.5, 0.5, false]);
      expect(split(half, 'half')).toEqual(['present', 0.5, 0, false]);
      expect(split(full, 'half')).toEqual(['present', 0.5, 0, true]);
    });
    it('full leave: a full day worked is present and marked as worked on leave', () => {
      expect(split(full, 'full')).toEqual(['present', 1, 0, true]);
      expect(split([], 'full')).toEqual(['leave', 1, 0, false]);
    });
    it('a weekly off is neither leave nor absence', () => {
      expect(split([], 'full', 'weekly_off')).toEqual(['weekly_off', 0, 0, false]);
    });
    it('today while still punched in nothing is absent yet', () => {
      expect(summarizeDay([{ kind: 'in', at: at('09:00') }], policy, at('10:00'))).toMatchObject({ status: 'working', absentDays: 0 });
    });
  });
});
