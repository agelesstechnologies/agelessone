import { sql } from 'drizzle-orm';
import { bigint, text, date, uuid, check, boolean, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { legalEntities, persons } from '../../core/schema';

export const employments = hrms.table('employments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  employeeCode: text('employee_code').notNull(),
  employmentType: text('employment_type').notNull(),
  joinedOn: date('joined_on').notNull(),
  exitOn: date('exit_on'),
  status: text('status').notNull().default('active'),
  isPrimary: boolean('is_primary').notNull().default(false),
  managerPersonId: bigint('manager_person_id', { mode: 'number' }).references(() => persons.id),
  department: text('department'),
  designation: text('designation'),
}, (t) => [
  check('employments_manager_not_self', sql`manager_person_id <> person_id`),
  unique('employments_company_code_unique').on(t.legalEntityId, t.employeeCode),
  uniqueIndex('uq_active_employment_per_company').on(t.personId, t.legalEntityId).where(sql`status = 'active'`),
  uniqueIndex('uq_one_primary_employment').on(t.personId).where(sql`is_primary AND status = 'active'`),
]);
// Next: job_assignments, grades, designations, person_private, bank_accounts, person_documents
