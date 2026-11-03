import { sql } from 'drizzle-orm';
import { bigint, text, uuid, timestamp, numeric, integer, date, boolean, unique, check, index } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { persons } from '../../core/schema';
import { employments } from '../people/schema';

/**
 * Raw punches, never edited or deleted (append-only trigger, migration 0007). 'in' and 'out' alternate per person
 * across all their jobs, and an 'out' closes the 'in' of the same job (trigger raises HRMS_PUNCH_ORDER).
 */
export const attendanceEvents = hrms.table('attendance_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),          // made on the device: a resend is stored once
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull().references(() => employments.id),
  kind: text('kind').notNull(),
  source: text('source').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(), // when it happened (device time)
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  accuracyM: integer('accuracy_m'),
  locationStatus: text('location_status'),
}, () => [
  index('idx_att_person_time').on(sql`person_id`, sql`occurred_at`),
  index('idx_att_employment_time').on(sql`employment_id`, sql`occurred_at`),
  check('attendance_events_kind_check', sql`kind IN ('in','out')`),
  check('attendance_events_source_check', sql`source IN ('app','web','supervisor','park_counter','gate','correction')`),
  check('attendance_events_location_status_check', sql`location_status IS NULL OR location_status IN ('inside','outside','poor_accuracy','not_configured','not_taken')`),
  check('attendance_events_lat_lng_together', sql`(latitude IS NULL) = (longitude IS NULL)`),
  check('attendance_events_accuracy_check', sql`accuracy_m IS NULL OR accuracy_m >= 0`),
]);

/** One calculated row per job per date (IST), rebuilt from punches. A locked day never changes (trigger). */
export const workDays = hrms.table('work_days', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull().references(() => employments.id),
  workDate: date('work_date').notNull(),
  firstIn: timestamp('first_in', { withTimezone: true }),
  lastOut: timestamp('last_out', { withTimezone: true }),
  workedMinutes: integer('worked_minutes').notNull().default(0),
  overtimeMinutes: integer('overtime_minutes').notNull().default(0),
  dayStatus: text('day_status').notNull(),
  lockedForPayroll: boolean('locked_for_payroll').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('work_days_employment_date_unique').on(t.employmentId, t.workDate),
  index('idx_work_days_person_date').on(t.personId, t.workDate),
  check('work_days_status_check', sql`day_status IN ('present','half_day','absent','leave','holiday','weekly_off','missed_punch')`),
  check('work_days_minutes_check', sql`worked_minutes BETWEEN 0 AND 1440 AND overtime_minutes >= 0 AND overtime_minutes <= worked_minutes`),
]);
// Next: attendance_corrections, overtime_requests, shifts, shift_assignments
