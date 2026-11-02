export interface Punch { kind: 'in' | 'out'; at: Date }
export interface DayRules { fullDayMinutes: number; halfDayMinutes: number }
export type DayStatus = 'present' | 'half_day' | 'absent' | 'missed_punch';

/** Pairs punches in order and works out minutes and status. No database, no HTTP. */
export function calculateWorkDay(punches: Punch[], rules: DayRules): { workedMinutes: number; status: DayStatus } {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  let worked = 0; let openIn: Date | null = null;
  for (const p of sorted) {
    if (p.kind === 'in') openIn = p.at;
    else if (openIn) { worked += Math.round((p.at.getTime() - openIn.getTime()) / 60000); openIn = null; }
  }
  if (openIn) return { workedMinutes: worked, status: 'missed_punch' };
  if (worked >= rules.fullDayMinutes) return { workedMinutes: worked, status: 'present' };
  if (worked >= rules.halfDayMinutes) return { workedMinutes: worked, status: 'half_day' };
  return { workedMinutes: worked, status: 'absent' };
}
