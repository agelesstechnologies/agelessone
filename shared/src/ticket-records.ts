import { z } from 'zod';
import { DateOnly, DecidedAs, Instant, PersonRef, PublicId } from './common';
import { CompletionRules, TicketField } from './tickets';
/** Tickets: the work itself (number, type details, assignees, checklist, files, sign-off, links, timeline). */

const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const company = z.string().trim().min(1).max(12);
const reason = z.string().trim().min(3, 'Give a reason').max(500);

export const TicketStatus = z.enum(['open', 'assigned', 'in_progress', 'on_hold', 'completed', 'cancelled']);
export type TicketStatus = z.infer<typeof TicketStatus>;
export const ChecklistResult = z.enum(['pass', 'fail', 'na']);
export type ChecklistResult = z.infer<typeof ChecklistResult>;
export const AttachmentKind = z.enum(['photo', 'file', 'signoff']);
export type AttachmentKind = z.infer<typeof AttachmentKind>;
export const TicketLinkKind = z.enum(['follows', 'rework_of']);
export type TicketLinkKind = z.infer<typeof TicketLinkKind>;

/** One person on a ticket: exactly one is primary once anyone is assigned. A single assignee is primary. */
export const AssigneeInput = z.object({ employmentPublicId: z.string().uuid(), isPrimary: z.boolean().optional() });
export type AssigneeInput = z.infer<typeof AssigneeInput>;
const Assignees = z.array(AssigneeInput).min(1).max(20)
  .refine((a) => new Set(a.map((x) => x.employmentPublicId)).size === a.length, 'Each person once')
  .refine((a) => a.length === 1 || a.filter((x) => x.isPrimary).length === 1, 'Mark exactly one assignee as primary');

/**
 * Values for the type's fields, by key. text and customer: text; number: a number; money: integer paise; date: YYYY-MM-DD;
 * person: a person's publicId; file: the publicId of an attachment of this ticket (so set on update, after uploading).
 */
export const TypeDetails = z.record(z.string(), z.unknown());

/** POST /api/tickets */
export const CreateTicketRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  typePublicId: z.string().uuid(),
  title: z.string().trim().min(3).max(150),
  description: z.string().trim().max(1000).optional(),
  priority: z.number().int().min(1).max(5).default(3),
  /** the customer's id once the customer register exists (Sales); stored as given for now */
  customerId: z.string().uuid().optional(),
  site: z.string().trim().min(1).max(200).optional(),
  departmentPublicId: z.string().uuid(),
  /** default: the department's head */
  supervisorPublicId: z.string().uuid().optional(),
  /** an assignee without this skill gives a warning, never a refusal */
  requiredSkillPublicId: z.string().uuid().optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  dueDate: isoDate.optional(),
  details: TypeDetails.default({}),
  assignees: Assignees.optional(),
});
export type CreateTicketRequest = z.infer<typeof CreateTicketRequest>;

