import { z } from 'zod';
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
}).refine((q) => q.to >= q.from, { message: '`to` is before `from`', path: ['to'] });
export type ExpenseReportQuery = z.infer<typeof ExpenseReportQuery>;

export interface ExpenseCategory { code: string; name: string; receiptRequired: boolean }

export interface ExpenseClaim {
  publicId: string;
  person: { publicId: string; displayName: string };
  employment: { publicId: string; company: string; employeeCode: string };
  category: { code: string; name: string };
  spentOn: string;
  amountPaise: number;
  description: string | null;
  receiptPath: string | null;
  status: ExpenseStatus;
  approvedAmountPaise: number | null;
  approvedBy: { publicId: string; displayName: string } | null;
  approvedAt: string | null;
  rejectedBy: { publicId: string; displayName: string } | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  paidAt: string | null;
  paymentRef: string | null;
  createdAt: string;
}
export interface ExpenseClaimList { items: ExpenseClaim[]; page: number; pageSize: number; total: number }

export interface ExpenseReport {
  company: string | null; from: string; to: string;
  byStatus: { status: ExpenseStatus; count: number; amountPaise: number }[];
  byCategory: { code: string; name: string; count: number; amountPaise: number; approvedPaise: number; paidPaise: number }[];
  total: { count: number; amountPaise: number; approvedPaise: number; paidPaise: number };
}
