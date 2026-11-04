/** Permission codes used by the Attendance endpoints (rows in core.permissions, added by migrations 0007, 0011 and 0019). */
export const ATTENDANCE = {
  punch: 'hrms.attendance.punch',
  view: 'hrms.attendance.view',
  rebuild: 'hrms.attendance.rebuild',
  approve: 'hrms.attendance.approve',
  lockMonth: 'hrms.month.lock',
  unlockMonth: 'hrms.month.unlock',
} as const;
