import { sql } from 'drizzle-orm';
import { bigint, text, date, uuid, check, boolean, unique, uniqueIndex, timestamp, foreignKey, index } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { legalEntities, persons } from '../../core/schema';

/** A company's departments. code_prefix starts its employee codes (ATS → ATS001, ATS002 ...). */
export const departments = hrms.table('departments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  name: text('name').notNull(),
  codePrefix: text('code_prefix').notNull(),
  headPersonId: bigint('head_person_id', { mode: 'number' }).references(() => persons.id),
}, (t) => [
  unique('departments_company_prefix_unique').on(t.legalEntityId, t.codePrefix),
  unique('departments_company_name_unique').on(t.legalEntityId, t.name),
  unique('departments_id_company_unique').on(t.id, t.legalEntityId),
  check('departments_prefix_format', sql`code_prefix ~ '^[A-Z]{2,6}$'`),
]);

/** Job titles a company uses (for positions; an employment's designation stays free text). */
export const designations = hrms.table('designations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  name: text('name').notNull(),
}, (t) => [
  unique('designations_company_name_unique').on(t.legalEntityId, t.name),
  unique('designations_id_company_unique').on(t.id, t.legalEntityId),
]);

/**
 * A person's job in one company. joining (offer accepted, not started) → active → (notice) → exited.
 * The employee code never changes, even when the department does.
 */
export const employments = hrms.table('employments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  employeeCode: text('employee_code').notNull(),
  employmentType: text('employment_type').notNull(),
  recruitedOn: date('recruited_on'),
  joinedOn: date('joined_on').notNull(),
  exitOn: date('exit_on'),
  exitReason: text('exit_reason'),
  status: text('status').notNull().default('active'),
  isPrimary: boolean('is_primary').notNull().default(false),
  managerPersonId: bigint('manager_person_id', { mode: 'number' }).references(() => persons.id),
  departmentId: bigint('department_id', { mode: 'number' }),
  designation: text('designation'),
  offerLetterPath: text('offer_letter_path'),              // relative to the uploads folder
  offerLetterType: text('offer_letter_type'),              // pdf, jpg or png
}, (t) => [
  foreignKey({ name: 'employments_department_company_fk', columns: [t.departmentId, t.legalEntityId], foreignColumns: [departments.id, departments.legalEntityId] }),
  check('employments_manager_not_self', sql`manager_person_id <> person_id`),
  check('employments_exit_after_join', sql`exit_on IS NULL OR exit_on >= joined_on`),
  check('employments_exited_has_date_and_reason', sql`status <> 'exited' OR (exit_on IS NOT NULL AND exit_reason IS NOT NULL)`),
  check('employments_status_check', sql`status IN ('joining','active','notice','exited')`),
  check('employments_recruited_before_join', sql`recruited_on IS NULL OR recruited_on <= joined_on`),
  unique('employments_company_code_unique').on(t.legalEntityId, t.employeeCode),
  uniqueIndex('uq_active_employment_per_company').on(t.personId, t.legalEntityId).where(sql`status IN ('joining','active','notice')`),
  unique('employments_id_company_unique').on(t.id, t.legalEntityId), // target of the company-safe foreign keys
  uniqueIndex('uq_one_primary_employment').on(t.personId).where(sql`is_primary AND status = 'active'`),
]);

/** A planned or open job in a department; filled by the employment of the person hired. */
export const positions = hrms.table('positions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  departmentId: bigint('department_id', { mode: 'number' }).notNull(),
  designationId: bigint('designation_id', { mode: 'number' }).notNull(),
  status: text('status').notNull().default('planned'),
  notes: text('notes'),
  filledByEmploymentId: bigint('filled_by_employment_id', { mode: 'number' }),
  filledAt: timestamp('filled_at', { withTimezone: true }),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'positions_department_company_fk', columns: [t.departmentId, t.legalEntityId], foreignColumns: [departments.id, departments.legalEntityId] }),
  foreignKey({ name: 'positions_designation_company_fk', columns: [t.designationId, t.legalEntityId], foreignColumns: [designations.id, designations.legalEntityId] }),
  foreignKey({ name: 'positions_employment_company_fk', columns: [t.filledByEmploymentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  index('idx_positions_company_status').on(t.legalEntityId, t.status),
  check('positions_status_check', sql`status IN ('planned','open','filled')`),
  check('positions_filled_has_employment', sql`(status = 'filled') = (filled_by_employment_id IS NOT NULL)`),
]);
// Next: job_assignments, grades, person_private, bank_accounts, person_documents

/**
 * A person's private details. Returned masked; shown in full only by a reveal, which is audited. Never logged.
 */
export const personPrivate = hrms.table('person_private', {
  personId: bigint('person_id', { mode: 'number' }).primaryKey().references(() => persons.id),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  aadhaar: text('aadhaar'),
  pan: text('pan'),
  updatedBy: bigint('updated_by', { mode: 'number' }).notNull().references(() => persons.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, () => [
  check('person_private_aadhaar_format', sql`aadhaar IS NULL OR aadhaar ~ '^[0-9]{12}$'`),
  check('person_private_pan_format', sql`pan IS NULL OR pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'`),
]);

/**
 * Letter templates, one per company and kind (today only 'joining'). HR or Management edits the text; placeholders such
 * as {{name}} and {{joiningDate}} are filled from the person's job when a letter is prepared.
 */
export const letterTemplates = hrms.table('letter_templates', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  updatedBy: bigint('updated_by', { mode: 'number' }).notNull().references(() => persons.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('letter_templates_company_kind_unique').on(t.legalEntityId, t.kind),
  check('letter_templates_kind_check', sql`kind IN ('joining')`),
  check('letter_templates_text_check', sql`char_length(title) BETWEEN 1 AND 200 AND char_length(body) BETWEEN 1 AND 20000`),
]);

/** A letter issued for one job: the exact text as downloaded, who issued it and when. Kept, never changed. */
export const issuedLetters = hrms.table('issued_letters', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  issuedBy: bigint('issued_by', { mode: 'number' }).notNull().references(() => persons.id),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'issued_letters_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  index('idx_issued_letters_employment').on(t.employmentId, t.issuedAt),
  check('issued_letters_kind_check', sql`kind IN ('joining')`),
  check('issued_letters_text_check', sql`char_length(title) BETWEEN 1 AND 200 AND char_length(body) BETWEEN 1 AND 20000`),
]);
