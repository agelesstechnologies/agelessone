import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from './common';
/**
 * Intercompany: services one company of the group provides to another (ATPL → AE) under an agreement — rate card or
 * cost plus, costs passed on with their bills, tickets billable to the other company, and months already billed.
 * Money is integer minor units (paise) with its currency (INR only for now).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const company = z.string().trim().min(1).max(12);
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500);
/** Minor units (paise): a whole number above zero. Form fields arrive as text, so numbers are read from strings. */
const minor = z.coerce.number().int('Use a whole number of paise').positive('Must be more than 0').max(Number.MAX_SAFE_INTEGER);
/** A percentage with at most 2 decimals, 0 to 100 (12.5 = 12.5 %). */
const percent = z.number().min(0).max(100).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'Use at most 2 decimals');
const currency = z.literal('INR');
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export const IcService = z.enum(['design', 'software', 'iot_hardware', 'cgi']);
export type IcService = z.infer<typeof IcService>;
export const IcPricingMethod = z.enum(['rate_card', 'cost_plus']);
export type IcPricingMethod = z.infer<typeof IcPricingMethod>;
/** Costs passed on (bought for the other company): billed at cost, or with a percentage on top. */
export const IcPassedCostHandling = z.enum(['at_cost', 'percent']);
export type IcPassedCostHandling = z.infer<typeof IcPassedCostHandling>;
export const IcAgreementStatus = z.enum(['draft', 'active', 'ended']);
export type IcAgreementStatus = z.infer<typeof IcAgreementStatus>;
/** What a ticket is done for in the other company: one of its projects or design requests (stored as given until those registers exist). */
export const IcLinkKind = z.enum(['project', 'design_request']);
export type IcLinkKind = z.infer<typeof IcLinkKind>;

// ---------------- agreements ----------------

/** One side of an agreement: the company, its head (who sees the agreement) and its approver — jobs in that company. */
const SideRequest = z.object({
  company,
  headEmploymentPublicId: z.string().uuid(),
  approverEmploymentPublicId: z.string().uuid(),
});

/**
 * POST /api/intercompany/agreements — created as a draft. reviewDays / paymentTermsDays left out: the provider's policy
 * (intercompany.review_days, 5; intercompany.payment_terms_days, 30) on the start date.
 */
export const CreateAgreementRequest = z.object({
  publicId: z.string().uuid().optional(),
  provider: SideRequest,
  receiver: SideRequest,
  services: z.array(IcService).min(1).max(4).refine((s) => new Set(s).size === s.length, 'Each service once'),
  pricingMethod: IcPricingMethod,
  /** cost_plus only: the percentage added to cost */
  costPlusPercent: percent.optional(),
  passedCostHandling: IcPassedCostHandling.default('at_cost'),
  /** percent only: the percentage added to costs passed on */
  passedCostPercent: percent.optional(),
  reviewDays: z.number().int().min(1).max(60).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  startDate: isoDate,
}).superRefine((r, ctx) => {
  if (r.provider.company.toUpperCase() === r.receiver.company.toUpperCase()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['receiver', 'company'], message: 'The receiver must be another company than the provider' });
  }
  if ((r.pricingMethod === 'cost_plus') !== (r.costPlusPercent !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costPlusPercent'], message: 'Give the cost plus percentage with cost_plus pricing, and only then' });
  }
  if ((r.passedCostHandling === 'percent') !== (r.passedCostPercent !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['passedCostPercent'], message: 'Give the passed cost percentage with percent handling, and only then' });
  }
});
export type CreateAgreementRequest = z.infer<typeof CreateAgreementRequest>;

/**
 * PATCH /api/intercompany/agreements/:publicId — what to change (left out: unchanged; null clears a percentage).
 * status: draft → active → ended (draft → ended drops a draft); an ended agreement never changes. Ending needs endDate.
 * Once a month is billed the pricing terms (services, pricing, percentages) stay as they are.
 */
