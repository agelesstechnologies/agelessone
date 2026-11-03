export interface ActiveEmployment { id: number; joinedOn: string }

/** An exit date can't be before joining (dates are YYYY-MM-DD, so text order is date order). */
export function isValidExitDate(joinedOn: string, exitOn: string): boolean {
  return exitOn >= joinedOn;
}

/** When the primary employment ends, the most recently joined remaining active one becomes primary. */
export function pickNextPrimary(remaining: ActiveEmployment[]): number | undefined {
  return [...remaining].sort((a, b) => b.joinedOn.localeCompare(a.joinedOn) || b.id - a.id)[0]?.id;
}
