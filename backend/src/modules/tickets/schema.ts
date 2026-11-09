import { sql } from 'drizzle-orm';
import { pgSchema, bigint, boolean, check, date, foreignKey, index, integer, jsonb, smallint, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { legalEntities, persons, places } from '../core/schema';
import { departments, employments } from '../hrms/people/schema';
import { skills } from '../hrms/skills/schema';
export const ticketsSchema = pgSchema('tickets');

/**
 * A kind of ticket a company works with. One row per saved VERSION: `public_id` is the type's id (the same on every
 * version), (public_id, version) is unique, and exactly one version is current. Editing adds a row; old versions stay
 * (a trigger in migration 0022 refuses deletes and any change but active / is_current). Types are deactivated, never deleted.
 * `active` is kept on the current version only. Name and code are unique per company among current versions.
 */
export const ticketTypes = ticketsSchema.table('ticket_types', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom(),
  version: integer('version').notNull().default(1),
  isCurrent: boolean('is_current').notNull().default(true),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** null: company-wide (managed by admin and Management only) */
  ownerDepartmentId: bigint('owner_department_id', { mode: 'number' }),
  isStandard: boolean('is_standard').notNull().default(false),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(100),
  fields: jsonb('fields').notNull().default(sql`'[]'::jsonb`),
  completionRules: jsonb('completion_rules').notNull().default(sql`'{}'::jsonb`),
  checklistItems: jsonb('checklist_items').notNull().default(sql`'[]'::jsonb`),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_types_department_company_fk', columns: [t.ownerDepartmentId, t.legalEntityId], foreignColumns: [departments.id, departments.legalEntityId] }),
  unique('ticket_types_id_company_unique').on(t.id, t.legalEntityId),
  unique('ticket_types_public_version_unique').on(t.publicId, t.version),
  unique('ticket_types_id_version_company_unique').on(t.id, t.version, t.legalEntityId), // a ticket's type version, same company
  uniqueIndex('ticket_types_one_current').on(t.publicId).where(sql`is_current`),
  uniqueIndex('ticket_types_company_name_unique').on(t.legalEntityId, sql`lower(${t.name})`).where(sql`is_current`),
  uniqueIndex('ticket_types_company_code_unique').on(t.legalEntityId, t.code).where(sql`is_current`),
  check('ticket_types_version_check', sql`version >= 1`),
  check('ticket_types_code_format', sql`code ~ '^[a-z][a-z0-9_]{1,39}$'`),
  check('ticket_types_json_shapes', sql`jsonb_typeof(fields) = 'array' AND jsonb_typeof(completion_rules) = 'object' AND jsonb_typeof(checklist_items) = 'array'`),
]);

/** A company's ticket numbers: PREFIX-0001 … HR sets the prefix and the next number (e.g. after importing Froid tickets). */
export const numberSeries = ticketsSchema.table('number_series', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id).unique(),
  prefix: text('prefix').notNull(),
  nextNumber: integer('next_number').notNull().default(1),
  updatedBy: bigint('updated_by', { mode: 'number' }).references(() => persons.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, () => [
  check('number_series_prefix_format', sql`prefix ~ '^[A-Z0-9]{1,10}$'`),
  check('number_series_next_positive', sql`next_number >= 1`),
]);

/**
 * A piece of work. Uses one saved version of its type (type_id is that version's row), so later edits of the type never
 * change it. Never deleted: cancelled instead. Every change also writes a ticket_event.
 */
