import { calculateWorkDay, DayRules, DayStatus, Punch } from './work-day-calculator';

export interface DayPolicy extends DayRules { overtimeAfterMinutes: number }
export interface DaySummary {
  firstIn: Date | null; lastOut: Date | null;
  workedMinutes: number; overtimeMinutes: number;
  status: DayStatus | 'working'; running: boolean;
}

/**
 * One job's day from its punches (already limited to that IST date).
 * With `now` (today only): an open punch-in counts up to now and the status is 'working'.
 * Without `now`: an open punch-in is a missed punch-out (what gets stored).
 */
export function summarizeDay(punches: Punch[], policy: DayPolicy, now?: Date): DaySummary {
  const sorted = [...punches].sort((a, b) => a.at.getTime() - b.at.getTime());
  const firstIn = sorted.find((p) => p.kind === 'in')?.at ?? null;
  const lastOut = [...sorted].reverse().find((p) => p.kind === 'out')?.at ?? null;
  const open = sorted.at(-1)?.kind === 'in';
  const running = open && now !== undefined;
  const counted = running ? [...sorted, { kind: 'out' as const, at: now }] : sorted;
  const { workedMinutes, status } = calculateWorkDay(counted, policy);
  const overtimeMinutes = Math.min(workedMinutes, Math.max(0, workedMinutes - policy.overtimeAfterMinutes));
  return { firstIn, lastOut, workedMinutes, overtimeMinutes, status: running ? 'working' : status, running };
}
