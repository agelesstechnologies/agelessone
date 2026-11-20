import { z } from 'zod';
import { DateOnly, Instant, PersonRef, PublicId } from './common';
import { IcService } from './intercompany';
/**
 * Design (Ageless Technologies): design jobs received from a client, their drawings and revisions, QC, transmittals
 * (issuing revisions to the client) and the client's response. Tickets of a job carry the work and its time; a job
 * whose client is another group company (AE) makes its tickets billable to that company (Intercompany).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(d)), 'Not a real date');
const emptyToUndefined = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
/** Form fields arrive as text: '' and null both clear an optional text. */
const optionalText = (max: number) => z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(max).nullable().optional());
const company = z.string().trim().min(1).max(12);
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500);
const format = z.enum(['json', 'csv']).default('json');

export const DesignJobStatus = z.enum(['received', 'accepted', 'in_design', 'on_hold', 'closed', 'cancelled']);
export type DesignJobStatus = z.infer<typeof DesignJobStatus>;
/** preliminary: lettered revisions A, B, C …; construction: numbered 0, 1, 2 … (no letters once a construction revision exists) */
export const RevisionStage = z.enum(['preliminary', 'construction']);
export type RevisionStage = z.infer<typeof RevisionStage>;
export const RevisionStatus = z.enum(['draft', 'submitted', 'qc_approved', 'changes_needed', 'issued', 'accepted', 'returned', 'superseded']);
export type RevisionStatus = z.infer<typeof RevisionStatus>;
/** pdf: the drawing itself (one, required to submit); source: CAD files; bom: the bill of materials */
export const RevisionFileKind = z.enum(['pdf', 'source', 'bom']);
export type RevisionFileKind = z.infer<typeof RevisionFileKind>;
export const QcDecision = z.enum(['approved', 'changes_needed']);
export type QcDecision = z.infer<typeof QcDecision>;
export const TransmittalPurpose = z.enum(['for_approval', 'for_construction', 'for_information']);
export type TransmittalPurpose = z.infer<typeof TransmittalPurpose>;
export const ClientResponseKind = z.enum(['accepted', 'returned']);
export type ClientResponseKind = z.infer<typeof ClientResponseKind>;

// ---------------- design jobs ----------------

const receivedFrom = z.object({ name: z.string().trim().min(2).max(120), contact: optionalText(120) });

/** POST /api/design/jobs — a job received from a client. The Designing head or an Admin user (design.jobs.manage). */
export const CreateDesignJobRequest = z.object({
  publicId: z.string().uuid().optional(),
  company,
  customerPublicId: z.string().uuid(),
  /** the client's own name for the work, e.g. "AE PRJ-014 Hungama Dome" */
  clientProjectReference: optionalText(200),
  site: optionalText(300),
  scope: z.string().trim().min(3).max(4000),
  requirements: optionalText(8000),
  dueDate: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable().optional()),
  receivedFrom,
});
export type CreateDesignJobRequest = z.infer<typeof CreateDesignJobRequest>;