export const tickets = ticketsSchema.table('tickets', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  number: text('number').notNull(),
  typeId: bigint('type_id', { mode: 'number' }).notNull(),
  typeVersion: integer('type_version').notNull(),
  typeDetails: jsonb('type_details').notNull().default(sql`'{}'::jsonb`),
  title: text('title').notNull(),
  description: text('description'),
  priority: smallint('priority').notNull().default(3),
  /** the customer's public id; its foreign key comes with the customer register (Sales) */
  customerId: uuid('customer_id'),
  site: text('site'),
  /** projects come later */
  projectId: bigint('project_id', { mode: 'number' }),
  departmentId: bigint('department_id', { mode: 'number' }).notNull(),
  supervisorPersonId: bigint('supervisor_person_id', { mode: 'number' }).notNull().references(() => persons.id),
  requiredSkillId: bigint('required_skill_id', { mode: 'number' }),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  dueDate: date('due_date'),
  status: text('status').notNull().default('open'),
  holdReason: text('hold_reason'),
  cancelReason: text('cancel_reason'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  headApprovedBy: bigint('head_approved_by', { mode: 'number' }).references(() => persons.id),
  headApprovedAt: timestamp('head_approved_at', { withTimezone: true }),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'tickets_type_version_company_fk', columns: [t.typeId, t.typeVersion, t.legalEntityId],
    foreignColumns: [ticketTypes.id, ticketTypes.version, ticketTypes.legalEntityId] }),
  foreignKey({ name: 'tickets_department_company_fk', columns: [t.departmentId, t.legalEntityId], foreignColumns: [departments.id, departments.legalEntityId] }),
  foreignKey({ name: 'tickets_skill_company_fk', columns: [t.requiredSkillId, t.legalEntityId], foreignColumns: [skills.id, skills.legalEntityId] }),
  unique('tickets_company_number_unique').on(t.legalEntityId, t.number),
  unique('tickets_id_company_unique').on(t.id, t.legalEntityId),
  index('idx_tickets_company_status').on(t.legalEntityId, t.status),
  index('idx_tickets_department').on(t.departmentId),
  check('tickets_status_check', sql`status IN ('open','assigned','in_progress','on_hold','completed','cancelled')`),
  check('tickets_priority_check', sql`priority BETWEEN 1 AND 5`),
  check('tickets_description_length', sql`description IS NULL OR length(description) <= 1000`),
  check('tickets_details_object', sql`jsonb_typeof(type_details) = 'object'`),
  check('tickets_hold_has_reason', sql`status <> 'on_hold' OR hold_reason IS NOT NULL`),
  check('tickets_cancel_has_reason', sql`status <> 'cancelled' OR cancel_reason IS NOT NULL`),
  check('tickets_completed_fields', sql`(status = 'completed') = (completed_at IS NOT NULL)`),
  check('tickets_head_approval_fields', sql`(head_approved_by IS NULL) = (head_approved_at IS NULL)`),
]);

/**
 * Who works on a ticket. Taking someone off sets ended_at (never deleted). Among the current assignees exactly one is
 * primary (unique index + a deferred check in migration 0023).
 */
export const ticketAssignees = ticketsSchema.table('ticket_assignees', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  isPrimary: boolean('is_primary').notNull().default(false),
  assignedBy: bigint('assigned_by', { mode: 'number' }).notNull().references(() => persons.id),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  endedBy: bigint('ended_by', { mode: 'number' }).references(() => persons.id),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ name: 'ticket_assignees_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'ticket_assignees_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  uniqueIndex('ticket_assignees_one_current').on(t.ticketId, t.employmentId).where(sql`ended_at IS NULL`),
  uniqueIndex('ticket_assignees_one_primary').on(t.ticketId).where(sql`is_primary AND ended_at IS NULL`),
  index('idx_ticket_assignees_employment').on(t.employmentId),
  check('ticket_assignees_ended_fields', sql`(ended_by IS NULL) = (ended_at IS NULL)`),
]);

/** A checklist answer. Append-only: answering again adds a row; the newest per item counts. */
export const ticketChecklistResults = ticketsSchema.table('ticket_checklist_results', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  item: text('item').notNull(),
  result: text('result').notNull(),
  note: text('note'),
  checkedBy: bigint('checked_by', { mode: 'number' }).notNull().references(() => persons.id),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_checklist_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  index('idx_ticket_checklist_ticket').on(t.ticketId),
  check('ticket_checklist_result_check', sql`result IN ('pass','fail','na')`),
]);

/** One person's daily update on a ticket: note and percent complete (photos / files are attachments pointing at it). Append-only. */
export const ticketDailyUpdates = ticketsSchema.table('ticket_daily_updates', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  workDate: date('work_date').notNull(),
  note: text('note').notNull(),
  percentComplete: smallint('percent_complete').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_daily_updates_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'ticket_daily_updates_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  unique('ticket_daily_updates_one_per_day').on(t.ticketId, t.employmentId, t.workDate),
  unique('ticket_daily_updates_id_ticket_unique').on(t.id, t.ticketId),
  index('idx_ticket_daily_updates_date').on(t.workDate),
  check('ticket_daily_updates_percent_check', sql`percent_complete BETWEEN 0 AND 100`),
  check('ticket_daily_updates_note_length', sql`length(note) BETWEEN 1 AND 1000`),
]);

/**
 * A photo, file or signed sheet on a ticket. The file lives under uploads/; only its relative path is stored. Append-only.
 * daily_update_id: sent with that daily update (same ticket).
 */
