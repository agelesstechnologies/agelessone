/** Permission codes the backend checks (same strings as the backend's domain/permissions files). */
export const PEOPLE = {
  view: 'hrms.people.view', create: 'hrms.people.create', update: 'hrms.people.update', manageContacts: 'hrms.contacts.manage',
  reviewContacts: 'hrms.contacts.review', manageEmployments: 'hrms.employments.manage', updateEmployments: 'hrms.employments.update', managePositions: 'hrms.positions.manage',
} as const;
export const PRIVATE = { view: 'hrms.private.view', reveal: 'hrms.private.reveal', manage: 'hrms.private.manage' } as const;
export const TICKETS = { view: 'tickets.view', work: 'tickets.work', manage: 'tickets.manage', numbering: 'tickets.numbering.manage', timeAdjust: 'tickets.time.adjust' } as const;
export const TICKET_TYPES = { view: 'tickets.types.view', manage: 'tickets.types.manage' } as const;
export const ATTENDANCE = { punch: 'hrms.attendance.punch', view: 'hrms.attendance.view', rebuild: 'hrms.attendance.rebuild', approve: 'hrms.attendance.approve', lockMonth: 'hrms.month.lock', unlockMonth: 'hrms.month.unlock' } as const;
export const PAYROLL = { prepare: 'payroll.prepare', approve: 'payroll.approve', payslip: 'payroll.payslip.own' } as const;
export const SKILLS = { manage: 'hrms.skills.manage', add: 'hrms.skills.add', verify: 'hrms.skills.verify', view: 'hrms.skills.view' } as const;
export const EXPENSES = { submit: 'hrms.expenses.submit', approve: 'hrms.expenses.approve', pay: 'hrms.expenses.pay', report: 'hrms.expenses.report' } as const;
export const LEAVE = { apply: 'hrms.leave.apply', approve: 'hrms.leave.approve', manage: 'hrms.leave.manage', report: 'hrms.leave.report' } as const;
export const CALENDAR = { manage: 'hrms.calendar.manage', view: 'hrms.people.view' } as const;
export const POLICIES = { manage: 'core.policies.manage' } as const;
export const DASHBOARD = { view: 'hrms.dashboard.view' } as const;
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
  'hrms.attendance.approve': 'Approve corrections and overtime',
  'hrms.leave.apply': 'Apply for leave',
  'hrms.leave.approve': 'Approve leave',
  'hrms.leave.manage': 'Adjust leave balances',
  'hrms.leave.report': 'See leave reports',
  'hrms.calendar.manage': 'Manage holidays and weekly offs',
  'core.policies.manage': 'Manage company policies',
  'core.users.manage': 'Manage logins and roles',
};

export const SCOPE_LABELS = { own: 'Own records', team: 'Own team', all: 'Everyone' } as const;
