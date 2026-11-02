import { bigint, text, uuid, timestamp, numeric, integer, date, boolean, unique } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { persons } from '../../core/schema';

/** Raw punches, never edited (append-only trigger added in a custom SQL migration). */
export const attendanceEvents = hrms.table('attendance_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  kind: text('kind').notNull(),
  source: text('source').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  accuracyM: integer('accuracy_m'),
  locationStatus: text('location_status'),
});

export const workDays = hrms.table('work_days', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  workDate: date('work_date').notNull(),
  workedMinutes: integer('worked_minutes').notNull().default(0),
  overtimeMinutes: integer('overtime_minutes').notNull().default(0),
  dayStatus: text('day_status').notNull(),
  lockedForPayroll: boolean('locked_for_payroll').notNull().default(false),
}, (t) => [unique().on(t.personId, t.workDate)]);
// Next: attendance_corrections, overtime_requests, shifts, shift_assignments
