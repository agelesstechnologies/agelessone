/** Permission codes the backend checks (same strings as the backend's domain/permissions files). */
export const PEOPLE = { view: 'hrms.people.view', create: 'hrms.people.create' } as const;
export const ATTENDANCE = { punch: 'hrms.attendance.punch', view: 'hrms.attendance.view', rebuild: 'hrms.attendance.rebuild' } as const;
export const EXPENSES = { submit: 'hrms.expenses.submit', approve: 'hrms.expenses.approve', pay: 'hrms.expenses.pay', report: 'hrms.expenses.report' } as const;
export const USERS = { manage: 'core.users.manage' } as const;

/** Plain-language names for the "Roles & access" page. Unknown codes are shown as they are. */
export const PERMISSION_LABELS: Record<string, string> = {
  'hrms.people.view': 'View people',
  'hrms.people.create': 'Add people',
  'hrms.people.update': 'Edit people',
  'hrms.contacts.manage': 'Manage contacts',
  'hrms.contacts.review': 'Review shared contacts',
  'hrms.employments.manage': 'Manage employments',
  'hrms.employments.update': 'Update team employments',
  'hrms.attendance.punch': 'Punch in and out',
  'hrms.attendance.view': 'View attendance of others',
  'hrms.attendance.rebuild': 'Recalculate work days',
  'hrms.expenses.submit': 'Submit expense claims',
  'hrms.expenses.approve': 'Approve expense claims',
  'hrms.expenses.pay': 'Mark claims as paid',
  'hrms.expenses.report': 'See expense reports',
  'core.users.manage': 'Manage logins and roles',
};

export const SCOPE_LABELS = { own: 'Own records', team: 'Own team', all: 'Everyone' } as const;
