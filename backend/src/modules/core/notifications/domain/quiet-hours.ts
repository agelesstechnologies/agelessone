/** The time of day in IST as HH:MM (24 hours). */
export function clockIst(at: Date): string {
  return at.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/**
 * Whether `now` (HH:MM) is inside the quiet window: from `start` up to but not including `end`. A window may cross
 * midnight (22:00 to 07:00). No window, or start equal to end, is never quiet.
 */
export function inQuietHours(now: string, quiet: { start: string; end: string } | null): boolean {
  if (!quiet || quiet.start === quiet.end) return false;
  return quiet.start < quiet.end
    ? now >= quiet.start && now < quiet.end
    : now >= quiet.start || now < quiet.end;
}