export const UpdateAgreementRequest = z.object({
  services: z.array(IcService).min(1).max(4).refine((s) => new Set(s).size === s.length, 'Each service once').optional(),
  pricingMethod: IcPricingMethod.optional(),
  costPlusPercent: percent.nullable().optional(),
  passedCostHandling: IcPassedCostHandling.optional(),
  passedCostPercent: percent.nullable().optional(),
  reviewDays: z.number().int().min(1).max(60).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  providerHeadEmploymentPublicId: z.string().uuid().optional(),
  providerApproverEmploymentPublicId: z.string().uuid().optional(),
  receiverHeadEmploymentPublicId: z.string().uuid().optional(),
  receiverApproverEmploymentPublicId: z.string().uuid().optional(),
  /** draft only */
  startDate: isoDate.optional(),
  status: z.enum(['active', 'ended']).optional(),
  /** with status ended, and only then */
  endDate: isoDate.optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Send at least one field to change' })
  .refine((v) => (v.status === 'ended') === (v.endDate !== undefined), { path: ['endDate'], message: 'Give the end date when ending the agreement, and only then' });
export type UpdateAgreementRequest = z.infer<typeof UpdateAgreementRequest>;

/** GET /api/intercompany/agreements — the agreements you may see (filters optional). */
export const AgreementsQuery = z.object({ status: emptyToUndefined(IcAgreementStatus), company: emptyToUndefined(company) });
export type AgreementsQuery = z.infer<typeof AgreementsQuery>;

const Job = z.object({ employmentPublicId: PublicId, person: PersonRef });
const Side = z.object({ company: z.string(), companyName: z.string(), head: Job, approver: Job });

export const IcAgreement = z.object({
  publicId: PublicId, provider: Side, receiver: Side, services: z.array(IcService), pricingMethod: IcPricingMethod,
  costPlusPercent: z.number().nullable(), passedCostHandling: IcPassedCostHandling, passedCostPercent: z.number().nullable(),
  reviewDays: z.number().int(), paymentTermsDays: z.number().int(), startDate: DateOnly, endDate: DateOnly.nullable(), status: IcAgreementStatus,
  createdBy: PersonRef, createdAt: Instant, updatedBy: PersonRef.nullable(), updatedAt: Instant.nullable(),
});
export type IcAgreement = z.infer<typeof IcAgreement>;

// ---------------- rate cards ----------------

/**
 * POST /api/intercompany/agreements/:publicId/rate-cards — an hourly rate for a service type OR a grade, from a date.
 * A new rate is a new row (nothing is edited); months already billed keep the rate in force then. CA TO CONFIRM.
 */
export const AddRateCardRequest = z.object({
  publicId: z.string().uuid().optional(),
  serviceType: IcService.optional(),
  grade: z.string().trim().min(1).max(40).optional(),
  rateMinor: minor,
  currency: currency.default('INR'),
  effectiveFrom: isoDate,
}).refine((r) => (r.serviceType === undefined) !== (r.grade === undefined), { path: ['serviceType'], message: 'Give a service type or a grade (one of them)' });
export type AddRateCardRequest = z.infer<typeof AddRateCardRequest>;

/** GET /api/intercompany/agreements/:publicId/rate-cards?on= — every rate (newest first), or with `on` the ones in force that day. */
export const RateCardsQuery = z.object({ on: emptyToUndefined(isoDate) });
export type RateCardsQuery = z.infer<typeof RateCardsQuery>;

export const IcRateCard = z.object({
  publicId: PublicId, serviceType: IcService.nullable(), grade: z.string().nullable(), rateMinor: z.number().int(), currency: z.string(),
  effectiveFrom: DateOnly, createdBy: PersonRef, createdAt: Instant,
});
export type IcRateCard = z.infer<typeof IcRateCard>;

// ---------------- billed months ----------------

/** POST /api/intercompany/agreements/:publicId/billed-months — a finished month is billed; it never changes again. */
export const MarkMonthBilledRequest = z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });
export type MarkMonthBilledRequest = z.infer<typeof MarkMonthBilledRequest>;
export const IcBilledMonth = z.object({ year: z.number().int(), month: z.number().int(), billedBy: PersonRef, billedAt: Instant });
export type IcBilledMonth = z.infer<typeof IcBilledMonth>;

export const IcAgreementDetail = IcAgreement.extend({ rateCards: z.array(IcRateCard), billedMonths: z.array(IcBilledMonth) });
export type IcAgreementDetail = z.infer<typeof IcAgreementDetail>;

// ---------------- passed-on costs ----------------

/**
 * POST /api/intercompany/agreements/:publicId/passed-costs — multipart/form-data: these fields plus an optional file
 * field `bill` (JPEG, PNG or PDF). A cost is counted only once its bill is attached.
 */
