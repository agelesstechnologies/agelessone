/** One completed ticket: calendar time from created to completed, and the allocated minutes worked on it. */
export interface CompletedTicket { createdAt: Date; completedAt: Date; workedMinutes: number }

export interface CompletionFigures { completed: number; avgHours: number | null; medianHours: number | null; avgWorkedMinutes: number | null }

const HOUR = 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** How long completed tickets took: average and median hours (one decimal), average minutes worked. null when there are none. Pure. */
export function completionFigures(rows: CompletedTicket[]): CompletionFigures {
  if (rows.length === 0) return { completed: 0, avgHours: null, medianHours: null, avgWorkedMinutes: null };
  const hours = rows.map((r) => Math.max(0, r.completedAt.getTime() - r.createdAt.getTime()) / HOUR).sort((a, b) => a - b);
  const mid = Math.floor(hours.length / 2);
  const median = hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2;
  return {
    completed: rows.length,
    avgHours: round1(hours.reduce((s, h) => s + h, 0) / hours.length),
    medianHours: round1(median),
    avgWorkedMinutes: Math.round(rows.reduce((s, r) => s + r.workedMinutes, 0) / rows.length),
  };
}
