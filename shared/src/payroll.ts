import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from './common';
/** Payroll: one fixed monthly salary per job, one payroll run per company per month. Money is integer paise (INR). */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const company = z.string().trim().min(1).max(12);
const paise = z.number().int('Paise must be a whole number').positive('Must be more than 0').max(Number.MAX_SAFE_INTEGER);
const Job = z.object({ publicId: PublicId, company: z.string(), employeeCode: z.string() });

// ---- salaries ----

/** GET /api/payroll/salaries?company=&employment= — every salary row, newest first. */
export const SalariesQuery = z.object({ company: emptyToUndefined(company), employment: emptyToUndefined(z.string().uuid()) });
export type SalariesQuery = z.infer<typeof SalariesQuery>;
/** POST /api/payroll/salaries — a job's monthly salary from a date (a change is a new row; nothing is edited). */
export const AddSalaryRequest = z.object({
  publicId: z.string().uuid().optional(),
  employmentPublicId: z.string().uuid(),
  monthlyAmountPaise: paise,
  effectiveFrom: isoDate,
  note: z.string().trim().max(200).optional(),
});
export type AddSalaryRequest = z.infer<typeof AddSalaryRequest>;
export const Salary = z.object({
  publicId: PublicId, person: PersonRef, employment: Job, monthlyAmountPaise: z.number().int(), currency: z.string(),
  effectiveFrom: DateOnly, note: z.string().nullable(), createdBy: PersonRef, createdAt: Instant,
});
export type Salary = z.infer<typeof Salary>;

// ---- bank accounts ----

/** GET /api/payroll/bank-accounts?company= — account numbers are masked. */
export const BankAccountsQuery = z.object({ company: emptyToUndefined(company) });
export type BankAccountsQuery = z.infer<typeof BankAccountsQuery>;
/** POST /api/payroll/bank-accounts — where a job's salary is paid, from a date (a change is a new row). */
export const AddBankAccountRequest = z.object({
  publicId: z.string().uuid().optional(),
  employmentPublicId: z.string().uuid(),
  accountHolder: z.string().trim().min(2).max(100),
  accountNumber: z.string().trim().regex(/^[0-9]{6,18}$/, '6 to 18 digits'),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC like HDFC0001234'),
  effectiveFrom: isoDate,
});
export type AddBankAccountRequest = z.infer<typeof AddBankAccountRequest>;
export const BankAccount = z.object({
  publicId: PublicId, person: PersonRef, employment: Job, accountHolder: z.string(),
  accountNumberMasked: z.string(),  // e.g. XXXXXX1234 — the full number only appears in the bank upload file
  ifsc: z.string(), effectiveFrom: DateOnly, createdAt: Instant,
});
export type BankAccount = z.infer<typeof BankAccount>;

// ---- runs ----

export const PayrollStatus = z.enum(['draft', 'approved', 'paid']);
export type PayrollStatus = z.infer<typeof PayrollStatus>;

/** POST /api/payroll/runs — only once that month's attendance is locked for the company. */
export const CreateRunRequest = z.object({ company, year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;
/** GET /api/payroll/runs?company=&year= */
export const RunsQuery = z.object({ company: emptyToUndefined(company), year: emptyToUndefined(z.coerce.number().int().min(2000).max(2100)) });
export type RunsQuery = z.infer<typeof RunsQuery>;
/** POST /api/payroll/runs/:publicId/mark-paid */
export const MarkRunPaidRequest = z.object({ paidAt: z.string().datetime({ offset: true }), bankRef: z.string().trim().min(3).max(60) });
export type MarkRunPaidRequest = z.infer<typeof MarkRunPaidRequest>;

/** POST /api/payroll/items/:publicId/adjustments — e.g. deduction PT, TDS, ESI, Advance; addition Bonus. */
export const AddAdjustmentRequest = z.object({
  publicId: z.string().uuid().optional(),
  kind: z.enum(['addition', 'deduction']),
  label: z.string().trim().min(2).max(40),
  amountPaise: paise,
  note: z.string().trim().max(200).optional(),
});
export type AddAdjustmentRequest = z.infer<typeof AddAdjustmentRequest>;
/** PATCH /api/payroll/adjustments/:publicId */
export const UpdateAdjustmentRequest = z.object({
  kind: z.enum(['addition', 'deduction']).optional(),
  label: z.string().trim().min(2).max(40).optional(),
  amountPaise: paise.optional(),
  note: z.string().trim().max(200).nullable().optional(),
}).refine((r) => Object.values(r).some((v) => v !== undefined), { message: 'Send at least one field to change' });
export type UpdateAdjustmentRequest = z.infer<typeof UpdateAdjustmentRequest>;

export const PayrollAdjustment = z.object({
  publicId: PublicId, kind: z.enum(['addition', 'deduction']), label: z.string(), amountPaise: z.number().int(), currency: z.string(), note: z.string().nullable(),
});
export type PayrollAdjustment = z.infer<typeof PayrollAdjustment>;

/** One person's pay in a run. salaryForMonth = pay for the days employed − loss of pay; net = that + additions − deductions. */
export const PayrollItem = z.object({
  publicId: PublicId, person: PersonRef, employment: Job, currency: z.string(),
  monthlySalaryPaise: z.number().int(),
  daysInMonth: z.number().int(),       // what the salary is divided by (calendar days, or 30: policy payroll.lop_basis)
  employedDays: z.number().int(),      // days of the month inside the job (joiners and leavers)
  absentDays: z.number(),              // absences and unpaid leave (loss-of-pay days)
  lopAmountPaise: z.number().int(),
  salaryForMonthPaise: z.number().int(),
  additionsTotalPaise: z.number().int(), deductionsTotalPaise: z.number().int(), netPayPaise: z.number().int(),
  adjustments: z.array(PayrollAdjustment),
});
export type PayrollItem = z.infer<typeof PayrollItem>;

export const PayrollRunSummary = z.object({
  publicId: PublicId, company: z.string(), year: z.number().int(), month: z.number().int(), status: PayrollStatus, currency: z.string(),
  preparedBy: PersonRef, preparedAt: Instant, approvedBy: PersonRef.nullable(), approvedAt: Instant.nullable(),
  paidAt: Instant.nullable(), bankRef: z.string().nullable(),
  totals: z.object({ people: z.number().int(), salaryForMonthPaise: z.number().int(), additionsPaise: z.number().int(), deductionsPaise: z.number().int(), netPaise: z.number().int() }),
});
export type PayrollRunSummary = z.infer<typeof PayrollRunSummary>;
export const PayrollRun = PayrollRunSummary.extend({
  items: z.array(PayrollItem),
  /** draft only: jobs in the month with no salary in force (not paid until one is added and the run recalculated) */
  withoutSalary: z.array(z.object({ person: PersonRef, employment: Job })),
});
export type PayrollRun = z.infer<typeof PayrollRun>;

/** GET /api/payroll/payslips/mine — your payslips from approved or paid runs, newest first. */
export const Payslip = z.object({
  run: z.object({ publicId: PublicId, company: z.string(), companyName: z.string(), year: z.number().int(), month: z.number().int(), status: PayrollStatus }),
  item: PayrollItem,
});
export type Payslip = z.infer<typeof Payslip>;
