import { describe, it, expect } from 'vitest';
import { calculateWorkDay } from './work-day-calculator';

const t = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 30, h, m));
const rules = { fullDayMinutes: 480, halfDayMinutes: 240 };

describe('calculateWorkDay', () => {
  it('full day', () => expect(calculateWorkDay([{ kind: 'in', at: t(3, 30) }, { kind: 'out', at: t(12, 30) }], rules)).toEqual({ workedMinutes: 540, status: 'present' }));
  it('lunch break pairs add up', () => expect(calculateWorkDay([{ kind: 'in', at: t(3) }, { kind: 'out', at: t(7) }, { kind: 'in', at: t(8) }, { kind: 'out', at: t(12) }], rules).workedMinutes).toBe(480));
  it('half day', () => expect(calculateWorkDay([{ kind: 'in', at: t(3) }, { kind: 'out', at: t(8) }], rules).status).toBe('half_day'));
  it('missed punch-out', () => expect(calculateWorkDay([{ kind: 'in', at: t(3) }], rules).status).toBe('missed_punch'));
});