/** PATCH /api/design/jobs/:publicId — while the job is not closed or cancelled. The client never changes. */
export const UpdateDesignJobRequest = z.object({
  clientProjectReference: optionalText(200),
  site: optionalText(300),
  scope: z.string().trim().min(3).max(4000).optional(),
  requirements: optionalText(8000),
  dueDate: z.preprocess((v) => (v === '' ? null : v), isoDate.nullable().optional()),
  receivedFrom: receivedFrom.optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Send at least one field to change' });
export type UpdateDesignJobRequest = z.infer<typeof UpdateDesignJobRequest>;

/**
 * POST /api/design/jobs/:publicId/status — received → accepted → in_design → closed; on_hold (with a reason) from any
 * open status, then back to the status it was held in; cancelled (with a reason) from any open status.
 */
export const DesignJobStatusRequest = z.object({
  status: DesignJobStatus.exclude(['received']),
  reason: reason.optional(),
}).refine((v) => !['on_hold', 'cancelled'].includes(v.status) || v.reason !== undefined, { message: 'Holding or cancelling a job needs a reason', path: ['reason'] });
export type DesignJobStatusRequest = z.infer<typeof DesignJobStatusRequest>;

/** POST /api/design/jobs/:publicId/tickets — a ticket of the same company works on this job (once, never moved). */
export const LinkJobTicketRequest = z.object({
  ticketPublicId: z.string().uuid(),
  /** how its time is billed when the client is another group company (the rate card line); design by default */
  serviceType: IcService.default('design'),
});
export type LinkJobTicketRequest = z.infer<typeof LinkJobTicketRequest>;

/** POST /api/design/jobs/:publicId/attachments — multipart: these fields plus the file field `file`. */
export const AddJobAttachmentRequest = z.object({ publicId: emptyToUndefined(z.string().uuid()), description: optionalText(200) });
export type AddJobAttachmentRequest = z.infer<typeof AddJobAttachmentRequest>;

/** GET /api/design/jobs?company=&status=&customer=&q= — q matches the number, the client project reference or the scope. */
export const DesignJobsQuery = z.object({
  company: emptyToUndefined(company),
  status: emptyToUndefined(DesignJobStatus),
  customer: emptyToUndefined(z.string().uuid()),
  q: emptyToUndefined(z.string().trim().max(100)),
});
export type DesignJobsQuery = z.infer<typeof DesignJobsQuery>;

const CustomerRef = z.object({ publicId: PublicId, code: z.string(), name: z.string() });
const JobRef = z.object({ publicId: PublicId, number: z.string() });

export const DesignJob = z.object({
  publicId: PublicId, number: z.string(), company: z.string(), customer: CustomerRef,
  clientProjectReference: z.string().nullable(), site: z.string().nullable(), scope: z.string(), dueDate: DateOnly.nullable(),
  status: DesignJobStatus, holdReason: z.string().nullable(), cancelReason: z.string().nullable(),
  /** on hold: the status the job goes back to */
  resumeStatus: DesignJobStatus.nullable(),
  receivedFrom: z.object({ name: z.string(), contact: z.string().nullable() }),
  /** the client's own project (AE's project register); reserved for later, null for now */
  clientProjectPublicId: PublicId.nullable(),
  drawings: z.number().int(),
  createdBy: PersonRef, createdAt: Instant, updatedAt: Instant.nullable(),
});
export type DesignJob = z.infer<typeof DesignJob>;

export const JobAttachment = z.object({
  publicId: PublicId, name: z.string(), description: z.string().nullable(), fileType: z.string(), sizeBytes: z.number().int(),
  uploadedBy: PersonRef, uploadedAt: Instant,
});
export type JobAttachment = z.infer<typeof JobAttachment>;

export const JobTicket = z.object({
  publicId: PublicId, number: z.string(), title: z.string(), status: z.string(),
  /** the group company its time is billed to (the job's client), or null */
  billableTo: z.string().nullable(),
  /** ticket time so far: allocations plus the heads' adjustments */
  minutes: z.number().int(),
  linkedBy: PersonRef, linkedAt: Instant,
});
export type JobTicket = z.infer<typeof JobTicket>;

export const RevisionRef = z.object({ publicId: PublicId, code: z.string(), stage: RevisionStage, status: RevisionStatus });
export const DrawingSummary = z.object({
  publicId: PublicId, number: z.string(), title: z.string(), discipline: z.string(),
  /** the newest revision, or null before the first */
  current: RevisionRef.nullable(),
});
export type DrawingSummary = z.infer<typeof DrawingSummary>;

export const TransmittalSummary = z.object({
  publicId: PublicId, number: z.string(), purpose: TransmittalPurpose, revisions: z.number().int(), issuedBy: PersonRef, issuedAt: Instant,
});
export type TransmittalSummary = z.infer<typeof TransmittalSummary>;

export const DesignJobDetail = DesignJob.extend({
  requirements: z.string().nullable(),
  attachments: z.array(JobAttachment),
  tickets: z.array(JobTicket),
  /** the job's hours so far: the time of all its tickets */
  minutes: z.number().int(),
  drawings: z.array(DrawingSummary),
  transmittals: z.array(TransmittalSummary),
  /** what the caller may do: manage (the Designing head or design.jobs.manage), draw (also the job's ticket assignees), qc */
  actions: z.object({ manage: z.boolean(), draw: z.boolean(), qc: z.boolean() }),
});
export type DesignJobDetail = z.infer<typeof DesignJobDetail>;

/**
 * GET /api/design/access — what the signed-in person may do in Design, per company, for the web app's menu and buttons
 * (the Designing head and the job's ticket assignees hold no permission, so permissions alone cannot tell).
 */
export const DesignAccessInfo = z.object({
  companies: z.array(z.object({
    company: z.string(), name: z.string(),
    /** the company has the Designing department (policy design.department_prefix): it takes design jobs */
    enabled: z.boolean(),
    manage: z.boolean(), qc: z.boolean(), view: z.boolean(),
  })),
  /** design jobs whose tickets the person works (or worked) on */
  assignedJobs: z.number().int(),
});
export type DesignAccessInfo = z.infer<typeof DesignAccessInfo>;

// ---------------- drawings and revisions ----------------

/** POST /api/design/jobs/:publicId/drawings — numbered <job number>-<discipline>-<seq>, e.g. DJ-025-MEC-001. */
export const CreateDrawingRequest = z.object({
  publicId: z.string().uuid().optional(),
  /** one of the disciplines in policy design.disciplines */
  discipline: z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/, 'Use the discipline code, e.g. MEC'),
  title: z.string().trim().min(2).max(200),
});
export type CreateDrawingRequest = z.infer<typeof CreateDrawingRequest>;

/** PATCH /api/design/drawings/:publicId — the title, until a revision is submitted. */
export const UpdateDrawingRequest = z.object({ title: z.string().trim().min(2).max(200) });
export type UpdateDrawingRequest = z.infer<typeof UpdateDrawingRequest>;

/**
 * POST /api/design/drawings/:publicId/revisions — the next revision: its code follows from the stage (preliminary: next
 * letter; construction: next number). Only when no other revision of the drawing is a draft or submitted. The title
 * block's title and client project reference default to the drawing's and the job's; drawn by: the caller.
 */
export const CreateRevisionRequest = z.object({
  publicId: z.string().uuid().optional(),
  stage: RevisionStage,
  changeNote: z.string().trim().min(3).max(2000),
  title: z.string().trim().min(2).max(200).optional(),
  clientProjectReference: optionalText(200),
  scale: optionalText(30),
  sheet: optionalText(30),
  /** who drew it (a person with a job in the company); the caller when left out */
  drawnByPublicId: z.string().uuid().optional(),
});
export type CreateRevisionRequest = z.infer<typeof CreateRevisionRequest>;

/** PATCH /api/design/revisions/:publicId — only while a draft: a submitted revision never changes. */
export const UpdateRevisionRequest = z.object({
  changeNote: z.string().trim().min(3).max(2000).optional(),
  title: z.string().trim().min(2).max(200).optional(),
  clientProjectReference: optionalText(200),
  scale: optionalText(30),
  sheet: optionalText(30),
  drawnByPublicId: z.string().uuid().optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Send at least one field to change' });
export type UpdateRevisionRequest = z.infer<typeof UpdateRevisionRequest>;

/** POST /api/design/revisions/:publicId/files — multipart: these fields plus the file field `file`. A new pdf replaces the draft's pdf. */
export const AddRevisionFileRequest = z.object({ publicId: emptyToUndefined(z.string().uuid()), kind: RevisionFileKind });
export type AddRevisionFileRequest = z.infer<typeof AddRevisionFileRequest>;

export const RevisionFile = z.object({
  publicId: PublicId, kind: RevisionFileKind, name: z.string(), fileType: z.string(), sizeBytes: z.number().int(), uploadedBy: PersonRef, uploadedAt: Instant,
});
export type RevisionFile = z.infer<typeof RevisionFile>;

export const ChecklistAnswer = z.object({ item: z.string().trim().min(1).max(200), passed: z.boolean(), note: z.string().trim().max(500).optional() });
export type ChecklistAnswer = z.infer<typeof ChecklistAnswer>;

export const QcReview = z.object({
  publicId: PublicId, reviewer: PersonRef, decision: QcDecision, comments: z.string().nullable(),
  checklist: z.array(z.object({ item: z.string(), passed: z.boolean(), note: z.string().nullable() })),
  files: z.array(z.object({ publicId: PublicId, name: z.string(), fileType: z.string() })),
  decidedAt: Instant,
});
export type QcReview = z.infer<typeof QcReview>;

export const ClientResponse = z.object({
  response: ClientResponseKind, comments: z.string().nullable(), respondedOn: DateOnly, responderName: z.string(), recordedBy: PersonRef, recordedAt: Instant,
});
export type ClientResponse = z.infer<typeof ClientResponse>;

export const Revision = z.object({
  publicId: PublicId, drawingPublicId: PublicId, drawingNumber: z.string(), seq: z.number().int(), code: z.string(), stage: RevisionStage,
  title: z.string(), changeNote: z.string(),
  titleBlock: z.object({ clientProjectReference: z.string().nullable(), drawnBy: PersonRef, scale: z.string().nullable(), sheet: z.string().nullable() }),
  status: RevisionStatus,
  files: z.array(RevisionFile),
  qc: QcReview.nullable(),
  issuedIn: z.object({ publicId: PublicId, number: z.string(), purpose: TransmittalPurpose, issuedAt: Instant }).nullable(),
  response: ClientResponse.nullable(),
  createdBy: PersonRef, createdAt: Instant, submittedBy: PersonRef.nullable(), submittedAt: Instant.nullable(), supersededAt: Instant.nullable(),
});
export type Revision = z.infer<typeof Revision>;

export const Drawing = z.object({
  publicId: PublicId, number: z.string(), title: z.string(), discipline: z.string(), job: JobRef, company: z.string(),
  createdBy: PersonRef, createdAt: Instant,
  /** oldest first; the last is the current revision */
  revisions: z.array(Revision),
});
export type Drawing = z.infer<typeof Drawing>;

// ---------------- QC ----------------

/** GET /api/design/qc/checklist?company= — the items of policy design.qc_checklist in force today. */
export const QcChecklistQuery = z.object({ company });
export type QcChecklistQuery = z.infer<typeof QcChecklistQuery>;
export const QcChecklist = z.object({ company: z.string(), items: z.array(z.string()) });
export type QcChecklist = z.infer<typeof QcChecklist>;

/**
 * POST /api/design/revisions/:publicId/qc — multipart (mark-ups in the file field `files`, up to 5) or JSON. Every
 * checklist item answered; approved only when every item passed; changes_needed with comments. Design QC only, never
 * the revision's author or an assignee of the job's tickets.
 */
export const QcReviewRequest = z.object({
  publicId: emptyToUndefined(z.string().uuid()),
  decision: QcDecision,
  comments: optionalText(4000),
  /** a JSON array in a multipart form */
  checklist: z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
  }, z.array(ChecklistAnswer).min(1).max(30)),
}).refine((v) => v.decision === 'approved' || (v.comments ?? '').length >= 3, { message: 'Say what needs changing (comments, at least 3 characters)', path: ['comments'] });
export type QcReviewRequest = z.infer<typeof QcReviewRequest>;

// ---------------- transmittals and client responses ----------------

/**
 * POST /api/design/jobs/:publicId/transmittals — issue QC-approved revisions of this job (at most one per drawing).
 * for_construction: construction revisions only. Issuing supersedes the drawing's earlier issued revision.
 */
export const IssueTransmittalRequest = z.object({
  publicId: z.string().uuid().optional(),
  purpose: TransmittalPurpose,
  revisionPublicIds: z.array(z.string().uuid()).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Each revision once'),
  /** who it is addressed to; the job's "received from" when left out */
  recipient: z.string().trim().min(2).max(200).optional(),
  note: optionalText(1000),
});
export type IssueTransmittalRequest = z.infer<typeof IssueTransmittalRequest>;

/** GET /api/design/transmittals?company=&job= */
export const TransmittalsQuery = z.object({ company: emptyToUndefined(company), job: emptyToUndefined(z.string().uuid()) });
export type TransmittalsQuery = z.infer<typeof TransmittalsQuery>;

export const TransmittalItem = z.object({
  revisionPublicId: PublicId, drawingPublicId: PublicId, drawingNumber: z.string(), title: z.string(), code: z.string(),
  discipline: z.string(), sheet: z.string().nullable(), scale: z.string().nullable(), status: RevisionStatus,
});
export type TransmittalItem = z.infer<typeof TransmittalItem>;

export const Transmittal = z.object({
  publicId: PublicId, number: z.string(), company: z.string(), job: JobRef, customer: CustomerRef,
  clientProjectReference: z.string().nullable(), purpose: TransmittalPurpose, recipient: z.string(), note: z.string().nullable(),
  issuedBy: PersonRef, issuedAt: Instant, items: z.array(TransmittalItem),
});
export type Transmittal = z.infer<typeof Transmittal>;
/** A transmittal in a list: without its items, with how many revisions it issued. */
export const TransmittalListItem = Transmittal.omit({ items: true }).extend({ revisions: z.number().int() });
export type TransmittalListItem = z.infer<typeof TransmittalListItem>;

/** POST /api/design/revisions/:publicId/response — what the client said about an issued revision (recorded by ATPL). */
export const ClientResponseRequest = z.object({
  response: ClientResponseKind,
  comments: optionalText(4000),
  respondedOn: isoDate,
  responderName: z.string().trim().min(2).max(120),
}).refine((v) => v.response === 'accepted' || (v.comments ?? '').length >= 3, { message: 'Say what the client returned it for (comments)', path: ['comments'] });
export type ClientResponseRequest = z.infer<typeof ClientResponseRequest>;

// ---------------- reports (JSON, or CSV with format=csv) ----------------

/** GET /api/design/reports/drawings?company=&job=&status=&discipline= — every drawing with its current revision. */
export const DrawingsReportQuery = z.object({
  company, job: emptyToUndefined(z.string().uuid()),
  /** the current revision's status, or no_revision */
  status: emptyToUndefined(z.union([RevisionStatus, z.literal('no_revision')])),
  discipline: emptyToUndefined(z.string().trim().toUpperCase().max(5)),
  format,
});
export type DrawingsReportQuery = z.infer<typeof DrawingsReportQuery>;
export const DrawingsReport = z.object({
  company: z.string(),
  rows: z.array(z.object({
    job: JobRef, customer: z.string(), drawing: z.object({ publicId: PublicId, number: z.string(), title: z.string(), discipline: z.string() }),
    revision: RevisionRef.nullable(),
  })),
  /** drawings per current status (no_revision: none yet) */
  byStatus: z.record(z.string(), z.number().int()),
});
export type DrawingsReport = z.infer<typeof DrawingsReport>;

/** GET /api/design/reports/qc-queue and /reports/awaiting-response?company= — as of now. */
export const DesignQueueQuery = z.object({ company, format });
export type DesignQueueQuery = z.infer<typeof DesignQueueQuery>;
const QueueRevision = z.object({ job: JobRef, drawing: z.object({ publicId: PublicId, number: z.string(), title: z.string() }), revision: z.object({ publicId: PublicId, code: z.string() }) });
export const QcQueueReport = z.object({
  company: z.string(), asOf: Instant,
  rows: z.array(QueueRevision.extend({ submittedBy: PersonRef, submittedAt: Instant, waitingDays: z.number().int() })),
});
export type QcQueueReport = z.infer<typeof QcQueueReport>;
export const AwaitingResponseReport = z.object({
  company: z.string(), asOf: Instant,
  rows: z.array(QueueRevision.extend({
    transmittal: z.object({ publicId: PublicId, number: z.string(), purpose: TransmittalPurpose }), recipient: z.string(), issuedAt: Instant, waitingDays: z.number().int(),
  })),
});
export type AwaitingResponseReport = z.infer<typeof AwaitingResponseReport>;

/** GET /api/design/reports/qc-by-discipline?company=&from=&to= — QC decisions made between the dates (IST, both included). */
export const QcByDisciplineQuery = z.object({ company, from: isoDate, to: isoDate, format })
  .refine((q) => q.from <= q.to, { message: '"from" must not be after "to"', path: ['to'] });
export type QcByDisciplineQuery = z.infer<typeof QcByDisciplineQuery>;
export const QcByDisciplineReport = z.object({
  company: z.string(), from: DateOnly, to: DateOnly,
  rows: z.array(z.object({ discipline: z.string(), reviews: z.number().int(), approved: z.number().int(), changesNeeded: z.number().int(),
    /** approved ÷ reviews, as a percentage with one decimal */
    passPercent: z.number() })),
});
export type QcByDisciplineReport = z.infer<typeof QcByDisciplineReport>;

/** GET /api/design/reports/hours?company=&from=&to=&job= — ticket time on each job's tickets (allocations plus the heads' adjustments). */
export const DesignHoursQuery = z.object({
  company, from: emptyToUndefined(isoDate), to: emptyToUndefined(isoDate), job: emptyToUndefined(z.string().uuid()), format,
}).refine((q) => !q.from || !q.to || q.from <= q.to, { message: '"from" must not be after "to"', path: ['to'] });
export type DesignHoursQuery = z.infer<typeof DesignHoursQuery>;
export const DesignHoursReport = z.object({
  company: z.string(), from: DateOnly.nullable(), to: DateOnly.nullable(),
  rows: z.array(z.object({ job: JobRef, customer: z.string(), status: DesignJobStatus, tickets: z.number().int(), minutes: z.number().int(), hours: z.number() })),
  totalMinutes: z.number().int(),
});
export type DesignHoursReport = z.infer<typeof DesignHoursReport>;
