import { describe, expect, it } from 'vitest';
import { completionFigures } from './completion-time';

const H = 3_600_000;
const t0 = new Date(Date.UTC(2026, 9, 5, 3, 30));
const ticket = (hours: number, workedMinutes: number) => ({ createdAt: t0, completedAt: new Date(t0.getTime() + hours * H), workedMinutes });

describe('ticket completion time', () => {
  it('no completed tickets: count 0, figures null (never 0)', () => {
    expect(completionFigures([])).toEqual({ completed: 0, avgHours: null, medianHours: null, avgWorkedMinutes: null });
  });

  it('average and median hours from created to completed, average minutes worked', () => {
    expect(completionFigures([ticket(2, 60), ticket(10, 300), ticket(48, 600)]))
      .toEqual({ completed: 3, avgHours: 20, medianHours: 10, avgWorkedMinutes: 320 });
  });

  it('even count: median is the middle two averaged; hours to one decimal', () => {
    expect(completionFigures([ticket(1, 0), ticket(2, 0), ticket(3, 0), ticket(4.25, 0)]))
      .toMatchObject({ avgHours: 2.6, medianHours: 2.5 });
  });
});
