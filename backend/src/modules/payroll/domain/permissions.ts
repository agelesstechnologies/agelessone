/** Permission codes used by the Payroll endpoints (rows in core.permissions, added by migration 0020). */
export const PAYROLL = {
  /** role Payroll (HR): salaries, bank details, runs, adjustments, mark paid, files */
  prepare: 'payroll.prepare',
  /** role Payroll Approver (CEO): approves a run someone else prepared */
  approve: 'payroll.approve',
  /** everyone: their own payslips */
  payslip: 'payroll.payslip.own',
} as const;