export const ticketAttachments = ticketsSchema.table('ticket_attachments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  kind: text('kind').notNull(),
  filePath: text('file_path').notNull(),
  fileType: text('file_type').notNull(),
  dailyUpdateId: bigint('daily_update_id', { mode: 'number' }),
  uploadedBy: bigint('uploaded_by', { mode: 'number' }).notNull().references(() => persons.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_attachments_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'ticket_attachments_daily_update_fk', columns: [t.dailyUpdateId, t.ticketId], foreignColumns: [ticketDailyUpdates.id, ticketDailyUpdates.ticketId] }),
  unique('ticket_attachments_id_ticket_unique').on(t.id, t.ticketId),
  index('idx_ticket_attachments_ticket').on(t.ticketId),
  check('ticket_attachments_kind_check', sql`kind IN ('photo','file','signoff')`),
  check('ticket_attachments_type_check', sql`file_type IN ('jpg','png','pdf')`),
]);

/** The customer's sign-off: who signed, and the photo of the signed sheet (an attachment of the same ticket). Append-only. */
export const ticketSignoffs = ticketsSchema.table('ticket_signoffs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  signerName: text('signer_name').notNull(),
  signerRole: text('signer_role'),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
  photoAttachmentId: bigint('photo_attachment_id', { mode: 'number' }).notNull(),
  recordedBy: bigint('recorded_by', { mode: 'number' }).notNull().references(() => persons.id),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_signoffs_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'ticket_signoffs_photo_same_ticket_fk', columns: [t.photoAttachmentId, t.ticketId], foreignColumns: [ticketAttachments.id, ticketAttachments.ticketId] }),
]);

