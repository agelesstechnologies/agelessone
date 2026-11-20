import { sql } from 'drizzle-orm';
import { bigint, check, date, foreignKey, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { customers, legalEntities, persons } from '../core/schema';
import { departments } from '../hrms/people/schema';
import { tickets } from '../tickets/schema';

/**
 * The PostgreSQL schema that only the Design module writes to. Every row belongs to one company (legal_entity_id) and
 * points at its job, drawing or revision with a company-safe key. Triggers (migration 0055): nothing is deleted;
 * submitted revisions, their files, QC decisions, transmittals and client responses never change.
 */
export const design = pgSchema('design');

/** The last number used per company and series (job: DJ-025; transmittal: TR-0001). Prefix and digits: policy design.numbering. */
export const designCounters = design.table('counters', {
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  series: text('series').notNull(),
  lastNumber: integer('last_number').notNull(),
}, (t) => [
  primaryKey({ name: 'counters_pk', columns: [t.legalEntityId, t.series] }),
  check('counters_series_check', sql`series IN ('job','transmittal')`),
  check('counters_last_number_check', sql`last_number >= 1`),
]);

/**
 * A design job received from a client (a customer of the Core list; AE is one). Owned by the company whose Designing
 * department (policy design.department_prefix) does it. received → accepted → in_design → closed; on_hold (reason;
 * resume_status: where it goes back to) and cancelled (reason) from any open status. Never deleted.
 */
export const designJobs = design.table('design_jobs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  /** the company's Designing department: its head runs the job */
  departmentId: bigint('department_id', { mode: 'number' }).notNull(),
  number: text('number').notNull(),
  customerId: bigint('customer_id', { mode: 'number' }).notNull().references(() => customers.id),
  clientProjectReference: text('client_project_reference'),
  site: text('site'),
  scope: text('scope').notNull(),
  requirements: text('requirements'),
  dueDate: date('due_date'),
  receivedFromName: text('received_from_name').notNull(),
  receivedFromContact: text('received_from_contact'),
  status: text('status').notNull().default('received'),
  holdReason: text('hold_reason'),
  resumeStatus: text('resume_status'),
  cancelReason: text('cancel_reason'),
  /** the client's own project (AE's project register, later); reserved, not set yet */
  clientProjectPublicId: uuid('client_project_public_id'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: bigint('updated_by', { mode: 'number' }).references(() => persons.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'design_jobs_department_company_fk', columns: [t.departmentId, t.legalEntityId], foreignColumns: [departments.id, departments.legalEntityId] }),
  unique('design_jobs_company_number_unique').on(t.legalEntityId, t.number),
  unique('design_jobs_id_company_unique').on(t.id, t.legalEntityId),
  index('idx_design_jobs_company_status').on(t.legalEntityId, t.status),
  index('idx_design_jobs_customer').on(t.customerId),
  check('design_jobs_status_check', sql`status IN ('received','accepted','in_design','on_hold','closed','cancelled')`),
  check('design_jobs_hold_fields', sql`(status = 'on_hold') = (hold_reason IS NOT NULL) AND (status = 'on_hold') = (resume_status IS NOT NULL)
    AND (resume_status IS NULL OR resume_status IN ('received','accepted','in_design'))`),
  check('design_jobs_cancel_fields', sql`(status = 'cancelled') = (cancel_reason IS NOT NULL)`),
  check('design_jobs_reason_length', sql`(hold_reason IS NULL OR char_length(hold_reason) BETWEEN 3 AND 500) AND (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 3 AND 500)`),
  check('design_jobs_text_lengths', sql`char_length(scope) BETWEEN 3 AND 4000 AND (requirements IS NULL OR char_length(requirements) <= 8000)
    AND (client_project_reference IS NULL OR char_length(client_project_reference) <= 200) AND (site IS NULL OR char_length(site) <= 300)
    AND char_length(received_from_name) BETWEEN 2 AND 120 AND (received_from_contact IS NULL OR char_length(received_from_contact) <= 120)`),
  check('design_jobs_updated_fields', sql`(updated_by IS NULL) = (updated_at IS NULL)`),
]);

