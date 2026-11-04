import { sql } from 'drizzle-orm';
import { bigint, text, uuid, timestamp, numeric, integer, date, boolean, unique, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { legalEntities, persons } from '../../core/schema';
import { employments } from '../people/schema';
import { tickets } from '../../tickets/schema';

/**
 * Raw punches, never edited or deleted (append-only trigger, migration 0007). 'in' and 'out' alternate per person
 * across all their jobs, and an 'out' closes the 'in' of the same job (trigger raises HRMS_PUNCH_ORDER).
 * source 'correction': added by an approved correction; 'auto': a forgotten punch-out closed by the system.
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
  correctionId: bigint('correction_id', { mode: 'number' }).references(() => attendanceCorrections.id), // set on source 'correction'
}, () => [
  index('idx_att_person_time').on(sql`person_id`, sql`occurred_at`),
  index('idx_att_employment_time').on(sql`employment_id`, sql`occurred_at`),
  check('attendance_events_kind_check', sql`kind IN ('in','out')`),
  check('attendance_events_source_check', sql`source IN ('app','web','supervisor','park_counter','gate','correction','auto')`),
  check('attendance_events_location_status_check', sql`location_status IS NULL OR location_status IN ('inside','outside','poor_accuracy','not_configured','not_taken')`),
  check('attendance_events_lat_lng_together', sql`(latitude IS NULL) = (longitude IS NULL)`),
  check('attendance_events_accuracy_check', sql`accuracy_m IS NULL OR accuracy_m >= 0`),
  check('attendance_events_correction_link', sql`(source = 'correction') = (correction_id IS NOT NULL)`),
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
  extraMinutes: integer('extra_minutes').notNull().default(0),                       // worked beyond the full-day setting
  approvedOvertimeMinutes: integer('approved_overtime_minutes').notNull().default(0), // approved requests, at most extra_minutes
  dayStatus: text('day_status').notNull(),
  leaveDays: numeric('leave_days', { precision: 2, scale: 1 }).notNull().default('0'),   // 0, 0.5 or 1
  absentDays: numeric('absent_days', { precision: 2, scale: 1 }).notNull().default('0'), // 0, 0.5 or 1
  workedOnLeave: boolean('worked_on_leave').notNull().default(false),
  lockedForPayroll: boolean('locked_for_payroll').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('work_days_employment_date_unique').on(t.employmentId, t.workDate),
  index('idx_work_days_person_date').on(t.personId, t.workDate),
  check('work_days_status_check', sql`day_status IN ('present','half_day','absent','leave','holiday','weekly_off','missed_punch')`),
  check('work_days_leave_absent_check', sql`leave_days IN (0, 0.5, 1) AND absent_days IN (0, 0.5, 1) AND leave_days + absent_days <= 1`),
  check('work_days_minutes_check', sql`worked_minutes BETWEEN 0 AND 1440`),
  check('work_days_extra_check', sql`extra_minutes BETWEEN 0 AND worked_minutes AND approved_overtime_minutes BETWEEN 0 AND extra_minutes`),
]);
/**
 * A request to fix one job's day: add the missing or right punch times, and leave out wrong punches. Approval adds
 * punches (source 'correction') and exclusions; the original punches stay. One open (submitted) correction per job and date.
 */
export const attendanceCorrections = hrms.table('attendance_corrections', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull().references(() => employments.id),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  workDate: date('work_date').notNull(),
  kind: text('kind').notNull(),
  requestedIn: timestamp('requested_in', { withTimezone: true }),
  requestedOut: timestamp('requested_out', { withTimezone: true }),
  punchIdsToExclude: uuid('punch_ids_to_exclude').array().notNull().default(sql`'{}'`), // public ids of the job's punches that day
  reason: text('reason').notNull(),
  status: text('status').notNull().default('submitted'),
  requestedBy: bigint('requested_by', { mode: 'number' }).notNull().references(() => persons.id),
  approverPersonId: bigint('approver_person_id', { mode: 'number' }).references(() => persons.id),
  decidedBy: bigint('decided_by', { mode: 'number' }).references(() => persons.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  cancelledBy: bigint('cancelled_by', { mode: 'number' }).references(() => persons.id),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_correction_open_per_day').on(t.employmentId, t.workDate).where(sql`status = 'submitted'`),
  index('idx_corrections_approver').on(t.approverPersonId, t.status),
  check('attendance_corrections_kind_check', sql`kind IN ('missed_out','missed_in','wrong_time','other')`),
  check('attendance_corrections_status_check', sql`status IN ('submitted','approved','rejected','cancelled')`),
  check('attendance_corrections_reason_length', sql`char_length(reason) >= 10`),
  check('attendance_corrections_times_order', sql`requested_in IS NULL OR requested_out IS NULL OR requested_in < requested_out`),
  check('attendance_corrections_not_own_decision', sql`decided_by IS NULL OR (decided_by <> person_id AND decided_by <> requested_by)`),
  check('attendance_corrections_not_own_approver', sql`approver_person_id IS NULL OR (approver_person_id <> person_id AND approver_person_id <> requested_by)`),
  check('attendance_corrections_rejected_has_reason', sql`status <> 'rejected' OR decision_reason IS NOT NULL`),
]);

/** Punches left out of the work day by an approved correction. Never edited or deleted (trigger, migration 0011). */
export const attendanceExclusions = hrms.table('attendance_exclusions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  punchId: bigint('punch_id', { mode: 'number' }).notNull().unique().references(() => attendanceEvents.id),
  correctionId: bigint('correction_id', { mode: 'number' }).notNull().references(() => attendanceCorrections.id),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
/**
 * A request to pay extra time on one job's day as overtime. Asked by the person or their manager; planned overtime
 * (a future date) is allowed. Approved minutes count on the day up to its extra minutes (applied when the day is built).
 */
export const overtimeRequests = hrms.table('overtime_requests', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull().references(() => employments.id),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  workDate: date('work_date').notNull(),
  minutes: integer('minutes').notNull(),
  reason: text('reason').notNull(),
  ticketId: bigint('ticket_id', { mode: 'number' }).references(() => tickets.id),
  status: text('status').notNull().default('submitted'),
  requestedBy: bigint('requested_by', { mode: 'number' }).notNull().references(() => persons.id),
  approverPersonId: bigint('approver_person_id', { mode: 'number' }).references(() => persons.id),
  decidedBy: bigint('decided_by', { mode: 'number' }).references(() => persons.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  cancelledBy: bigint('cancelled_by', { mode: 'number' }).references(() => persons.id),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_overtime_employment_date').on(t.employmentId, t.workDate),
  index('idx_overtime_approver').on(t.approverPersonId, t.status),
  check('overtime_requests_status_check', sql`status IN ('submitted','approved','rejected','cancelled')`),
  check('overtime_requests_minutes_check', sql`minutes BETWEEN 1 AND 1440`),
  check('overtime_requests_reason_length', sql`char_length(reason) >= 3`),
  check('overtime_requests_not_own_decision', sql`decided_by IS NULL OR (decided_by <> person_id AND decided_by <> requested_by)`),
  check('overtime_requests_not_own_approver', sql`approver_person_id IS NULL OR (approver_person_id <> person_id AND approver_person_id <> requested_by)`),
  check('overtime_requests_rejected_has_reason', sql`status <> 'rejected' OR decision_reason IS NOT NULL`),
]);
// Next: shifts, shift_assignments
