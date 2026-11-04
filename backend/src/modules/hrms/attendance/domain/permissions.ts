/** Permission codes used by the Attendance endpoints (rows in core.permissions, added by migrations 0007 and 0011). */
export const ATTENDANCE = {
  punch: 'hrms.attendance.punch',
  view: 'hrms.attendance.view',
  rebuild: 'hrms.attendance.rebuild',
  approve: 'hrms.attendance.approve',
} as const;
