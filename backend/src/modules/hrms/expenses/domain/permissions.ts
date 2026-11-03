/** Permission codes used by the Expenses endpoints (rows in core.permissions, added by migration 0006). */
export const EXPENSES = {
  submit: 'hrms.expenses.submit',
  approve: 'hrms.expenses.approve',
  pay: 'hrms.expenses.pay',
  report: 'hrms.expenses.report',
} as const;
