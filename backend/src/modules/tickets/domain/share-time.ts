/** Sharing a person's ticket time on one work day. Pure: times are milliseconds since the epoch. */
export interface Span { start: number; end: number }
export interface TicketSpan extends Span { ticket: number }

/**
 * Policy tickets.time.split = 'equal': ticket timers are first cut to the attended periods (time outside attendance
 * counts for nothing); then for every stretch where n different tickets run together, each gets 1/n of it. The result
 * is whole minutes per ticket that never add up to more than `ceilingMinutes` (the day's attendance minutes): rounding
 * keeps the total, and when the total is over the ceiling every ticket is scaled down alike.
 */
export function shareTime(timers: TicketSpan[], attended: Span[], ceilingMinutes: number): Map<number, number> {
  const pieces: TicketSpan[] = [];
  for (const t of timers) {
    for (const a of attended) {
      const start = Math.max(t.start, a.start);
      const end = Math.min(t.end, a.end);
      if (end > start) pieces.push({ ticket: t.ticket, start, end });
    }
  }
  const cuts = [...new Set(pieces.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
  const ms = new Map<number, number>();
  for (let i = 0; i < cuts.length - 1; i++) {
    const [from, to] = [cuts[i], cuts[i + 1]];
    const running = new Set(pieces.filter((p) => p.start <= from && p.end >= to).map((p) => p.ticket));
    for (const t of running) ms.set(t, (ms.get(t) ?? 0) + (to - from) / running.size);
  }
  return toMinutes(ms, ceilingMinutes);
}

/**
 * Whole minutes per ticket by the largest remainder: the total is the rounded total of the exact minutes (at most the
 * ceiling), shared in proportion to each ticket's exact time.
 */
export function toMinutes(ms: Map<number, number>, ceilingMinutes: number): Map<number, number> {
  const exact = [...ms].map(([ticket, v]) => ({ ticket, minutes: v / 60000 }));
  const total = exact.reduce((a, b) => a + b.minutes, 0);
  const target = Math.max(0, Math.min(Math.round(total), Math.floor(ceilingMinutes)));
  const out = new Map<number, number>();
  if (total === 0) return out;
  const shares = exact.map((e) => ({ ticket: e.ticket, share: (e.minutes / total) * target }));
  for (const s of shares) out.set(s.ticket, Math.floor(s.share));
  let left = target - [...out.values()].reduce((a, b) => a + b, 0);
  for (const s of [...shares].sort((a, b) => (b.share % 1) - (a.share % 1) || a.ticket - b.ticket)) {
    if (left <= 0) break;
    out.set(s.ticket, out.get(s.ticket)! + 1);
    left--;
  }
  return out;
}

/**
 * Is the person punched in for the day at `at`? Their latest punch overall must be a real punch-in at or before `at`,
 * open for no longer than the open-punch limit (after that it is a missed punch). Anything else: not punched in.
 */
export function punchedInAt(last: { kind: 'in' | 'out'; at: Date; auto: boolean } | undefined, at: Date, maxOpenHours: number): boolean {
  if (!last || last.kind !== 'in' || last.auto) return false;
  return last.at <= at && at.getTime() - last.at.getTime() <= maxOpenHours * 3_600_000;
}
