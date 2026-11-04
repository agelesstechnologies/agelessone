export type CorrectionStatus = 'submitted' | 'approved' | 'rejected' | 'cancelled';
export type CorrectionAction = 'approve' | 'reject' | 'cancel';

/** The instant an IST date begins (YYYY-MM-DD → midnight in India). */
const dayStart = (date: string) => Date.parse(`${date}T00:00:00+05:30`);

/** Requested times must fall on the corrected IST work date. */
export function timesOnDate(workDate: string, times: (string | undefined)[]): boolean {
  const start = dayStart(workDate);
  return times.every((t) => t === undefined || (Date.parse(t) >= start && Date.parse(t) < start + 24 * 3_600_000));
}

/** The punches an approved correction adds, in time order. */
export function correctionPunches(c: { requestedIn: Date | null; requestedOut: Date | null }): { kind: 'in' | 'out'; at: Date }[] {
  const out: { kind: 'in' | 'out'; at: Date }[] = [];
  if (c.requestedIn) out.push({ kind: 'in', at: c.requestedIn });
  if (c.requestedOut) out.push({ kind: 'out', at: c.requestedOut });
  return out;
}

/** Only a submitted correction can be approved, rejected or cancelled. */
export function stepNotAllowed(status: CorrectionStatus, _action: CorrectionAction): 'HRMS_CORRECTION_NOT_PENDING' | null {
  return status === 'submitted' ? null : 'HRMS_CORRECTION_NOT_PENDING';
}
