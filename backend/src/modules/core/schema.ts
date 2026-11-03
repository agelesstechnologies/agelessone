import { sql } from 'drizzle-orm';
import { pgSchema, bigint, text, uuid, timestamp, boolean, varchar, check, unique, index, uniqueIndex, date, primaryKey } from 'drizzle-orm/pg-core';
export const core = pgSchema('core');

/** One row per company group using the platform. Full Core tables: see docs/reference/ageless_core_tickets_hrms.sql */
export const tenants = core.table('tenants', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The registered companies inside a tenant (AE, ATPL ...). */
export const legalEntities = core.table('legal_entities', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  code: varchar('code', { length: 12 }).notNull(),
  name: text('name').notNull(),
  legalForm: text('legal_form').notNull(),
  pan: varchar('pan', { length: 10 }),
}, (t) => [
  unique().on(t.tenantId, t.code),
  check('legal_entities_legal_form_check', sql`${t.legalForm} IN ('partnership','private_limited','llp','proprietorship','other')`),
]);

/** One record per human, shared by every module. */
export const persons = core.table('persons', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personType: text('person_type').notNull(),
  displayName: text('display_name').notNull(),
  fullName: text('full_name').notNull(),
  mobile: text('mobile'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Phone numbers and emails of a person. Old ones are ended, not deleted. The same number may belong to several people. */
export const personContacts = core.table('person_contacts', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  label: text('label'),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => [
  index('idx_person_contacts_person').on(t.personId),
  uniqueIndex('uq_one_primary_contact').on(t.personId, t.kind).where(sql`is_primary AND ended_at IS NULL`),
  check('person_contacts_kind_check', sql`kind IN ('phone','email','other')`),
]);

/** A login. Not every person has one. Signs in with its phone or email (each unique across all logins). */
export const users = core.table('users', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().unique().references(() => persons.id),
  loginPhone: text('login_phone').unique(),
  loginEmail: text('login_email').unique(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }).notNull().defaultNow(), // older tokens stop working
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, () => [
  check('users_has_login', sql`login_phone IS NOT NULL OR login_email IS NOT NULL`),
]);

export const roles = core.table('roles', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  code: varchar('code', { length: 40 }).notNull(),
  name: text('name').notNull(),
}, (t) => [unique('roles_tenant_code_unique').on(t.tenantId, t.code)]);

/** What can be done, e.g. hrms.people.view. The same list for every tenant; added by migrations. */
export const permissions = core.table('permissions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  code: varchar('code', { length: 80 }).notNull().unique(),
  module: text('module').notNull(),
  description: text('description').notNull(),
});

export const rolePermissions = core.table('role_permissions', {
  roleId: bigint('role_id', { mode: 'number' }).notNull().references(() => roles.id),
  permissionId: bigint('permission_id', { mode: 'number' }).notNull().references(() => permissions.id),
}, (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })]);

/** A person holds a role over a scope: own records, their team (people they manage), or all. Ended, never deleted. */
export const roleAssignments = core.table('role_assignments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  roleId: bigint('role_id', { mode: 'number' }).notNull().references(() => roles.id),
  scope: text('scope').notNull(),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  grantedBy: bigint('granted_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_role_assignments_person').on(t.personId),
  check('role_assignments_scope_check', sql`scope IN ('own','team','all')`),
  check('role_assignments_not_self', sql`granted_by <> person_id`),
  check('role_assignments_dates', sql`valid_to IS NULL OR valid_to >= valid_from`),
]);
