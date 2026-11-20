import { sql } from 'drizzle-orm';
import { pgSchema, bigint, text, uuid, timestamp, boolean, varchar, check, unique, index, uniqueIndex, date, primaryKey, integer, jsonb, numeric } from 'drizzle-orm/pg-core';
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
  // set when someone else chose the password (a new login, an admin reset): the person must set their own before anything else
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, () => [
  check('users_has_login', sql`login_phone IS NOT NULL OR login_email IS NOT NULL`),
]);

/**
 * A program (not a person) that may call a few routes: the Tally connector on the Tally server PC. Bound to one tenant and
 * to one permission. client_id is public; only a bcrypt hash of the secret is stored, and the secret is shown once when
 * the credential is made. Revoked, never deleted.
 */
export const machineCredentials = core.table('machine_credentials', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  name: text('name').notNull(),
  clientId: text('client_id').notNull().unique(),
  secretHash: text('secret_hash').notNull(),
  permission: text('permission').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  check('machine_credentials_permission_check', sql`permission IN ('accounts.tally.connector')`),
  check('machine_credentials_revoked_check', sql`is_active = (revoked_at IS NULL)`),
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

/**
 * Company policies (shift rules, leave rules ...), never edited or deleted (trigger, migration 0010): a change is a new
 * version. On a date, the newest version already in force wins; a company's own policy comes before the group default
 * (legal_entity_id NULL).
 */
export const policies = core.table('policies', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  publicId: uuid('public_id').notNull().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).references(() => legalEntities.id),
  policyKey: text('policy_key').notNull(),
  value: jsonb('value').notNull(),
  version: integer('version').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  approvedBy: bigint('approved_by', { mode: 'number' }).notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('policies_version_unique').on(t.tenantId, t.legalEntityId, t.policyKey, t.version).nullsNotDistinct(),
  index('idx_policies_key').on(t.tenantId, t.policyKey, t.effectiveFrom),
  check('policies_version_positive', sql`version >= 1`),
]);

/**
 * What happened, by whom, to which record: decisions, approvals that needed none, private details revealed, months
 * locked. Never updated or deleted (trigger, migration 0021). `summary` is readable and never holds private values
 * (no Aadhaar, PAN, bank or phone numbers).
 */
export const auditLog = core.table('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actorPersonId: bigint('actor_person_id', { mode: 'number' }).references(() => persons.id),  // null: the system
  action: text('action').notNull(),                                                            // e.g. leave.approved
  entity: text('entity').notNull(),                                                            // e.g. leave_request
  entityPublicId: uuid('entity_public_id'),
  subjectPersonId: bigint('subject_person_id', { mode: 'number' }).references(() => persons.id), // whose record
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).references(() => legalEntities.id),
  summary: text('summary').notNull(),
  details: jsonb('details'),
}, (t) => [
  index('idx_audit_log_tenant_at').on(t.tenantId, t.at),
]);

/**
 * Where a punch was made: the coordinates sent and, once the reverse-geocoding provider answers, the address.
 * pending: no address yet (no provider configured, or the lookup failed) — the addresses:retry job tries again;
 * failed: given up after too many attempts. Written only through CoreFacade. Never logged (exact locations).
 */
export const places = core.table('places', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  latitude: numeric('latitude', { precision: 9, scale: 6 }).notNull(),
  longitude: numeric('longitude', { precision: 9, scale: 6 }).notNull(),
  accuracyM: integer('accuracy_m'),
  address: text('address'),
  status: text('status').notNull(),
  provider: text('provider'),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_places_pending').on(t.status).where(sql`status = 'pending'`),
  check('places_status_check', sql`status IN ('resolved','pending','failed')`),
  check('places_resolved_fields', sql`(status = 'resolved') = (address IS NOT NULL AND resolved_at IS NOT NULL)`),
  check('places_coordinates_check', sql`latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180`),
  check('places_attempts_check', sql`attempts >= 0`),
]);

/**
 * Failed sign-ins, counted per account and per IP address, and the brief lockout they lead to. The key is a keyed hash
 * (HMAC with JWT_SECRET) of the login or the IP, never the phone, email or address itself. Throttle state, not tenant
 * data: it has no tenant_id because a sign-in is counted before its tenant is known (unknown logins included).
 */
export const loginThrottle = core.table('login_throttle', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
}, (t) => [
  index('idx_login_throttle_window').on(t.windowStartedAt),
  check('login_throttle_failures_check', sql`failures >= 0`),
]);

/**
 * One-time sign-in codes sent by email: first login (purpose first_login) and forgot password (reset). Only a keyed
 * hash of the code is stored (HMAC with JWT_SECRET). A code works once, for 10 minutes, with at most 5 wrong tries.
 */
export const loginCodes = core.table('login_codes', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id),
  purpose: text('purpose').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_login_codes_user').on(t.userId, t.createdAt),
  check('login_codes_purpose_check', sql`purpose IN ('first_login','reset')`),
  check('login_codes_attempts_check', sql`attempts BETWEEN 0 AND 5`),
]);

/**
 * Events between modules (shared/src/events/envelope.ts), written in the same transaction as the change they describe,
 * so an event exists exactly when its change was saved. Never deleted; only published_at is set once, when a consumer
 * has taken it (trigger, migration 0041). Written only through CoreFacade.publish.
 */
