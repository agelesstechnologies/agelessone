/** Permission codes of Accounts (rows in core.permissions, added by migration 0038). */
export const ACCOUNTS = {
  /** role Accounts executive (maker): drafts, creates batches, marks paid */
  make: 'accounts.make',
  /** role Accounts manager (checker): approves, closes months, reverses entries */
  check: 'accounts.check',
  /** read the Accounts screens */
  view: 'accounts.view',
} as const;
