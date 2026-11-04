/** Permission codes used by the Calendar endpoints (hrms.calendar.manage is added by migration 0008). */
export const CALENDAR = {
  manage: 'hrms.calendar.manage',
  /** People's permission: whoever may see a person (own / team / all) may see their job's calendar. */
  viewPeople: 'hrms.people.view',
} as const;