export const AddPassedCostRequest = z.object({
  publicId: emptyToUndefined(z.string().uuid()),
  /** the receiver's project (Operations, when it exists); stored as given for now */
  projectPublicId: emptyToUndefined(z.string().uuid()),
  description: z.string().trim().min(3).max(300),
  amountMinor: minor,
  currency: z.preprocess((v) => (v === '' || v === undefined ? 'INR' : v), currency),
  incurredOn: isoDate,
});
export type AddPassedCostRequest = z.infer<typeof AddPassedCostRequest>;

/** GET /api/intercompany/agreements/:publicId/passed-costs?month=YYYY-MM */
export const PassedCostsQuery = z.object({ month: emptyToUndefined(yearMonth) });
export type PassedCostsQuery = z.infer<typeof PassedCostsQuery>;

export const IcPassedCost = z.object({
  publicId: PublicId, agreementPublicId: PublicId, projectPublicId: PublicId.nullable(), description: z.string(),
  amountMinor: z.number().int(), currency: z.string(), incurredOn: DateOnly,
  bill: z.object({ fileType: z.string(), uploadedBy: PersonRef, uploadedAt: Instant }).nullable(),
  /** the bill is attached: the cost counts */
  counted: z.boolean(),
  createdBy: PersonRef, createdAt: Instant,
});
export type IcPassedCost = z.infer<typeof IcPassedCost>;
export const IcPassedCostList = z.object({
  rows: z.array(IcPassedCost), currency: z.string(),
  /** with a bill: what counts */
  countedMinor: z.number().int(),
  /** still waiting for a bill: not counted */
  waitingForBillMinor: z.number().int(),
});
export type IcPassedCostList = z.infer<typeof IcPassedCostList>;

// ---------------- tickets ----------------

/**
 * PUT /api/intercompany/tickets/:ticketPublicId/link — the ticket is done for another company's project or design
 * request: it becomes billable to that company (by default). Linking again to the same company keeps the billable
 * decision; another company starts again as billable. serviceType: what the work is billed as (its rate card line).
 */
export const LinkTicketToWorkRequest = z.object({ kind: IcLinkKind, publicId: z.string().uuid(), company, serviceType: IcService });
export type LinkTicketToWorkRequest = z.infer<typeof LinkTicketToWorkRequest>;

/** POST /api/intercompany/tickets/:ticketPublicId/billable — not billable needs a reason (audited). */
export const SetBillableRequest = z.object({ billable: z.boolean(), reason: reason.optional() })
  .refine((v) => v.billable || v.reason !== undefined, { path: ['reason'], message: 'Give a reason for not billing this ticket' });
export type SetBillableRequest = z.infer<typeof SetBillableRequest>;

export const TicketBilling = z.object({
  ticket: z.object({ publicId: PublicId, number: z.string(), title: z.string(), company: z.string() }),
  /** null: not linked to another company's work, so not billable */
  link: z.object({ kind: IcLinkKind, publicId: PublicId }).nullable(),
  /** the company the ticket is billable to (company code), from the link */
  billableTo: z.string().nullable(),
  /** what its time is billed as (null: linked before service types were asked; link it again) */
  serviceType: IcService.nullable(),
  billable: z.boolean(),
  notBillableReason: z.string().nullable(),
  changedBy: PersonRef.nullable(), changedAt: Instant.nullable(),
});
export type TicketBilling = z.infer<typeof TicketBilling>;

// ---------------- monthly statements ----------------

/**
 * draft → approved_by_provider → sent → accepted | partly_disputed; partly_disputed → (corrected / explained) → sent again;
 * accepted → invoiced → closed.
 */
export const IcStatementStatus = z.enum(['draft', 'approved_by_provider', 'sent', 'partly_disputed', 'accepted', 'invoiced', 'closed']);
export type IcStatementStatus = z.infer<typeof IcStatementStatus>;
/** labour: ticket hours × rate; passed_cost: a cost with its bill; credit: a correction made after invoicing (negative). */
export const IcLineKind = z.enum(['labour', 'passed_cost', 'credit']);
export type IcLineKind = z.infer<typeof IcLineKind>;
/** pending: waiting for the receiver's answer; removed: taken off by the provider after a dispute. */
export const IcLineStatus = z.enum(['pending', 'accepted', 'disputed', 'removed']);
export type IcLineStatus = z.infer<typeof IcLineStatus>;
export const IcLineResolution = z.enum(['corrected', 'removed', 'explained']);
export type IcLineResolution = z.infer<typeof IcLineResolution>;
/** One step of a line's dispute thread (credited: corrected after invoicing, as a credit on the next statement). */
export const IcLineEventKind = z.enum(['disputed', 'corrected', 'removed', 'explained', 'credited']);
export type IcLineEventKind = z.infer<typeof IcLineEventKind>;

