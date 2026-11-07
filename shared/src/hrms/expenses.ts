import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId, DecidedAs, Escalation } from '../common';
/** Expense claims: requests and responses shared by the API and the web app. Money is always integer paise. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
/** Paise: a whole number above zero (₹123.45 = 12345). Form fields arrive as text, so numbers are read from strings. */
const paise = z.coerce.number().int('Paise must be a whole number').positive('Must be more than 0').max(Number.MAX_SAFE_INTEGER);

export const ExpenseStatus = z.enum(['submitted', 'approved', 'rejected', 'paid']);
export type ExpenseStatus = z.infer<typeof ExpenseStatus>;

/**
 * POST /api/hrms/expenses — sent as multipart/form-data: these text fields plus an optional file field `receipt`
 * (JPEG, PNG or PDF). `publicId` is optional; sending the same one again returns the claim already stored.
 */
export const CreateExpenseRequest = z.object({
  publicId: emptyToUndefined(z.string().uuid()),
  employmentPublicId: z.string().uuid(),
  categoryCode: z.string().trim().min(1).max(20),
  spentOn: isoDate,
  amountPaise: paise,
  description: emptyToUndefined(z.string().trim().max(500)),
});
export type CreateExpenseRequest = z.infer<typeof CreateExpenseRequest>;

/** GET /api/hrms/expenses/mine */
export const MyExpensesQuery = z.object({
  status: emptyToUndefined(ExpenseStatus),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type MyExpensesQuery = z.infer<typeof MyExpensesQuery>;

/** POST /api/hrms/expenses/:publicId/approve — approve the claimed amount, or a lower one. */
export const ApproveExpenseRequest = z.object({ approvedAmountPaise: paise.optional() });
export type ApproveExpenseRequest = z.infer<typeof ApproveExpenseRequest>;

/** POST /api/hrms/expenses/:publicId/reject */
export const RejectExpenseRequest = z.object({ reason: z.string().trim().min(3).max(500) });
export type RejectExpenseRequest = z.infer<typeof RejectExpenseRequest>;

/** POST /api/hrms/expenses/:publicId/mark-paid — paidAt defaults to now. */
export const MarkExpensePaidRequest = z.object({
  paymentRef: z.string().trim().min(1).max(100),
  paidAt: z.string().datetime().optional(),
});
export type MarkExpensePaidRequest = z.infer<typeof MarkExpensePaidRequest>;

/** GET /api/hrms/expenses/report?company=&from=&to= — by date spent; company optional (all companies). */
export const ExpenseReportQuery = z.object({
  company: emptyToUndefined(z.string().trim().max(12)),
  from: isoDate,
  to: isoDate,
  format: z.enum(['json', 'csv']).default('json'), // csv: amounts in rupees, with a TOTAL line
}).refine((q) => q.to >= q.from, { message: '`to` is before `from`', path: ['to'] });
export type ExpenseReportQuery = z.infer<typeof ExpenseReportQuery>;

export const ExpenseCategory = z.object({ code: z.string(), name: z.string(), receiptRequired: z.boolean() });
export type ExpenseCategory = z.infer<typeof ExpenseCategory>;

const Paise = z.number().int();
const CodeName = z.object({ code: z.string(), name: z.string() });

export const ExpenseClaim = z.object({
  publicId: PublicId,
  person: PersonRef,
  employment: z.object({ publicId: PublicId, company: z.string(), employeeCode: z.string() }),
  category: CodeName,
  spentOn: DateOnly,
  amountPaise: Paise,
  currency: z.string(),   // of amountPaise and approvedAmountPaise
  description: z.string().nullable(),
  receiptPath: z.string().nullable(),
  status: ExpenseStatus,
  approvedAmountPaise: Paise.nullable(),
  approvedBy: PersonRef.nullable(),
  approvedAt: Instant.nullable(),
  decidedAs: DecidedAs.nullable(),   // approvedBy is null when no_approval_required
  rejectedBy: PersonRef.nullable(),
  rejectedAt: Instant.nullable(),
  rejectionReason: z.string().nullable(),
  paidAt: Instant.nullable(),
  paymentRef: z.string().nullable(),
  escalation: Escalation.nullable(),  // sent to the CEO (forwarded or waited too long)
  createdAt: Instant,
});
export type ExpenseClaim = z.infer<typeof ExpenseClaim>;
export const ExpenseClaimList = z.object({ items: z.array(ExpenseClaim), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });
export type ExpenseClaimList = z.infer<typeof ExpenseClaimList>;

const Totals = z.object({ count: z.number().int(), amountPaise: Paise, approvedPaise: Paise, paidPaise: Paise });
export const ExpenseReport = z.object({
  company: z.string().nullable(), from: DateOnly, to: DateOnly, producedAt: Instant,
  /** per person, category and status (amounts in paise) */
  rows: z.array(Totals.extend({
    person: PersonRef, employment: z.object({ company: z.string(), employeeCode: z.string() }),
    category: CodeName, status: ExpenseStatus, currency: z.string(),
  })),
  byStatus: z.array(z.object({ status: ExpenseStatus, count: z.number().int(), amountPaise: Paise })),
  byCategory: z.array(Totals.merge(CodeName)),
  total: Totals,
});
export type ExpenseReport = z.infer<typeof ExpenseReport>;
