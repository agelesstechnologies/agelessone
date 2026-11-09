import { sql } from 'drizzle-orm';
import { bigint, text, date, numeric, uuid, boolean, integer, timestamp, unique, check, index, uniqueIndex, foreignKey } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { legalEntities, persons } from '../../core/schema';
import { employments } from '../people/schema';

export const leaveTypes = hrms.table('leave_types', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  policyKey: text('policy_key').notNull(),
  isPaid: boolean('is_paid').notNull().default(true),
  // inactive types (e.g. the old General leave) stay for history but can no longer be applied for
  isActive: boolean('is_active').notNull().default(true),
}, (t) => [
  unique('leave_types_tenant_code_unique').on(t.tenantId, t.code),
]);

/**
 * A leave request on one job. `days` is counted when applying (holidays and weekly offs skipped) and kept.
 * Submitted or approved requests of the same job never overlap (exclusion constraint, migration 0009).
 */
export const leaveRequests = hrms.table('leave_requests', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  leaveTypeId: bigint('leave_type_id', { mode: 'number' }).notNull().references(() => leaveTypes.id),
  fromDate: date('from_date').notNull(),
  toDate: date('to_date').notNull(),
  fromHalf: text('from_half').notNull().default('full'),
  toHalf: text('to_half').notNull().default('full'),
  days: numeric('days', { precision: 5, scale: 1 }).notNull(),
  // days beyond the balance when approved: loss of pay (the last days of the request); the rest are paid
  unpaidDays: numeric('unpaid_days', { precision: 5, scale: 1 }).notNull().default('0'),
  reason: text('reason'),
  status: text('status').notNull().default('submitted'),
  approverPersonId: bigint('approver_person_id', { mode: 'number' }).references(() => persons.id),
  decidedBy: bigint('decided_by', { mode: 'number' }).references(() => persons.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedAs: text('decided_as'), // approver | hr | management | no_approval_required (see migration 0021)
  decisionReason: text('decision_reason'),
  cancelledBy: bigint('cancelled_by', { mode: 'number' }).references(() => persons.id),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  // sent to the CEO: forwarded by an approver (escalated_by) or automatically after the waiting days (escalated_by null)
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  escalatedBy: bigint('escalated_by', { mode: 'number' }).references(() => persons.id),
  escalationReason: text('escalation_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('leave_requests_escalation_fields', sql`(escalated_at IS NULL) = (escalation_reason IS NULL) AND (escalated_by IS NULL OR escalated_at IS NOT NULL)`),
  foreignKey({ name: 'leave_requests_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  index('idx_leave_requests_employment').on(t.employmentId, t.fromDate),
  index('idx_leave_requests_approver').on(t.approverPersonId, t.status),
  check('leave_requests_status_check', sql`status IN ('draft','submitted','approved','rejected','cancelled')`),
  check('leave_requests_halves_check', sql`from_half IN ('full','second_half') AND to_half IN ('full','first_half')`),
  check('leave_requests_dates_check', sql`to_date >= from_date`),
  check('leave_requests_days_check', sql`days > 0`),
  check('leave_requests_unpaid_days_check', sql`unpaid_days >= 0 AND unpaid_days <= days`),
  check('leave_requests_not_own_decision', sql`decided_by IS NULL OR decided_by <> person_id`),
  check('leave_requests_not_own_approver', sql`approver_person_id IS NULL OR approver_person_id <> person_id`),
  check('leave_requests_decided_fields', sql`status = 'cancelled' OR (status IN ('approved','rejected')) = (decided_at IS NOT NULL AND decided_as IS NOT NULL)`),
  check('leave_requests_decided_as_check', sql`decided_as IS NULL OR decided_as IN ('approver','hr','management','no_approval_required')`),
  // a decision always has a decider, except a request that needed no approval (and that one never has one)
  check('leave_requests_decider_required', sql`decided_as IS NULL OR (decided_as = 'no_approval_required') = (decided_by IS NULL)`),
  check('leave_requests_rejected_has_reason', sql`status <> 'rejected' OR decision_reason IS NOT NULL`),
]);

/**
 * Every change to a leave balance, never edited or deleted (trigger, migration 0009). Balance = sum of `days`.
 * taken is negative (on approval); taken_reversal gives it back (approved leave cancelled).
 */
export const leaveLedger = hrms.table('leave_ledger', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  employmentId: bigint('employment_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  leaveTypeId: bigint('leave_type_id', { mode: 'number' }).notNull().references(() => leaveTypes.id),
  year: integer('year').notNull(),
  entry: text('entry').notNull(),
  days: numeric('days', { precision: 5, scale: 1 }).notNull(),
  leaveRequestId: bigint('leave_request_id', { mode: 'number' }).references(() => leaveRequests.id),
  reason: text('reason'),
  // null only for the daily job's monthly entitlement and year-end lapse
  postedBy: bigint('posted_by', { mode: 'number' }).references(() => persons.id),
  // grant: the month it is for (its 1st day); lapse: the year it ends (31 December)
  period: date('period'),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: 'leave_ledger_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  index('idx_leave_ledger_balance').on(t.employmentId, t.leaveTypeId, t.year),
  uniqueIndex('uq_leave_ledger_one_opening').on(t.employmentId, t.leaveTypeId, t.year).where(sql`entry = 'opening'`),
  uniqueIndex('uq_leave_ledger_request_entry').on(t.leaveRequestId, t.entry, t.year).where(sql`leave_request_id IS NOT NULL`),
  check('leave_ledger_entry_check', sql`entry IN ('opening','grant','taken','taken_reversal','adjustment','lapse')`),
  uniqueIndex('uq_leave_ledger_period').on(t.employmentId, t.leaveTypeId, t.entry, t.period).where(sql`period IS NOT NULL`),
  check('leave_ledger_lapse_sign', sql`entry <> 'lapse' OR days < 0`),
  check('leave_ledger_system_entries', sql`posted_by IS NOT NULL OR entry IN ('grant','lapse')`),
  check('leave_ledger_days_not_zero', sql`days <> 0`),
  check('leave_ledger_taken_sign', sql`(entry <> 'taken' OR days < 0) AND (entry <> 'taken_reversal' OR days > 0)`),
  check('leave_ledger_request_link', sql`(entry IN ('taken','taken_reversal')) = (leave_request_id IS NOT NULL)`),
  check('leave_ledger_reason_required', sql`entry NOT IN ('opening','adjustment','grant','lapse') OR reason IS NOT NULL`),
]);
