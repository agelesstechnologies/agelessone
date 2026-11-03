/** Permission codes used by the Attendance endpoints (rows in core.permissions, added by migration 0007). */
export const ATTENDANCE = {
  punch: 'hrms.attendance.punch',
  view: 'hrms.attendance.view',
  rebuild: 'hrms.attendance.rebuild',
} as const;
