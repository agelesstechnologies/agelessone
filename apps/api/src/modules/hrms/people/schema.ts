import { bigint, text, date, uuid } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { persons } from '../../core/schema';

export const employments = hrms.table('employments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  employeeCode: text('employee_code').notNull(),
  employmentType: text('employment_type').notNull(),
  joinedOn: date('joined_on').notNull(),
  exitOn: date('exit_on'),
  status: text('status').notNull().default('active'),
});
// Next: job_assignments, grades, designations, person_private, bank_accounts, person_documents
