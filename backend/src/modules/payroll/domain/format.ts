const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "November 2025" */
export function monthName(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

/** Paise as Indian rupees with Indian digit grouping: 123456789 → "INR 12,34,567.89". Exact (no floating point). */
export function inr(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const whole = String(Math.floor(abs / 100));
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${sign}INR ${rest ? `${rest},${last3}` : last3}.${String(abs % 100).padStart(2, '0')}`;
}

/** An account number with all but the last 4 digits hidden. */
export function maskAccount(n: string): string {
  return `${'X'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;
}
