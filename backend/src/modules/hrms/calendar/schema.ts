import { sql } from 'drizzle-orm';
import { bigint, text, uuid, date, boolean, integer, jsonb, timestamp, unique, check, index, foreignKey } from 'drizzle-orm/pg-core';
import { hrms } from '../schema';
import { legalEntities, persons } from '../../core/schema';
import { employments } from '../people/schema';

/** One holiday list per company per year. */
export const holidayCalendars = hrms.table('holiday_calendars', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  year: integer('year').notNull(),
  name: text('name').notNull(),
}, (t) => [
  unique('holiday_calendars_company_year_unique').on(t.legalEntityId, t.year),
]);

/** is_optional: a restricted holiday — a working day that staff may take as leave. */
export const holidays = hrms.table('holidays', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  calendarId: bigint('calendar_id', { mode: 'number' }).notNull().references(() => holidayCalendars.id),
  date: date('date').notNull(),
  name: text('name').notNull(),
  isOptional: boolean('is_optional').notNull().default(false),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('holidays_calendar_date_unique').on(t.calendarId, t.date),
]);

/**
 * Weekly offs of a company: its default (no employment_id) or one person's override (employment_id), valid over a date range.
 * The override wins. Rules of the same company, or of the same job, never overlap (exclusion constraints, migration 0008).
 */
export const weeklyOffRules = hrms.table('weekly_off_rules', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).notNull().references(() => legalEntities.id),
  employmentId: bigint('employment_id', { mode: 'number' }), // set: one person's override (of a job in that company)
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  rule: jsonb('rule').notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_weekly_off_rules_employment').on(t.employmentId),
  foreignKey({ name: 'weekly_off_rules_employment_company_fk', columns: [t.employmentId, t.legalEntityId], foreignColumns: [employments.id, employments.legalEntityId] }),
  check('weekly_off_rules_dates', sql`valid_to IS NULL OR valid_to >= valid_from`),
  check('weekly_off_rules_rule_object', sql`jsonb_typeof(rule) = 'object'`),
]);