/** from_ticket follows / is rework of to_ticket. Both of the same company (both keys carry legal_entity_id). Append-only. */
export const ticketLinks = ticketsSchema.table('ticket_links', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  fromTicketId: bigint('from_ticket_id', { mode: 'number' }).notNull(),
  toTicketId: bigint('to_ticket_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  kind: text('kind').notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_links_from_company_fk', columns: [t.fromTicketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'ticket_links_to_company_fk', columns: [t.toTicketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  unique('ticket_links_unique').on(t.fromTicketId, t.toTicketId, t.kind),
  index('idx_ticket_links_to').on(t.toTicketId),
  check('ticket_links_kind_check', sql`kind IN ('follows','rework_of')`),
  check('ticket_links_not_self', sql`from_ticket_id <> to_ticket_id`),
]);

/** The ticket's timeline. Append-only (trigger). actor null: the system. */
export const ticketEvents = ticketsSchema.table('ticket_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  actorPersonId: bigint('actor_person_id', { mode: 'number' }).references(() => persons.id),
  action: text('action').notNull(),
  details: jsonb('details'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_events_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  index('idx_ticket_events_ticket').on(t.ticketId, t.id),
]);

/**
 * An assignee asks to be taken off a ticket; the approver (the ticket's supervisor, or the next approver when the
 * supervisor is the one asking) picks who takes over. Never decided by the person who asked.
 */
export const reassignRequests = ticketsSchema.table('reassign_requests', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  fromEmploymentId: bigint('from_employment_id', { mode: 'number' }).notNull(),
  requestedBy: bigint('requested_by', { mode: 'number' }).notNull().references(() => persons.id),
  reason: text('reason').notNull(),
  approverPersonId: bigint('approver_person_id', { mode: 'number' }).references(() => persons.id),
  status: text('status').notNull().default('pending'),
  newEmploymentId: bigint('new_employment_id', { mode: 'number' }),
  decidedBy: bigint('decided_by', { mode: 'number' }).references(() => persons.id),
  decidedAs: text('decided_as'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'reassign_requests_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'reassign_requests_from_company_fk', columns: [t.fromEmploymentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  foreignKey({ name: 'reassign_requests_new_company_fk', columns: [t.newEmploymentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  uniqueIndex('reassign_requests_one_pending').on(t.ticketId, t.fromEmploymentId).where(sql`status = 'pending'`),
  index('idx_reassign_requests_approver').on(t.approverPersonId, t.status),
  check('reassign_requests_status_check', sql`status IN ('pending','approved','rejected')`),
  check('reassign_requests_not_own_decision', sql`decided_by IS NULL OR decided_by <> requested_by`),
  check('reassign_requests_not_own_approver', sql`approver_person_id IS NULL OR approver_person_id <> requested_by`),
  check('reassign_requests_decided_fields', sql`(status = 'pending') = (decided_at IS NULL AND decided_by IS NULL AND decided_as IS NULL)`),
  check('reassign_requests_approved_has_person', sql`status <> 'approved' OR new_employment_id IS NOT NULL`),
  check('reassign_requests_rejected_has_reason', sql`status <> 'rejected' OR decision_reason IS NOT NULL`),
  check('reassign_requests_decided_as_check', sql`decided_as IS NULL OR decided_as IN ('approver','management')`),
]);

/**
 * Ticket punch: time a person (on one of their jobs) works on a ticket. Several may run at once. Append-only, except
 * that an open log is closed once (ended_at, end_reason): manual (ticket punch-out), day_punch_out (the daily
 * punch-out stopped it) or unfinished (the daily punch-in became a missed punch; counts no time). Trigger: migration 0024.
 */
export const ticketTimelogs = ticketsSchema.table('ticket_timelogs', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endReason: text('end_reason'),
  /** where the ticket punch-in was made (address looked up by core) */
  placeId: bigint('place_id', { mode: 'number' }).references(() => places.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_timelogs_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'ticket_timelogs_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  uniqueIndex('ticket_timelogs_one_running').on(t.ticketId, t.employmentId).where(sql`ended_at IS NULL`),
  index('idx_ticket_timelogs_employment').on(t.employmentId, t.startedAt),
  check('ticket_timelogs_end_reason_check', sql`end_reason IS NULL OR end_reason IN ('manual','day_punch_out','unfinished')`),
  check('ticket_timelogs_end_fields', sql`(ended_at IS NULL) = (end_reason IS NULL)`),
  check('ticket_timelogs_end_after_start', sql`ended_at IS NULL OR ended_at >= started_at`),
]);

/**
 * A person's calculated time on a ticket for one work day (IST date), in minutes: recalculated from the timelogs and the
 * attended periods whenever either changes (policy tickets.time.split). Never more than the day's attendance in total.
 */
export const ticketTimeAllocations = ticketsSchema.table('ticket_time_allocations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  workDate: date('work_date').notNull(),
  minutes: integer('minutes').notNull(),
  calculatedAt: timestamp('calculated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_time_allocations_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'ticket_time_allocations_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  unique('ticket_time_allocations_unique').on(t.ticketId, t.employmentId, t.workDate),
  index('idx_ticket_time_allocations_person_date').on(t.personId, t.workDate),
  check('ticket_time_allocations_minutes_check', sql`minutes >= 0`),
]);

/**
 * A reviewer's change to a person's daily ticket time (+ or - minutes on one ticket), with a reason. The calculated
 * allocation and the timelogs never change; the day's time is allocation + adjustments. Rows sent together share
 * batch_id. Never by the person whose time it is. Append-only.
 */
export const ticketTimeAdjustments = ticketsSchema.table('ticket_time_adjustments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  batchId: uuid('batch_id').notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  workDate: date('work_date').notNull(),
  minutes: integer('minutes').notNull(),
  reason: text('reason').notNull(),
  adjustedBy: bigint('adjusted_by', { mode: 'number' }).notNull().references(() => persons.id),
  adjustedAs: text('adjusted_as').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_time_adjustments_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  foreignKey({ name: 'ticket_time_adjustments_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  unique('ticket_time_adjustments_batch_ticket_unique').on(t.batchId, t.ticketId),
  index('idx_ticket_time_adjustments_person_date').on(t.personId, t.workDate),
  check('ticket_time_adjustments_minutes_check', sql`minutes <> 0`),
  check('ticket_time_adjustments_reason_check', sql`length(trim(reason)) >= 3`),
  check('ticket_time_adjustments_not_own', sql`adjusted_by <> person_id`),
  check('ticket_time_adjustments_as_check', sql`adjusted_as IN ('head','management')`),
]);

/**
 * Outside workers on a ticket (contractor labour, agency staff): who, how to reach them, where from, their trade, the
 * days on site and a photo. Added by the ticket's on-site supervisor, a manager or the department head.
 */
export const ticketExternalStaff = ticketsSchema.table('ticket_external_staff', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  agency: text('agency'),
  trade: text('trade'),
  fromDate: date('from_date').notNull(),
  toDate: date('to_date'),
  photoPath: text('photo_path'),
  photoType: text('photo_type'),
  addedBy: bigint('added_by', { mode: 'number' }).notNull().references(() => persons.id),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'ticket_external_staff_ticket_company_fk', columns: [t.ticketId, t.legalEntityId], foreignColumns: [tickets.id, tickets.legalEntityId] }),
  index('idx_ticket_external_staff_ticket').on(t.ticketId),
  check('ticket_external_staff_dates_check', sql`to_date IS NULL OR to_date >= from_date`),
  check('ticket_external_staff_name_check', sql`char_length(name) BETWEEN 2 AND 100`),
  check('ticket_external_staff_photo_check', sql`(photo_path IS NULL) = (photo_type IS NULL) AND (photo_type IS NULL OR photo_type IN ('jpg','png'))`),
]);