export const outbox = core.table('outbox', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  eventId: uuid('event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  eventVersion: integer('event_version').notNull(),
  aggregatePublicId: uuid('aggregate_public_id').notNull(),
  causedBy: uuid('caused_by'),
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (t) => [
  index('idx_outbox_unpublished').on(t.id).where(sql`published_at IS NULL`),
  index('idx_outbox_type').on(t.tenantId, t.eventType, t.id),
  check('outbox_event_type_format', sql`event_type ~ '^[a-z]+([.][a-z_]+)+$'`),
  check('outbox_event_version_check', sql`event_version >= 1`),
]);

/**
 * One alert for one person (CoreFacade.notify). The in-app bell reads these. dedupe_key makes the same alert for the same
 * person exist once however often a job or event is replayed. Holds no phone numbers, bank or ID numbers or exact locations.
 */
export const notifications = core.table('notifications', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).references(() => legalEntities.id),
  recipientPersonId: bigint('recipient_person_id', { mode: 'number' }).notNull().references(() => persons.id),
  alertCode: text('alert_code').notNull(),
  urgency: text('urgency').notNull().default('normal'),
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'),
  dedupeKey: text('dedupe_key').notNull(),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('notifications_dedupe_unique').on(t.tenantId, t.recipientPersonId, t.dedupeKey),
  index('idx_notifications_recipient').on(t.recipientPersonId, t.createdAt),
  index('idx_notifications_unread').on(t.recipientPersonId).where(sql`read_at IS NULL`),
  check('notifications_urgency_check', sql`urgency IN ('normal','urgent')`),
  check('notifications_alert_code_format', sql`alert_code ~ '^[a-z]+([.][a-z_]+)+$'`),
]);

/** Delivery of a notification by one channel (in_app now; email and whatsapp later): sent, failed, retried. Never holds the address. */
export const notificationDeliveries = core.table('notification_deliveries', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  notificationId: bigint('notification_id', { mode: 'number' }).notNull().references(() => notifications.id),
  channel: text('channel').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('notification_deliveries_channel_unique').on(t.notificationId, t.channel),
  index('idx_notification_deliveries_pending').on(t.channel, t.id).where(sql`status = 'pending'`),
  check('notification_deliveries_channel_check', sql`channel IN ('in_app','email','whatsapp')`),
  check('notification_deliveries_status_check', sql`status IN ('pending','sent','failed','skipped')`),
]);

/**
 * A person's choices for alert emails (the bell is always on). One row per person, made when they first save choices.
 * Quiet hours (IST, HH:MM) hold urgent emails until the window ends; a window may cross midnight.
 */
export const notificationSettings = core.table('notification_settings', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  personId: bigint('person_id', { mode: 'number' }).notNull().unique().references(() => persons.id),
  emailUrgent: boolean('email_urgent').notNull().default(true),
  emailDigest: boolean('email_digest').notNull().default(true),
  quietStart: varchar('quiet_start', { length: 5 }),
  quietEnd: varchar('quiet_end', { length: 5 }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('notification_settings_quiet_check', sql`(quiet_start IS NULL) = (quiet_end IS NULL)`),
  check('notification_settings_quiet_format', sql`(quiet_start IS NULL OR quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') AND (quiet_end IS NULL OR quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')`),
]);

/** Email on or off for one type of alert, for one person. No row means the default (on). */
export const notificationPreferences = core.table('notification_preferences', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  personId: bigint('person_id', { mode: 'number' }).notNull().references(() => persons.id),
  alertCode: text('alert_code').notNull(),
  email: boolean('email').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('notification_preferences_unique').on(t.personId, t.alertCode),
  check('notification_preferences_alert_code_format', sql`alert_code ~ '^[a-z]+([.][a-z_]+)+$'`),
]);

/**
 * The customer list: who work is done for (design jobs, later sales and service). A company of the group is a customer
 * too, linked to its legal entity: work one group company does for another is billed through Intercompany. Shared by
 * every company of the tenant. Never deleted (inactive instead); the code and the linked company never change.
 */
export const customers = core.table('customers', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  publicId: uuid('public_id').notNull().defaultRandom().unique(),
  code: varchar('code', { length: 20 }).notNull(),
  name: text('name').notNull(),
  /** set when the customer is a company of the group (AE) */
  legalEntityId: bigint('legal_entity_id', { mode: 'number' }).references(() => legalEntities.id),
  status: text('status').notNull().default('active'),
  /** null for the group companies added by migration 0055 and the seed */
  createdBy: bigint('created_by', { mode: 'number' }).references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: bigint('updated_by', { mode: 'number' }).references(() => persons.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (t) => [
  unique('customers_tenant_code_unique').on(t.tenantId, t.code),
  uniqueIndex('customers_one_per_company').on(t.legalEntityId).where(sql`legal_entity_id IS NOT NULL`),
  check('customers_code_format', sql`code ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'`),
  check('customers_name_length', sql`char_length(name) BETWEEN 2 AND 200`),
  check('customers_status_check', sql`status IN ('active','inactive')`),
  check('customers_updated_fields', sql`(updated_by IS NULL) = (updated_at IS NULL)`),
]);