/** A file the client sent with the job (brief, survey, reference drawing). Named by the server; never changed or deleted. */
export const jobAttachments = design.table('job_attachments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  jobId: bigint('job_id', { mode: 'number' }).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  filePath: text('file_path').notNull(),
  fileType: text('file_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  uploadedBy: bigint('uploaded_by', { mode: 'number' }).notNull().references(() => persons.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'job_attachments_job_company_fk', columns: [t.jobId, t.legalEntityId], foreignColumns: [designJobs.id, designJobs.legalEntityId] }),
  index('idx_job_attachments_job').on(t.jobId),
  check('job_attachments_type_check', sql`file_type ~ '^[a-z0-9]{1,8}$'`),
  check('job_attachments_size_check', sql`size_bytes > 0`),
  check('job_attachments_description_length', sql`description IS NULL OR char_length(description) <= 200`),
]);

/**
 * A ticket that works on a design job (its time is the job's time). A ticket belongs to one job, once; same company
 * (both keys carry legal_entity_id). Never changed or deleted.
 */
export const jobTickets = design.table('job_tickets', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  jobId: bigint('job_id', { mode: 'number' }).notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  linkedBy: bigint('linked_by', { mode: 'number' }).notNull().references(() => persons.id),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'job_tickets_job_company_fk', columns: [t.jobId, t.legalEntityId], foreignColumns: [designJobs.id, designJobs.legalEntityId] }),
  foreignKey({ name: 'job_tickets_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  index('idx_job_tickets_job').on(t.jobId),
]);

/**
 * A drawing of a job: <job number>-<discipline>-<seq> (DJ-025-MEC-001), seq per job and discipline. Disciplines: policy
 * design.disciplines. The title changes only until a revision is submitted. Never deleted.
 */
export const drawings = design.table('drawings', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  jobId: bigint('job_id', { mode: 'number' }).notNull(),
  discipline: text('discipline').notNull(),
  seq: integer('seq').notNull(),
  number: text('number').notNull(),
  title: text('title').notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: bigint('updated_by', { mode: 'number' }).references(() => persons.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'drawings_job_company_fk', columns: [t.jobId, t.legalEntityId], foreignColumns: [designJobs.id, designJobs.legalEntityId] }),
  unique('drawings_job_discipline_seq_unique').on(t.jobId, t.discipline, t.seq),
  unique('drawings_company_number_unique').on(t.legalEntityId, t.number),
  unique('drawings_id_company_unique').on(t.id, t.legalEntityId),
  check('drawings_discipline_format', sql`discipline ~ '^[A-Z]{2,5}$'`),
  check('drawings_seq_check', sql`seq BETWEEN 1 AND 999`),
  check('drawings_title_length', sql`char_length(title) BETWEEN 2 AND 200`),
  check('drawings_updated_fields', sql`(updated_by IS NULL) = (updated_at IS NULL)`),
]);

/**
 * One revision of a drawing. Codes: A, B, C … (preliminary), 0, 1, 2 … (construction; no letters after it).
 * draft → submitted (its PDF attached) → qc_approved | changes_needed; qc_approved → issued (transmittal) → accepted |
 * returned; an issued, accepted or returned revision becomes superseded when a later one is issued. At most one draft or
 * submitted revision per drawing. Once submitted, its content and files never change (trigger). Never deleted.
 */
