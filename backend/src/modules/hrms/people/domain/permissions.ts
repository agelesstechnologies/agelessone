/** Permission codes used by the People endpoints (rows in core.permissions, added by migrations 0005 and 0016). */
export const PEOPLE = {
  view: 'hrms.people.view',
  create: 'hrms.people.create',
  update: 'hrms.people.update',
  manageContacts: 'hrms.contacts.manage',
  reviewContacts: 'hrms.contacts.review',
  manageEmployments: 'hrms.employments.manage',
  updateEmployments: 'hrms.employments.update',
  managePositions: 'hrms.positions.manage',
} as const;

/** Letter templates and issued letters (row added by migration 0030): HR and Management, scope all. */
export const LETTERS = { manage: 'hrms.letters.manage' } as const;

/** Private details (rows added by migration 0021): view masked (HR, Management), reveal in full (Management), change (HR). */
export const PRIVATE = {
  view: 'hrms.private.view',
  reveal: 'hrms.private.reveal',
  manage: 'hrms.private.manage',
} as const;
