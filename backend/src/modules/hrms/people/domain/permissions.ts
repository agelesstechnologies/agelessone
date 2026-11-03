/** Permission codes used by the People endpoints (rows in core.permissions, added by migration 0005). */
export const PEOPLE = {
  view: 'hrms.people.view',
  create: 'hrms.people.create',
  update: 'hrms.people.update',
  manageContacts: 'hrms.contacts.manage',
  reviewContacts: 'hrms.contacts.review',
  manageEmployments: 'hrms.employments.manage',
  updateEmployments: 'hrms.employments.update',
} as const;
