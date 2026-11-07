/** Permission codes used by the ticket type endpoints (rows in core.permissions, added by migration 0022). */
export const TICKET_TYPES = {
  /** everyone signed in with a role: read types (staff, HR, supervisors, admin, Management) */
  view: 'tickets.types.view',
  /** scope all (admin user, Management): every type, standard ones too. Otherwise: the head of the owning department. */
  manage: 'tickets.types.manage',
} as const;

/** Permission codes used by the ticket endpoints (rows in core.permissions, added by migration 0023). */
export const TICKETS = {
  /** own: tickets you are assigned to; team: also your departments' and the ones you supervise; all: every ticket (HR) */
  view: 'tickets.view',
  /** work on tickets you are assigned to (staff, supervisors) */
  work: 'tickets.work',
  /** run tickets (assign, edit, hold, cancel, approve): all (admin user, Management) or a department head for their departments */
  manage: 'tickets.manage',
  /** create tickets for any department of a company you work in (Supervisor); department heads create for their departments */
  create: 'tickets.create',
  /** HR: each company's number prefix and next number */
  numbering: 'tickets.numbering.manage',
  /** review ticket time: team = tickets of departments you head; all = every ticket (Management). Never your own */
  timeAdjust: 'tickets.time.adjust',
} as const;