export const drawingRevisions = design.table('drawing_revisions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  drawingId: bigint('drawing_id', { mode: 'number' }).notNull(),
  seq: integer('seq').notNull(),
  stage: text('stage').notNull(),
  code: text('code').notNull(),
  title: text('title').notNull(),
  changeNote: text('change_note').notNull(),
  // title block
  clientProjectReference: text('client_project_reference'),
  drawnByPersonId: bigint('drawn_by_person_id', { mode: 'number' }).notNull().references(() => persons.id),
  scale: text('scale'),
  sheet: text('sheet'),
  status: text('status').notNull().default('draft'),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  submittedBy: bigint('submitted_by', { mode: 'number' }).references(() => persons.id),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'drawing_revisions_drawing_company_fk', columns: [t.drawingId, t.legalEntityId], foreignColumns: [drawings.id, drawings.legalEntityId] }),
  unique('drawing_revisions_drawing_seq_unique').on(t.drawingId, t.seq),
  unique('drawing_revisions_drawing_code_unique').on(t.drawingId, t.code),
  unique('drawing_revisions_id_company_unique').on(t.id, t.legalEntityId),
  uniqueIndex('drawing_revisions_one_open').on(t.drawingId).where(sql`status IN ('draft','submitted')`),
  index('idx_drawing_revisions_company_status').on(t.legalEntityId, t.status),
  check('drawing_revisions_seq_check', sql`seq >= 1`),
  check('drawing_revisions_stage_check', sql`stage IN ('preliminary','construction')`),
  check('drawing_revisions_code_format', sql`(stage = 'preliminary' AND code ~ '^[A-Z]{1,2}$') OR (stage = 'construction' AND code ~ '^(0|[1-9][0-9]{0,2})$')`),
  check('drawing_revisions_status_check', sql`status IN ('draft','submitted','qc_approved','changes_needed','issued','accepted','returned','superseded')`),
  check('drawing_revisions_submitted_fields', sql`(submitted_by IS NULL) = (submitted_at IS NULL) AND (status = 'draft') = (submitted_at IS NULL)`),
  check('drawing_revisions_superseded_fields', sql`(status = 'superseded') = (superseded_at IS NOT NULL)`),
  check('drawing_revisions_text_lengths', sql`char_length(title) BETWEEN 2 AND 200 AND char_length(change_note) BETWEEN 3 AND 2000
    AND (client_project_reference IS NULL OR char_length(client_project_reference) <= 200) AND (scale IS NULL OR char_length(scale) <= 30) AND (sheet IS NULL OR char_length(sheet) <= 30)`),
]);

/**
 * A file of a revision: its PDF (one; required to submit), source (CAD) files, the bill of materials. Named by the
 * server. Added or removed (removed_at) only while the revision is a draft (trigger); never deleted.
 */
export const revisionFiles = design.table('revision_files', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  revisionId: bigint('revision_id', { mode: 'number' }).notNull(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  filePath: text('file_path').notNull(),
  fileType: text('file_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  uploadedBy: bigint('uploaded_by', { mode: 'number' }).notNull().references(() => persons.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  removedBy: bigint('removed_by', { mode: 'number' }).references(() => persons.id),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'revision_files_revision_company_fk', columns: [t.revisionId, t.legalEntityId], foreignColumns: [drawingRevisions.id, drawingRevisions.legalEntityId] }),
  uniqueIndex('revision_files_one_pdf').on(t.revisionId).where(sql`kind = 'pdf' AND removed_at IS NULL`),
  index('idx_revision_files_revision').on(t.revisionId),
  check('revision_files_kind_check', sql`kind IN ('pdf','source','bom')`),
  check('revision_files_pdf_type', sql`kind <> 'pdf' OR file_type = 'pdf'`),
  check('revision_files_type_check', sql`file_type ~ '^[a-z0-9]{1,8}$'`),
  check('revision_files_size_check', sql`size_bytes > 0`),
  check('revision_files_removed_fields', sql`(removed_by IS NULL) = (removed_at IS NULL)`),
]);

/**
 * The QC decision on a submitted revision: approved or changes_needed (with comments), the checklist answered (policy
 * design.qc_checklist). The reviewer is never the revision's author (drew, created or submitted it) nor an assignee of
 * the job's tickets: checked by a trigger (migration 0055). One per revision; never changed or deleted.
 */
export const qcReviews = design.table('qc_reviews', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  revisionId: bigint('revision_id', { mode: 'number' }).notNull().unique(),
  reviewerPersonId: bigint('reviewer_person_id', { mode: 'number' }).notNull().references(() => persons.id),
  decision: text('decision').notNull(),
  comments: text('comments'),
  checklist: jsonb('checklist').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'qc_reviews_revision_company_fk', columns: [t.revisionId, t.legalEntityId], foreignColumns: [drawingRevisions.id, drawingRevisions.legalEntityId] }),
  unique('qc_reviews_id_company_unique').on(t.id, t.legalEntityId),
  check('qc_reviews_decision_check', sql`decision IN ('approved','changes_needed')`),
  check('qc_reviews_comments_check', sql`(decision = 'approved' OR comments IS NOT NULL) AND (comments IS NULL OR char_length(comments) BETWEEN 3 AND 4000)`),
  check('qc_reviews_checklist_array', sql`jsonb_typeof(checklist) = 'array'`),
]);

