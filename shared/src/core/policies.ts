import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from '../common';
/** Company policies: the settings that are not final yet. Shared by the API and the web app. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const company = z.string().trim().min(1).max(12);

/**
 * Every policy the platform reads: the shape of its value and the built-in default (used when no version is stored).
 * POLICY: the defaults are placeholders until HR confirms them.
 */
export const POLICIES = {
  'core.auth.session_hours': { value: z.number().int().min(1).max(720), default: 12, description: 'Hours a sign-in lasts' },
  'hrms.attendance.full_day_minutes': { value: z.number().int().min(1).max(1440), default: 480, description: 'Minutes worked for a full day (overtime after this)' },
  'hrms.attendance.half_day_minutes': { value: z.number().int().min(1).max(1440), default: 240, description: 'Minutes worked for a half day' },
  'hrms.attendance.max_open_punch_hours': { value: z.number().int().min(1).max(48), default: 16, description: 'After this long an open punch-in stops counting as working' },
  'hrms.attendance.auto_punch_out_hours': { value: z.number().int().min(1).max(24), default: 8, description: 'A forgotten punch-out is closed this many hours after the punch-in (when the next punch-in arrives)' },
  'hrms.leave.balance_check': { value: z.boolean(), default: false, description: 'Refuse leave that would take the balance below zero' },
  'hrms.overtime.payable': { value: z.boolean(), default: false, description: 'Overtime is paid' },
  'hrms.approvals.auto_approve_roles': {
    value: z.array(z.string().trim().min(1).max(40)).max(10), default: ['ceo'] as string[],
    description: 'Roles whose own requests (leave, expense, correction, overtime) need no approval: approved on submit, with no decider',
  },
  'hrms.approvals.escalate_after_days': {
    value: z.number().int().min(1).max(60), default: 5,
    description: 'A leave, expense, correction or overtime request with no decision after this many days is sent to the CEO (the approver may still decide it)',
  },
  'tickets.time.split': {
    value: z.enum(['equal']), default: 'equal' as 'equal',
    description: 'How time is shared between tickets running at the same moment: equal = each of n tickets gets 1/n of that period',
  },
  'payroll.lop_basis': {
    value: z.enum(['calendar_days', 'fixed_30']), default: 'calendar_days' as 'calendar_days' | 'fixed_30',
    description: 'Days a monthly salary is divided by for loss of pay and part months: calendar days of the month, or always 30',
  },
} as const;
export type PolicyKey = keyof typeof POLICIES;
export type PolicyValue<K extends PolicyKey> = z.infer<(typeof POLICIES)[K]['value']>;
const keys = Object.keys(POLICIES) as [PolicyKey, ...PolicyKey[]];
export const PolicyKeySchema = z.enum(keys);

/** POST /api/core/policies — a new version (company: one company; left out: the group default). */
export const CreatePolicyRequest = z.object({
  publicId: z.string().uuid().optional(),
  key: PolicyKeySchema,
  company: company.optional(),
  value: z.unknown(),
  effectiveFrom: isoDate,
}).superRefine((r, ctx) => {
  const parsed = POLICIES[r.key]?.value.safeParse(r.value);
  if (parsed && !parsed.success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: parsed.error.issues[0]?.message ?? 'Invalid value' });
});
export type CreatePolicyRequest = z.infer<typeof CreatePolicyRequest>;

/** GET /api/core/policies?key=&company= — every stored version, newest first. */
export const PoliciesQuery = z.object({ key: emptyToUndefined(PolicyKeySchema), company: emptyToUndefined(company) });
export type PoliciesQuery = z.infer<typeof PoliciesQuery>;

/** GET /api/core/policies/in-force?key=&company=&date= — the value used on that date. */
export const PolicyInForceQuery = z.object({ key: PolicyKeySchema, company: emptyToUndefined(company), date: isoDate });
export type PolicyInForceQuery = z.infer<typeof PolicyInForceQuery>;

export const Policy = z.object({
  publicId: PublicId, key: z.string(), company: z.string().nullable(), value: z.unknown(), version: z.number().int(), effectiveFrom: DateOnly,
  approvedBy: PersonRef, createdAt: Instant,
});
export type Policy = z.infer<typeof Policy>;
/** source null: no stored version is in force, the built-in default applies. */
export const PolicyInForce = z.object({ key: z.string(), company: z.string().nullable(), date: DateOnly, value: z.unknown(), source: Policy.nullable() });
export type PolicyInForce = z.infer<typeof PolicyInForce>;
