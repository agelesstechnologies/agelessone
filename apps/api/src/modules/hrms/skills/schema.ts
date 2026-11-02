import { bigint, text, date } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { persons } from '../../core/schema';

export const skills = hrms.table('skills', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
});
export const certificates = hrms.table('certificates', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  name: text('name').notNull(),
  expiresOn: date('expires_on'),
  status: text('status').notNull().default('review'),
});
// Next: person_skills, training_records