/** POST /api/intercompany/agreements/:publicId/statements — the statement of a month (asking again answers the stored one). */
export const BuildStatementRequest = z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) });
export type BuildStatementRequest = z.infer<typeof BuildStatementRequest>;

/** GET /api/intercompany/statements?agreement=&status=&year= — the statements you may see, newest month first. */
export const StatementsQuery = z.object({
  agreement: emptyToUndefined(z.string().uuid()),
  status: emptyToUndefined(IcStatementStatus),
  year: emptyToUndefined(z.coerce.number().int().min(2000).max(2100)),
});
export type StatementsQuery = z.infer<typeof StatementsQuery>;

/** POST /api/intercompany/statements/:publicId/answer — the receiver: dispute these lines (with a reason); every other line waiting is accepted. */
export const AnswerStatementRequest = z.object({
  disputes: z.array(z.object({ linePublicId: z.string().uuid(), reason })).max(500).default([])
    .refine((d) => new Set(d.map((x) => x.linePublicId)).size === d.length, 'Each line once'),
});
export type AnswerStatementRequest = z.infer<typeof AnswerStatementRequest>;

/**
 * POST /api/intercompany/statement-lines/:publicId/correct — reduce the line to amountMinor, or remove it; reason required.
 * On a disputed line it changes the line; after invoicing it becomes a credit line on the next statement.
 */
export const CorrectLineRequest = z.object({
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  remove: z.literal(true).optional(),
  reason,
}).refine((v) => (v.amountMinor === undefined) !== (v.remove === undefined), { path: ['amountMinor'], message: 'Give the new amount, or remove the line (one of them)' });
export type CorrectLineRequest = z.infer<typeof CorrectLineRequest>;

/** POST /api/intercompany/statement-lines/:publicId/explain — keep a disputed line as it is, saying why. */
export const ExplainLineRequest = z.object({ reason });
export type ExplainLineRequest = z.infer<typeof ExplainLineRequest>;

export const InvoiceStatementRequest = z.object({ invoiceNumber: z.string().trim().min(1).max(40), invoicedOn: isoDate });
export type InvoiceStatementRequest = z.infer<typeof InvoiceStatementRequest>;
export const CloseStatementRequest = z.object({ paidOn: isoDate, paymentRef: z.string().trim().min(1).max(60) });
export type CloseStatementRequest = z.infer<typeof CloseStatementRequest>;

const Who = z.object({ by: PersonRef, at: Instant });
export const IcStatementLine = z.object({
  publicId: PublicId, kind: IcLineKind, description: z.string(),
  /** the receiver's project or design request the work was for */
  project: z.object({ kind: IcLinkKind, publicId: PublicId }).nullable(),
  serviceType: IcService.nullable(),
  /** labour: who did the work, and the grade (their designation) when the rate is a grade's */
  person: PersonRef.nullable(), employmentPublicId: PublicId.nullable(), grade: z.string().nullable(),
  minutes: z.number().int().nullable(),
  /** the rate in force on the work dates, per hour; cost_plus: cost per hour plus the percentage */
  rateMinor: z.number().int().nullable(),
  amountMinor: z.number().int(),
  /** before a correction */
  originalAmountMinor: z.number().int().nullable(),
  /** the CEO only (null for everyone else): cost per hour from payroll, and the line's cost */
  costPerHourMinor: z.number().int().nullable(), costMinor: z.number().int().nullable(),
  status: IcLineStatus,
  dispute: Who.extend({ reason: z.string() }).nullable(),
  resolution: Who.extend({ kind: IcLineResolution, reason: z.string() }).nullable(),
  /** credited after invoicing (on later statements) */
  creditedMinor: z.number().int(),
  /** the line's dispute thread, oldest first: each dispute, correction, removal, explanation and credit */
  thread: z.array(z.object({
    kind: IcLineEventKind, round: z.number().int(), reason: z.string(),
    amountBeforeMinor: z.number().int().nullable(), amountAfterMinor: z.number().int().nullable(), by: PersonRef, at: Instant,
  })),
  /** the tickets whose time is on the line, with their minutes */
  tickets: z.array(z.object({ publicId: PublicId, number: z.string(), title: z.string(), minutes: z.number().int() })),
  passedCostPublicId: PublicId.nullable(),
  /** credit lines: the corrected line of an earlier statement */
  creditFor: z.object({ statementPublicId: PublicId, linePublicId: PublicId, reason: z.string() }).nullable(),
});
export type IcStatementLine = z.infer<typeof IcStatementLine>;

