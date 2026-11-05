/** Masking of private details: only the last 4 characters stay readable. Pure functions. */

/** 123412341234 → "XXXX XXXX 1234" */
export function maskAadhaar(aadhaar: string): string {
  return `XXXX XXXX ${aadhaar.slice(-4)}`;
}

/** ABCDE1234F → "XXXXXX234F" */
export function maskPan(pan: string): string {
  return `${'X'.repeat(Math.max(0, pan.length - 4))}${pan.slice(-4)}`;
}

/** 001234567890 → "XXXXXXXX7890" */
export function maskAccount(n: string): string {
  return `${'X'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;
}
