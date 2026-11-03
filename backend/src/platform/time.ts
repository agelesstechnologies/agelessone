/** Today's date in India (YYYY-MM-DD). Work dates and validity dates are IST. */
export function todayIst(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The instant an IST date begins (YYYY-MM-DD → midnight in India, as a UTC Date). */
export function istDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+05:30`);
}

/** YYYY-MM-DD plus n days (n may be negative). */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every date from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** A setting the app cannot start without (e.g. JWT_SECRET). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Add it to backend/.env (see backend/.env.example).`);
  return value;
}
