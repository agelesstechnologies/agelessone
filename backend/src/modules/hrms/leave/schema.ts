import { bigint, text, date, numeric, uuid } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { persons } from '../../core/schema';

export const leaveTypes = hrms.table('leave_types', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  policyKey: text('policy_key').notNull(),
});
export const leaveRequests = hrms.table('leave_requests', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  leaveTypeId: bigint('leave_type_id', { mode: 'number' }).notNull().references(() => leaveTypes.id),
  fromDate: date('from_date').notNull(),
  toDate: date('to_date').notNull(),
  days: numeric('days', { precision: 5, scale: 1 }).notNull(),
  status: text('status').notNull().default('pending'),
});
// Next: leave_ledger, holiday_calendars, holidays (overlap rule added in a custom SQL migration)
