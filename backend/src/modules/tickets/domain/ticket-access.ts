/** Who may do what on one ticket. Pure: the service loads the facts. */
export type Scope = 'own' | 'team' | 'all' | undefined;

export interface Caller {
  view: Scope; work: Scope; manage: Scope;
  /** role Management (CEO): everything, every company */
  management: boolean;
}

export interface Relation {
  /** the caller heads the ticket's department */
  headsDepartment: boolean;
  /** the caller is the ticket's supervisor */
  supervises: boolean;
  /** the caller is a current assignee / the current primary assignee */
  assignee: boolean;
  primary: boolean;
}

/** Create, edit, assign, hold, resume, complete, cancel, reopen, link: Management, scope all, or the department's head / the ticket's supervisor. */
export function canManage(c: Caller, r: Relation): boolean {
  if (c.management || c.manage === 'all') return true;
  return c.manage !== undefined && (r.headsDepartment || r.supervises);
}

/** HR and scope all see everything; heads and supervisors their tickets; staff the tickets they are assigned to. */
export function canView(c: Caller, r: Relation): boolean {
  if (c.management || c.view === 'all' || canManage(c, r)) return true;
  if ((c.view === 'team') && (r.headsDepartment || r.supervises)) return true;
  return (c.view !== undefined || c.work !== undefined) && r.assignee;
}

/** Start, checklist answers, files, sign-off, daily updates: the managers, or an assignee with tickets.work. */
export function canWork(c: Caller, r: Relation): boolean {
  return canManage(c, r) || (c.work !== undefined && r.assignee);
}

/** Completing: the managers, or the primary assignee. */
export function canComplete(c: Caller, r: Relation): boolean {
  return canManage(c, r) || (c.work !== undefined && r.primary);
}