/** PATCH /api/tickets/:id — not after completion or cancellation. null clears an optional value. */
export const UpdateTicketRequest = z.object({
  title: z.string().trim().min(3).max(150).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  customerId: z.string().uuid().nullable().optional(),
  site: z.string().trim().min(1).max(200).nullable().optional(),
  supervisorPublicId: z.string().uuid().optional(),
  requiredSkillPublicId: z.string().uuid().nullable().optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  dueDate: isoDate.nullable().optional(),
  /** the whole set of values (replaces the stored one), checked against the ticket's type version */
  details: TypeDetails.optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Send at least one field to change' });
export type UpdateTicketRequest = z.infer<typeof UpdateTicketRequest>;

/** PUT /api/tickets/:id/assignees — the whole list (people missing from it are taken off; nothing is deleted). */
export const AssignTicketRequest = z.object({ assignees: Assignees });
export type AssignTicketRequest = z.infer<typeof AssignTicketRequest>;

export const ReasonRequest = z.object({ reason });
export type ReasonRequest = z.infer<typeof ReasonRequest>;

export const ChecklistResultRequest = z.object({ item: z.string().trim().min(1).max(120), result: ChecklistResult, note: z.string().trim().max(500).optional() });
export type ChecklistResultRequest = z.infer<typeof ChecklistResultRequest>;

/** multipart/form-data: these fields plus the file field `file`. */
export const AttachmentRequest = z.object({ kind: z.enum(['photo', 'file']) });
export type AttachmentRequest = z.infer<typeof AttachmentRequest>;

/** multipart/form-data: these fields plus the file field `photo` (the signed handover sheet, JPEG or PNG). */
export const SignoffRequest = z.object({
  signerName: z.string().trim().min(2).max(100),
  signerRole: emptyToUndefined(z.string().trim().min(1).max(100)),
  signedAt: emptyToUndefined(z.string().datetime({ offset: true })),
});
export type SignoffRequest = z.infer<typeof SignoffRequest>;


export const LinkTicketRequest = z.object({ toTicketPublicId: z.string().uuid(), kind: TicketLinkKind.default('follows') });
export type LinkTicketRequest = z.infer<typeof LinkTicketRequest>;

export const ApproveReassignRequest = z.object({ newEmploymentPublicId: z.string().uuid() });
export type ApproveReassignRequest = z.infer<typeof ApproveReassignRequest>;

/** GET /api/tickets — every filter is optional. from / to: scheduled date range (IST). overdue: due date passed, not finished. */
export const TicketsQuery = z.object({
  company: emptyToUndefined(company),
  type: emptyToUndefined(z.string().uuid()),
  status: emptyToUndefined(TicketStatus),
  department: emptyToUndefined(z.string().uuid()),
  /** an employment's or a person's publicId */
  assignee: emptyToUndefined(z.string().uuid()),
  customer: emptyToUndefined(z.string().uuid()),
  priority: emptyToUndefined(z.coerce.number().int().min(1).max(5)),
  overdue: emptyToUndefined(z.enum(['true', 'false']).transform((v) => v === 'true')),
  from: emptyToUndefined(isoDate),
  to: emptyToUndefined(isoDate),
  limit: emptyToUndefined(z.coerce.number().int().min(1).max(500)),
  offset: emptyToUndefined(z.coerce.number().int().min(0)),
});
export type TicketsQuery = z.infer<typeof TicketsQuery>;

export const MyTicketsQuery = z.object({ status: emptyToUndefined(TicketStatus) });
export type MyTicketsQuery = z.infer<typeof MyTicketsQuery>;

/** PUT /api/tickets/number-series/:company — e.g. prefix AGE and nextNumber 559 after importing Froid tickets up to AGE-0558. */
export const NumberSeriesRequest = z.object({
  prefix: z.string().trim().regex(/^[A-Z0-9]{1,10}$/, 'Capital letters and digits, up to 10'),
  nextNumber: z.number().int().min(1).max(99_999_999),
});
export type NumberSeriesRequest = z.infer<typeof NumberSeriesRequest>;
export const NumberSeries = z.object({ company: z.string(), prefix: z.string(), nextNumber: z.number().int(), example: z.string() });
export type NumberSeries = z.infer<typeof NumberSeries>;

// ---- answers ----

const Ref = z.object({ publicId: PublicId, name: z.string() });
const TypeRef = z.object({ publicId: PublicId, version: z.number().int(), code: z.string(), name: z.string() });
export const Assignee = z.object({
  employmentPublicId: PublicId, employeeCode: z.string(), person: PersonRef, isPrimary: z.boolean(), assignedAt: Instant, assignedBy: PersonRef,
});
export type Assignee = z.infer<typeof Assignee>;

export const TicketSummary = z.object({
  publicId: PublicId, number: z.string(), company: z.string(), type: TypeRef, title: z.string(), priority: z.number().int(),
  status: TicketStatus, department: Ref, supervisor: PersonRef, primaryAssignee: Assignee.nullable(), customerId: PublicId.nullable(),
  site: z.string().nullable(), scheduledAt: Instant, dueDate: DateOnly.nullable(), overdue: z.boolean(), completedAt: Instant.nullable(), createdAt: Instant,
});
export type TicketSummary = z.infer<typeof TicketSummary>;

export const ChecklistLine = z.object({
  item: z.string(), result: ChecklistResult.nullable(), note: z.string().nullable(), checkedBy: PersonRef.nullable(), checkedAt: Instant.nullable(),
});
export const TicketAttachment = z.object({ publicId: PublicId, kind: AttachmentKind, fileType: z.string(), uploadedBy: PersonRef, uploadedAt: Instant });
export const TicketSignoff = z.object({
  publicId: PublicId, signerName: z.string(), signerRole: z.string().nullable(), signedAt: Instant, photoPublicId: PublicId, recordedBy: PersonRef,
});
export const TicketLink = z.object({
  direction: z.enum(['to', 'from']), kind: TicketLinkKind,
  ticket: z.object({ publicId: PublicId, number: z.string(), title: z.string(), status: TicketStatus }),
});
export const TicketEvent = z.object({ action: z.string(), actor: PersonRef.nullable(), at: Instant, details: z.record(z.string(), z.unknown()).nullable() });
export const ReassignStatus = z.enum(['pending', 'approved', 'rejected']);
export const ReassignmentRequest = z.object({
  publicId: PublicId, ticketPublicId: PublicId, ticketNumber: z.string(), requestedBy: PersonRef, reason: z.string(), status: ReassignStatus,
  approver: PersonRef.nullable(), newAssignee: PersonRef.nullable(), decidedBy: PersonRef.nullable(), decidedAs: DecidedAs.nullable(),
  decidedAt: Instant.nullable(), decisionReason: z.string().nullable(), createdAt: Instant,
});
export type ReassignmentRequest = z.infer<typeof ReassignmentRequest>;
export const ReassignRequestsQuery = z.object({ status: emptyToUndefined(ReassignStatus) });
export type ReassignRequestsQuery = z.infer<typeof ReassignRequestsQuery>;

/** A warning that does not stop the change (e.g. an assignee without the ticket's required skill). */
export const TicketWarning = z.object({ code: z.string(), message: z.string(), employmentPublicId: PublicId.optional() });

export const TicketDetail = TicketSummary.extend({
  description: z.string().nullable(), details: z.record(z.string(), z.unknown()), projectId: z.null(),
  holdReason: z.string().nullable(), cancelReason: z.string().nullable(), requiredSkill: Ref.nullable(),
  headApproval: z.object({ by: PersonRef, at: Instant }).nullable(), createdBy: PersonRef,
  typeRules: z.object({ fields: z.array(TicketField), completionRules: CompletionRules, checklistItems: z.array(z.string()) }),
  assignees: z.array(Assignee), checklist: z.array(ChecklistLine), attachments: z.array(TicketAttachment), signoffs: z.array(TicketSignoff),
  links: z.array(TicketLink), timeline: z.array(TicketEvent), reassignRequests: z.array(ReassignmentRequest),
  /** what completion still needs (empty when it can be completed) */
  missingForCompletion: z.array(z.string()),
  warnings: z.array(TicketWarning),
});
export type TicketDetail = z.infer<typeof TicketDetail>;
