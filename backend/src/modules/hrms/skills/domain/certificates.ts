/** A certificate past its expiry date is expired, whatever its stored status says (the daily job catches up). */
export function statusOn(status: 'review' | 'verified' | 'expired', expiresOn: string | null, today: string): 'review' | 'verified' | 'expired' {
  return expiresOn !== null && expiresOn < today ? 'expired' : status;
}

/** Whole days from today to the expiry date (0 = expires today). */
export function daysLeft(expiresOn: string, today: string): number {
  return Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
