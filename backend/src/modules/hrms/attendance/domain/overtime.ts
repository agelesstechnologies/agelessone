export type OvertimeStatus = 'submitted' | 'approved' | 'rejected' | 'cancelled';
export type OvertimeAction = 'approve' | 'reject' | 'cancel';

/** Approve and reject need a submitted request; a submitted or an approved one can be cancelled. */
export function stepNotAllowed(status: OvertimeStatus, action: OvertimeAction): 'HRMS_OVERTIME_NOT_PENDING' | 'HRMS_OVERTIME_CLOSED' | null {
  if (action === 'cancel') return status === 'submitted' || status === 'approved' ? null : 'HRMS_OVERTIME_CLOSED';
  return status === 'submitted' ? null : 'HRMS_OVERTIME_NOT_PENDING';
}