/** A marked-up file the QC reviewer attached to a decision (PDF, JPEG or PNG). Never changed or deleted. */
export const qcReviewFiles = design.table('qc_review_files', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  reviewId: bigint('review_id', { mode: 'number' }).notNull(),
  name: text('name').notNull(),
  filePath: text('file_path').notNull(),
  fileType: text('file_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'qc_review_files_review_company_fk', columns: [t.reviewId, t.legalEntityId], foreignColumns: [qcReviews.id, qcReviews.legalEntityId] }),
  index('idx_qc_review_files_review').on(t.reviewId),
  check('qc_review_files_type_check', sql`file_type IN ('pdf','jpg','png')`),
  check('qc_review_files_size_check', sql`size_bytes > 0`),
]);

/**
 * Revisions issued to the client together: number per company (TR-0001), purpose. The cover sheet PDF and the zip are
 * made from these rows when asked for. Never changed or deleted.
 */
export const transmittals = design.table('transmittals', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  jobId: bigint('job_id', { mode: 'number' }).notNull(),
  number: text('number').notNull(),
  purpose: text('purpose').notNull(),
  recipient: text('recipient').notNull(),
  note: text('note'),
  issuedBy: bigint('issued_by', { mode: 'number' }).notNull().references(() => persons.id),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'transmittals_job_company_fk', columns: [t.jobId, t.legalEntityId], foreignColumns: [designJobs.id, designJobs.legalEntityId] }),
  unique('transmittals_company_number_unique').on(t.legalEntityId, t.number),
  unique('transmittals_id_company_unique').on(t.id, t.legalEntityId),
  index('idx_transmittals_job').on(t.jobId),
  check('transmittals_purpose_check', sql`purpose IN ('for_approval','for_construction','for_information')`),
  check('transmittals_text_lengths', sql`char_length(recipient) BETWEEN 2 AND 200 AND (note IS NULL OR char_length(note) <= 1000)`),
]);

/** A revision issued in a transmittal; a revision is issued once. Never changed or deleted. */
export const transmittalItems = design.table('transmittal_items', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  transmittalId: bigint('transmittal_id', { mode: 'number' }).notNull(),
  revisionId: bigint('revision_id', { mode: 'number' }).notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
}, (t) => [
  foreignKey({ name: 'transmittal_items_transmittal_company_fk', columns: [t.transmittalId, t.legalEntityId], foreignColumns: [transmittals.id, transmittals.legalEntityId] }),
  foreignKey({ name: 'transmittal_items_revision_company_fk', columns: [t.revisionId, t.legalEntityId], foreignColumns: [drawingRevisions.id, drawingRevisions.legalEntityId] }),
  index('idx_transmittal_items_transmittal').on(t.transmittalId),
]);

/**
 * What the client said about an issued revision (recorded by the company): accepted, or returned with comments (the
 * drawing then needs a next revision). One per revision; never changed or deleted.
 */
export const clientResponses = design.table('client_responses', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  revisionId: bigint('revision_id', { mode: 'number' }).notNull().unique(),
  response: text('response').notNull(),
  comments: text('comments'),
  respondedOn: date('responded_on').notNull(),
  responderName: text('responder_name').notNull(),
  recordedBy: bigint('recorded_by', { mode: 'number' }).notNull().references(() => persons.id),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'client_responses_revision_company_fk', columns: [t.revisionId, t.legalEntityId], foreignColumns: [drawingRevisions.id, drawingRevisions.legalEntityId] }),
  check('client_responses_response_check', sql`response IN ('accepted','returned')`),
  check('client_responses_comments_check', sql`(response = 'accepted' OR comments IS NOT NULL) AND (comments IS NULL OR char_length(comments) BETWEEN 3 AND 4000)`),
  check('client_responses_responder_length', sql`char_length(responder_name) BETWEEN 2 AND 120`),
]);
