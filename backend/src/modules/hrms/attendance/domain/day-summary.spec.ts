import { describe, it, expect } from 'vitest';
import { summarizeDay } from './day-summary';

// Times in IST for readability.
const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00+05:30`);
const policy = { fullDayMinutes: 480, halfDayMinutes: 240, overtimeAfterMinutes: 480 };

describe('summarizeDay', () => {
  it('two sessions with a lunch break: minutes, first in, last out', () => {
    const s = summarizeDay([{ kind: 'in', at: at('09:00') }, { kind: 'out', at: at('13:00') }, { kind: 'in', at: at('14:00') }, { kind: 'out', at: at('18:30') }], policy);
    expect(s).toMatchObject({ workedMinutes: 510, overtimeMinutes: 30, status: 'present', running: false });
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
    expect(s.overtimeMinutes).toBe(0);
  });
});