export const IcStatement = z.object({
  publicId: PublicId, agreementPublicId: PublicId, provider: z.string(), receiver: z.string(), year: z.number().int(), month: z.number().int(),
  status: IcStatementStatus, currency: z.string(),
  /** times sent to the receiver */
  round: z.number().int(),
  totalMinor: z.number().int(), minutes: z.number().int(),
  /** the CEO only (null for everyone else) */
  costMinor: z.number().int().nullable(),
  preparedBy: PersonRef, preparedAt: Instant,
  approved: Who.extend({ as: z.enum(['head', 'ceo']) }).nullable(),
  firstSentAt: Instant.nullable(), sentAt: Instant.nullable(),
  /** the receiver answers by this date (IST); no answer by then: accepted automatically */
  reviewDueOn: DateOnly.nullable(),
  accepted: z.object({ at: Instant, as: z.enum(['receiver', 'automatic']), by: PersonRef.nullable() }).nullable(),
  invoice: z.object({ number: z.string(), on: DateOnly, by: PersonRef }).nullable(),
  closed: z.object({ paidOn: DateOnly, paymentRef: z.string(), by: PersonRef, at: Instant }).nullable(),
});
export type IcStatement = z.infer<typeof IcStatement>;
export const IcStatementDetail = IcStatement.extend({
  lines: z.array(IcStatementLine),
  /** what the caller may do now (the server checks again): rebuild, approve, send (again), answer, correct / explain lines, invoice, close */
  actions: z.object({
    rebuild: z.boolean(), approve: z.boolean(), send: z.boolean(), answer: z.boolean(), correct: z.boolean(), invoice: z.boolean(), close: z.boolean(),
  }),
  /** the agreement's payment terms: an invoice is due this many days after its date */
  paymentTermsDays: z.number().int(),
  /**
   * Whose side the caller is on: provider (its head or approver, or a department head with time on it: the invoice),
   * receiver (its head or approver: the bill), all (the CEO).
   */
  viewerSide: z.enum(['provider', 'receiver', 'all']),
});
export type IcStatementDetail = z.infer<typeof IcStatementDetail>;

/** GET /api/intercompany/access — what the caller sees of Intercompany (for the menu; every request is checked again). */
export const IcAccess = z.object({
  /** the CEO (view or manage, scope all) */
  seesAll: z.boolean(),
  /** creates and changes agreements (manage, scope all) */
  manages: z.boolean(),
  /** agreements the caller sees (named head, or all for the CEO) */
  agreements: z.number().int(),
  /** sees statements: the CEO, a head or approver named on an agreement, or the head of a department with time on one */
  statements: z.boolean(),
});
export type IcAccess = z.infer<typeof IcAccess>;

// ---------------- reports and dashboard ----------------

const format = z.enum(['json', 'csv']).default('json');
/** GET /api/intercompany/reports/...?from=YYYY-MM&to=YYYY-MM&company=&format=csv — months both included; company: either side. */
export const IcReportQuery = z.object({ from: yearMonth, to: yearMonth, company: emptyToUndefined(company), format })
  .refine((q) => q.from <= q.to, { path: ['to'], message: 'The end month is before the start month' });
export type IcReportQuery = z.infer<typeof IcReportQuery>;

const Pair = { month: z.string(), provider: z.string(), receiver: z.string() };
const Project = z.object({ kind: IcLinkKind, publicId: PublicId }).nullable();

