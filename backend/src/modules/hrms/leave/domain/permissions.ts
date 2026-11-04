/** Permission codes used by the Leave endpoints (rows in core.permissions, added by migration 0009). */
export const LEAVE = {
  apply: 'hrms.leave.apply',
  approve: 'hrms.leave.approve',
  manage: 'hrms.leave.manage',
  report: 'hrms.leave.report',
} as const;
