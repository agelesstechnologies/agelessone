/**
 * Permission codes used by the Intercompany endpoints (rows in core.permissions, added by migration 0040). Company heads
 * need none: they are named on the agreement, as a department head is set on the department.
 */
export const INTERCOMPANY = {
  /** scope all (Management, the CEO): every agreement, its rates, billed months, passed-on costs and ticket billing */
  view: 'intercompany.view',
  /** scope all (Management, the CEO): create and change agreements, add rates, mark months billed, record passed-on
   *  costs on any agreement, set any ticket (not) billable */
  manage: 'intercompany.manage',
} as const;