/** Billed hours and amounts: the lines of statements past draft (removed lines left out). */
export const IcBilledReport = z.object({
  from: z.string(), to: z.string(),
  rows: z.array(z.object({ ...Pair, statementPublicId: PublicId, status: IcStatementStatus, kind: IcLineKind, serviceType: IcService.nullable(),
    project: Project, person: z.string().nullable(), grade: z.string().nullable(), minutes: z.number().int().nullable(),
    rateMinor: z.number().int().nullable(), amountMinor: z.number().int() })),
  totalMinutes: z.number().int(), totalMinor: z.number().int(),
});
export type IcBilledReport = z.infer<typeof IcBilledReport>;

/** Billable ticket time in months with no statement past draft yet. */
export const IcUnbilledReport = z.object({
  from: z.string(), to: z.string(),
  rows: z.array(z.object({ ...Pair, ticket: z.object({ publicId: PublicId, number: z.string(), title: z.string() }), serviceType: IcService.nullable(),
    project: Project, person: PersonRef, minutes: z.number().int() })),
  totalMinutes: z.number().int(),
});
export type IcUnbilledReport = z.infer<typeof IcUnbilledReport>;

export const IcDisputesReport = z.object({
  from: z.string(), to: z.string(),
  rows: z.array(z.object({ ...Pair, statementPublicId: PublicId, linePublicId: PublicId, description: z.string(), amountMinor: z.number().int(),
    originalAmountMinor: z.number().int().nullable(), reason: z.string(), disputedBy: PersonRef, disputedAt: Instant,
    resolution: IcLineResolution.nullable(), resolutionReason: z.string().nullable(), resolvedBy: PersonRef.nullable(), resolvedAt: Instant.nullable(),
    lineStatus: IcLineStatus })),
});
export type IcDisputesReport = z.infer<typeof IcDisputesReport>;

/** The CEO only: billed against cost per statement. costMissing: someone on it has no salary in payroll (their cost is left out). */
export const IcMarginReport = z.object({
  from: z.string(), to: z.string(),
  rows: z.array(z.object({ ...Pair, statementPublicId: PublicId, status: IcStatementStatus, billedMinor: z.number().int(), costMinor: z.number().int(),
    marginMinor: z.number().int(), marginPercent: z.number().nullable(), costMissing: z.boolean() })),
  billedMinor: z.number().int(), costMinor: z.number().int(), marginMinor: z.number().int(),
});
export type IcMarginReport = z.infer<typeof IcMarginReport>;

/** What the receiver pays per project (statements past draft). */
export const IcReceiverCostReport = z.object({
  from: z.string(), to: z.string(),
  rows: z.array(z.object({ receiver: z.string(), provider: z.string(), project: Project, minutes: z.number().int(), labourMinor: z.number().int(),
    passedCostsMinor: z.number().int(), creditsMinor: z.number().int(), totalMinor: z.number().int() })),
  totalMinor: z.number().int(),
});
export type IcReceiverCostReport = z.infer<typeof IcReceiverCostReport>;

/** GET /api/intercompany/reports/balance?company=&format=csv — invoiced and not yet paid, as of today (IST). */
export const IcBalanceQuery = z.object({ company: emptyToUndefined(company), format });
export type IcBalanceQuery = z.infer<typeof IcBalanceQuery>;
export const IcBalanceReport = z.object({
  asOf: DateOnly,
  /** each invoice not yet paid; due = invoice date + the agreement's payment terms */
  rows: z.array(z.object({ provider: z.string(), receiver: z.string(), month: z.string(), statementPublicId: PublicId, invoiceNumber: z.string(),
    invoicedOn: DateOnly, dueOn: DateOnly, amountMinor: z.number().int(), overdueDays: z.number().int() })),
  /** what each receiver owes each provider */
  pairs: z.array(z.object({ provider: z.string(), receiver: z.string(), amountMinor: z.number().int(), overdueMinor: z.number().int() })),
  totalMinor: z.number().int(),
});
export type IcBalanceReport = z.infer<typeof IcBalanceReport>;

/** GET /api/intercompany/dashboard — the CEO's cards. */
export const IcDashboard = z.object({
  asOf: Instant, month: z.string(),
  /** statements first sent to the receiver this month (IST) */
  billedThisMonthMinor: z.number().int(),
  /** billable ticket time in months with no statement past draft */
  unbilledMinutes: z.number().int(),
  /** invoiced, not yet paid (closed) */
  balanceMinor: z.number().int(),
  balances: z.array(z.object({ provider: z.string(), receiver: z.string(), amountMinor: z.number().int() })),
});
export type IcDashboard = z.infer<typeof IcDashboard>;
