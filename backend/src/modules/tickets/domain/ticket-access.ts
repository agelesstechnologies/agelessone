/** Who may do what on one ticket. Pure: the service loads the facts. */
export type Scope = 'own' | 'team' | 'all' | undefined;

export interface Caller {
  view: Scope; work: Scope; manage: Scope;
  /** tickets.create (Manager): create tickets for any department of a company you work in */
  create?: Scope;
  /** tickets.site (on-site Supervisor): run the site work of the tickets you supervise (not assign, cancel or create) */
  site?: Scope;
  /** role Management (CEO): everything, every company */
  management: boolean;
}

export interface Relation {
  /** the caller heads the ticket's department */
  headsDepartment: boolean;
  /** the caller is the ticket's supervisor */
  supervises: boolean;
  /** the caller created the ticket */
  created?: boolean;
  /** the caller is a current assignee / the current primary assignee */
  assignee: boolean;
  primary: boolean;
}

/**
 * Edit everything, assign, hold, resume, complete, cancel, reopen, link: Management, scope all, or a holder of
 * tickets.manage (Manager, department head) for tickets of a department they head, they supervise, or they created.
 */
export function canManage(c: Caller, r: Relation): boolean {
  if (c.management || c.manage === 'all') return true;
  return c.manage !== undefined && (r.headsDepartment || r.supervises || r.created === true);
}

/** The on-site supervisor of this ticket (tickets.site): requirements, external staff, updates, files, hold, resume, complete. */
export function canSite(c: Caller, r: Relation): boolean {
  return c.site !== undefined && r.supervises;
}

/** Site work: the managers, or the ticket's on-site supervisor. */
export function canRunSite(c: Caller, r: Relation): boolean {
  return canManage(c, r) || canSite(c, r);
}

/**
 * Who creates a ticket: the head of its department (holding tickets.manage or tickets.create), or a holder of
 * tickets.create (Manager) with an active job in the ticket's company, for any of its departments. Management (CEO),
 * Admin user and on-site supervisors do not create tickets, unless they head that department.
 */
export function canCreate(c: Caller, f: { headsDepartment: boolean; worksInCompany: boolean }): boolean {
  if (f.headsDepartment && (c.manage !== undefined || c.create !== undefined)) return true;
  return c.create !== undefined && f.worksInCompany;
}

/** HR and scope all see everything; heads, managers and supervisors their tickets; staff the tickets they are assigned to. */
export function canView(c: Caller, r: Relation): boolean {
  if (c.management || c.view === 'all' || canRunSite(c, r)) return true;
  if ((c.view === 'team') && (r.headsDepartment || r.supervises)) return true;
  return (c.view !== undefined || c.work !== undefined) && r.assignee;
}

/** Start, checklist answers, files, sign-off, daily updates: the managers, the on-site supervisor, or an assignee with tickets.work. */
export function canWork(c: Caller, r: Relation): boolean {
  return canRunSite(c, r) || (c.work !== undefined && r.assignee);
}

/** Completing: the managers, the on-site supervisor, or the primary assignee. */
export function canComplete(c: Caller, r: Relation): boolean {
  return canRunSite(c, r) || (c.work !== undefined && r.primary);
}
