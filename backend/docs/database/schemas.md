# Ageless platform — database schemas

Written for backend developers. Generated on 2026-11-06 from the catalog of a database with all 27 migrations
applied (`backend/drizzle/0000` … `0025`) and from the doc comments in each module's `schema.ts`. How the tables connect
(foreign keys, diagrams, links between modules) is in [connections.md](connections.md); security in [../security.md](../security.md).

## Overview

- **PostgreSQL 16**, one database. Tables are defined in TypeScript with **Drizzle ORM** (`src/modules/**/schema.ts`) and changed
  only through migrations (`pnpm db:generate`, `pnpm db:migrate`); merged migrations are never edited.
- **One PostgreSQL schema per module**, and a module writes only its own schema; other modules go through its facade.
  Reading another module's tables (joins for lists and reports) is allowed.

| Schema | Owner | Tables |
| --- | --- | --- |
| `core` | Core (`src/modules/core`) | 13 |
| `hrms` | HRMS (`src/modules/hrms`) | 22 |
| `payroll` | Payroll (`src/modules/payroll`) | 5 |
| `tickets` | Tickets (`src/modules/tickets`) | 14 |

**Conventions every table follows**

| Column / rule | Meaning |
| --- | --- |
| `id` bigint identity | internal key, used only by foreign keys; never shown by the API |
| `public_id` uuid | the record's id in APIs and URLs (often made by the device so a resend is stored once) |
| `tenant_id` | the tenant (the Ageless group); every table has it |
| `legal_entity_id` | the company (AE, ATPL …) on company-owned tables, with **composite foreign keys** `(x_id, legal_entity_id)` so a row can never point at another company's record |
| money | integer paise (`*_paise`) with a `currency` column |
| time | `timestamptz` (UTC); work dates are `date` in IST |
| history | nothing is deleted: rows are ended, exited, deactivated or cancelled; many tables are append-only (enforced by triggers, see each table and [connections.md](connections.md#triggers)) |

## Contents
- **core**: [audit_log](#coreaudit_log), [legal_entities](#corelegal_entities), [login_throttle](#corelogin_throttle), [permissions](#corepermissions), [person_contacts](#coreperson_contacts), [persons](#corepersons), [places](#coreplaces), [policies](#corepolicies), [role_assignments](#corerole_assignments), [role_permissions](#corerole_permissions), [roles](#coreroles), [tenants](#coretenants), [users](#coreusers)
- **hrms**: [attendance_corrections](#hrmsattendance_corrections), [attendance_events](#hrmsattendance_events), [attendance_exclusions](#hrmsattendance_exclusions), [certificates](#hrmscertificates), [departments](#hrmsdepartments), [designations](#hrmsdesignations), [employments](#hrmsemployments), [expense_categories](#hrmsexpense_categories), [expense_claims](#hrmsexpense_claims), [holiday_calendars](#hrmsholiday_calendars), [holidays](#hrmsholidays), [leave_ledger](#hrmsleave_ledger), [leave_requests](#hrmsleave_requests), [leave_types](#hrmsleave_types), [month_locks](#hrmsmonth_locks), [overtime_requests](#hrmsovertime_requests), [person_private](#hrmsperson_private), [person_skills](#hrmsperson_skills), [positions](#hrmspositions), [skills](#hrmsskills), [weekly_off_rules](#hrmsweekly_off_rules), [work_days](#hrmswork_days)
- **payroll**: [bank_accounts](#payrollbank_accounts), [payroll_adjustments](#payrollpayroll_adjustments), [payroll_items](#payrollpayroll_items), [payroll_runs](#payrollpayroll_runs), [salaries](#payrollsalaries)
- **tickets**: [number_series](#ticketsnumber_series), [reassign_requests](#ticketsreassign_requests), [ticket_assignees](#ticketsticket_assignees), [ticket_attachments](#ticketsticket_attachments), [ticket_checklist_results](#ticketsticket_checklist_results), [ticket_daily_updates](#ticketsticket_daily_updates), [ticket_events](#ticketsticket_events), [ticket_links](#ticketsticket_links), [ticket_signoffs](#ticketsticket_signoffs), [ticket_time_adjustments](#ticketsticket_time_adjustments), [ticket_time_allocations](#ticketsticket_time_allocations), [ticket_timelogs](#ticketsticket_timelogs), [ticket_types](#ticketsticket_types), [tickets](#ticketstickets)

## Schema `core`

### core.audit_log

What happened, by whom, to which record: decisions, approvals that needed none, private details revealed, months locked. Never updated or deleted (trigger, migration 0021). `summary` is readable and never holds private values (no Aadhaar, PAN, bank or phone numbers).

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `at` | timestamp with time zone | no | `now()` |  |
| `actor_person_id` | bigint | yes |  | null: the system |
| `action` | text | no |  | e.g. leave.approved |
| `entity` | text | no |  | e.g. leave_request |
| `entity_public_id` | uuid | yes |  |  |
| `subject_person_id` | bigint | yes |  | whose record |
| `legal_entity_id` | bigint | yes |  |  |
| `summary` | text | no |  |  |
| `details` | jsonb | yes |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `audit_log_pkey` | Primary key | PRIMARY KEY (id) |
| `audit_log_public_id_unique` | Unique | UNIQUE (public_id) |
| `audit_log_actor_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (actor_person_id) REFERENCES core.persons(id) |
| `audit_log_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `audit_log_subject_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (subject_person_id) REFERENCES core.persons(id) |
| `audit_log_tenant_id_tenants_id_fk` | Foreign key | FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) |

Indexes: `idx_audit_log_tenant_at`: btree (tenant_id, at)

Triggers: `trg_audit_log_append_only` → `core.forbid_audit_change()` (see [connections.md](connections.md#triggers)).

### core.legal_entities

The registered companies inside a tenant (AE, ATPL ...).

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `code` | varchar(12) | no |  |  |
| `name` | text | no |  |  |
| `legal_form` | text | no |  |  |
| `pan` | varchar(10) | yes |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `legal_entities_pkey` | Primary key | PRIMARY KEY (id) |
| `legal_entities_public_id_unique` | Unique | UNIQUE (public_id) |
| `legal_entities_tenant_id_code_unique` | Unique | UNIQUE (tenant_id, code) |
| `legal_entities_tenant_id_tenants_id_fk` | Foreign key | FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) |
| `legal_entities_legal_form_check` | Check | CHECK ((legal_form = ANY (ARRAY['partnership'::text, 'private_limited'::text, 'llp'::text, 'proprietorship'::text, 'other'::text]))) |

### core.login_throttle

Failed sign-ins, counted per account and per IP address, and the brief lockout they lead to. The key is a keyed hash (HMAC with JWT_SECRET) of the login or the IP, never the phone, email or address itself. Throttle state, not tenant data: it has no tenant_id because a sign-in is counted before its tenant is known (unknown logins included).

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `key` | text | no |  |  |
| `failures` | integer | no | `0` |  |
| `window_started_at` | timestamp with time zone | no |  |  |
| `locked_until` | timestamp with time zone | yes |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `login_throttle_pkey` | Primary key | PRIMARY KEY (key) |
| `login_throttle_failures_check` | Check | CHECK ((failures >= 0)) |

Indexes: `idx_login_throttle_window`: btree (window_started_at)

### core.permissions

What can be done, e.g. hrms.people.view. The same list for every tenant; added by migrations.

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `code` | varchar(80) | no |  |  |
| `module` | text | no |  |  |
| `description` | text | no |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `permissions_pkey` | Primary key | PRIMARY KEY (id) |
| `permissions_code_unique` | Unique | UNIQUE (code) |

### core.person_contacts

Phone numbers and emails of a person. Old ones are ended, not deleted. The same number may belong to several people.

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `person_id` | bigint | no |  |  |
| `kind` | text | no |  |  |
| `value` | text | no |  |  |
| `label` | text | yes |  |  |
| `is_primary` | boolean | no | `false` |  |
| `created_at` | timestamp with time zone | no | `now()` |  |
| `ended_at` | timestamp with time zone | yes |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `person_contacts_pkey` | Primary key | PRIMARY KEY (id) |
| `person_contacts_public_id_unique` | Unique | UNIQUE (public_id) |
| `person_contacts_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `person_contacts_kind_check` | Check | CHECK ((kind = ANY (ARRAY['phone'::text, 'email'::text, 'other'::text]))) |

Indexes: `idx_person_contacts_person`: btree (person_id); `uq_one_primary_contact`: unique btree (person_id, kind) WHERE (is_primary AND (ended_at IS NULL))

### core.persons

One record per human, shared by every module.

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `person_type` | text | no |  |  |
| `display_name` | text | no |  |  |
| `full_name` | text | no |  |  |
| `mobile` | text | yes |  |  |
| `status` | text | no | `'active'` |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `persons_pkey` | Primary key | PRIMARY KEY (id) |
| `persons_public_id_unique` | Unique | UNIQUE (public_id) |

### core.places

Where a punch was made: the coordinates sent and, once the reverse-geocoding provider answers, the address. pending: no address yet (no provider configured, or the lookup failed) — the addresses:retry job tries again; failed: given up after too many attempts. Written only through CoreFacade. Never logged (exact locations).

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `latitude` | numeric(9,6) | no |  |  |
| `longitude` | numeric(9,6) | no |  |  |
| `accuracy_m` | integer | yes |  |  |
| `address` | text | yes |  |  |
| `status` | text | no |  |  |
| `provider` | text | yes |  |  |
| `attempts` | integer | no | `0` |  |
| `last_attempt_at` | timestamp with time zone | yes |  |  |
| `resolved_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `places_pkey` | Primary key | PRIMARY KEY (id) |
| `places_tenant_id_tenants_id_fk` | Foreign key | FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) |
| `places_attempts_check` | Check | CHECK ((attempts >= 0)) |
| `places_coordinates_check` | Check | CHECK ((((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric)) AND ((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric)))) |
| `places_resolved_fields` | Check | CHECK (((status = 'resolved'::text) = ((address IS NOT NULL) AND (resolved_at IS NOT NULL)))) |
| `places_status_check` | Check | CHECK ((status = ANY (ARRAY['resolved'::text, 'pending'::text, 'failed'::text]))) |

Indexes: `idx_places_pending`: btree (status) WHERE (status = 'pending'::text)

### core.policies

Company policies (shift rules, leave rules ...), never edited or deleted (trigger, migration 0010): a change is a new version. On a date, the newest version already in force wins; a company's own policy comes before the group default (legal_entity_id NULL).

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  |  |
| `legal_entity_id` | bigint | yes |  |  |
| `policy_key` | text | no |  |  |
| `value` | jsonb | no |  |  |
| `version` | integer | no |  |  |
| `effective_from` | date | no |  |  |
| `approved_by` | bigint | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `policies_pkey` | Primary key | PRIMARY KEY (id) |
| `policies_public_id_unique` | Unique | UNIQUE (public_id) |
| `policies_version_unique` | Unique | UNIQUE NULLS NOT DISTINCT (tenant_id, legal_entity_id, policy_key, version) |
| `policies_approved_by_persons_id_fk` | Foreign key | FOREIGN KEY (approved_by) REFERENCES core.persons(id) |
| `policies_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `policies_tenant_id_tenants_id_fk` | Foreign key | FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) |
| `policies_version_positive` | Check | CHECK ((version >= 1)) |

Indexes: `idx_policies_key`: btree (tenant_id, policy_key, effective_from)

Triggers: `trg_policies_append_only` → `core.forbid_policy_change()` (see [connections.md](connections.md#triggers)).

### core.role_assignments

A person holds a role over a scope: own records, their team (people they manage), or all. Ended, never deleted.

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `person_id` | bigint | no |  |  |
| `role_id` | bigint | no |  |  |
| `scope` | text | no |  |  |
| `valid_from` | date | no |  |  |
| `valid_to` | date | yes |  |  |
| `ended_at` | timestamp with time zone | yes |  |  |
| `granted_by` | bigint | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `role_assignments_pkey` | Primary key | PRIMARY KEY (id) |
| `role_assignments_public_id_unique` | Unique | UNIQUE (public_id) |
| `role_assignments_granted_by_persons_id_fk` | Foreign key | FOREIGN KEY (granted_by) REFERENCES core.persons(id) |
| `role_assignments_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `role_assignments_role_id_roles_id_fk` | Foreign key | FOREIGN KEY (role_id) REFERENCES core.roles(id) |
| `role_assignments_tenant_id_tenants_id_fk` | Foreign key | FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) |
| `role_assignments_dates` | Check | CHECK (((valid_to IS NULL) OR (valid_to >= valid_from))) |
| `role_assignments_not_self` | Check | CHECK ((granted_by <> person_id)) |
| `role_assignments_scope_check` | Check | CHECK ((scope = ANY (ARRAY['own'::text, 'team'::text, 'all'::text]))) |

Indexes: `idx_role_assignments_person`: btree (person_id)

### core.role_permissions

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `role_id` | bigint | no |  |  |
| `permission_id` | bigint | no |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `role_permissions_role_id_permission_id_pk` | Primary key | PRIMARY KEY (role_id, permission_id) |
| `role_permissions_permission_id_permissions_id_fk` | Foreign key | FOREIGN KEY (permission_id) REFERENCES core.permissions(id) |
| `role_permissions_role_id_roles_id_fk` | Foreign key | FOREIGN KEY (role_id) REFERENCES core.roles(id) |

### core.roles

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `code` | varchar(40) | no |  |  |
| `name` | text | no |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `roles_pkey` | Primary key | PRIMARY KEY (id) |
| `roles_tenant_code_unique` | Unique | UNIQUE (tenant_id, code) |
| `roles_tenant_id_tenants_id_fk` | Foreign key | FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) |

### core.tenants

One row per company group using the platform. Full Core tables: see docs/reference/ageless_core_tickets_hrms.sql

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `name` | text | no |  |  |
| `is_active` | boolean | no | `true` |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `tenants_pkey` | Primary key | PRIMARY KEY (id) |
| `tenants_public_id_unique` | Unique | UNIQUE (public_id) |

### core.users

A login. Not every person has one. Signs in with its phone or email (each unique across all logins).

Defined in `src/modules/core/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `person_id` | bigint | no |  |  |
| `login_phone` | text | yes |  |  |
| `login_email` | text | yes |  |  |
| `password_hash` | text | no |  |  |
| `is_active` | boolean | no | `true` |  |
| `password_changed_at` | timestamp with time zone | no | `now()` | older tokens stop working |
| `last_login_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `users_pkey` | Primary key | PRIMARY KEY (id) |
| `users_login_email_unique` | Unique | UNIQUE (login_email) |
| `users_login_phone_unique` | Unique | UNIQUE (login_phone) |
| `users_person_id_unique` | Unique | UNIQUE (person_id) |
| `users_public_id_unique` | Unique | UNIQUE (public_id) |
| `users_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `users_tenant_id_tenants_id_fk` | Foreign key | FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) |
| `users_has_login` | Check | CHECK (((login_phone IS NOT NULL) OR (login_email IS NOT NULL))) |

## Schema `hrms`

### hrms.attendance_corrections

A request to fix one job's day: add the missing or right punch times, and leave out wrong punches. Approval adds punches (source 'correction') and exclusions; the original punches stay. One open (submitted) correction per job and date.

Defined in `src/modules/hrms/attendance/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  |  |
| `person_id` | bigint | no |  |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `work_date` | date | no |  |  |
| `kind` | text | no |  |  |
| `requested_in` | timestamp with time zone | yes |  |  |
| `requested_out` | timestamp with time zone | yes |  |  |
| `punch_ids_to_exclude` | ARRAY | no | `'{}'` | public ids of the job's punches that day |
| `reason` | text | no |  |  |
| `status` | text | no | `'submitted'` |  |
| `requested_by` | bigint | no |  |  |
| `approver_person_id` | bigint | yes |  |  |
| `decided_by` | bigint | yes |  |  |
| `decided_at` | timestamp with time zone | yes |  |  |
| `decision_reason` | text | yes |  |  |
| `cancelled_by` | bigint | yes |  |  |
| `cancelled_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |
| `decided_as` | text | yes |  | approver \| hr \| management \| no_approval_required (see migration 0021) |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `attendance_corrections_pkey` | Primary key | PRIMARY KEY (id) |
| `attendance_corrections_public_id_unique` | Unique | UNIQUE (public_id) |
| `attendance_corrections_approver_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (approver_person_id) REFERENCES core.persons(id) |
| `attendance_corrections_cancelled_by_persons_id_fk` | Foreign key | FOREIGN KEY (cancelled_by) REFERENCES core.persons(id) |
| `attendance_corrections_decided_by_persons_id_fk` | Foreign key | FOREIGN KEY (decided_by) REFERENCES core.persons(id) |
| `attendance_corrections_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `attendance_corrections_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `attendance_corrections_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `attendance_corrections_requested_by_persons_id_fk` | Foreign key | FOREIGN KEY (requested_by) REFERENCES core.persons(id) |
| `attendance_corrections_decided_as_check` | Check | CHECK (((decided_as IS NULL) OR (decided_as = ANY (ARRAY['approver'::text, 'hr'::text, 'management'::text, 'no_approval_required'::text])))) |
| `attendance_corrections_decided_fields` | Check | CHECK (((status <> ALL (ARRAY['approved'::text, 'rejected'::text])) OR ((decided_at IS NOT NULL) AND (decided_as IS NOT NULL)))) |
| `attendance_corrections_decider_required` | Check | CHECK (((decided_as IS NULL) OR ((decided_as = 'no_approval_required'::text) = (decided_by IS NULL)))) |
| `attendance_corrections_kind_check` | Check | CHECK ((kind = ANY (ARRAY['missed_out'::text, 'missed_in'::text, 'wrong_time'::text, 'other'::text]))) |
| `attendance_corrections_not_own_approver` | Check | CHECK (((approver_person_id IS NULL) OR ((approver_person_id <> person_id) AND (approver_person_id <> requested_by)))) |
| `attendance_corrections_not_own_decision` | Check | CHECK (((decided_by IS NULL) OR ((decided_by <> person_id) AND (decided_by <> requested_by)))) |
| `attendance_corrections_reason_length` | Check | CHECK ((char_length(reason) >= 10)) |
| `attendance_corrections_rejected_has_reason` | Check | CHECK (((status <> 'rejected'::text) OR (decision_reason IS NOT NULL))) |
| `attendance_corrections_status_check` | Check | CHECK ((status = ANY (ARRAY['submitted'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text]))) |
| `attendance_corrections_times_order` | Check | CHECK (((requested_in IS NULL) OR (requested_out IS NULL) OR (requested_in < requested_out))) |

Indexes: `idx_corrections_approver`: btree (approver_person_id, status); `uq_correction_open_per_day`: unique btree (employment_id, work_date) WHERE (status = 'submitted'::text)

### hrms.attendance_events

Raw punches, never edited or deleted (append-only trigger, migration 0007). 'in' and 'out' alternate per person across all their jobs, and an 'out' closes the 'in' of the same job (trigger raises HRMS_PUNCH_ORDER). source 'correction': added by an approved correction; 'auto': a forgotten punch-out closed by the system.

Defined in `src/modules/hrms/attendance/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  | made on the device: a resend is stored once |
| `person_id` | bigint | no |  |  |
| `kind` | text | no |  |  |
| `source` | text | no |  |  |
| `occurred_at` | timestamp with time zone | no |  | when it happened (device time) |
| `received_at` | timestamp with time zone | no | `now()` |  |
| `latitude` | numeric(9,6) | yes |  |  |
| `longitude` | numeric(9,6) | yes |  |  |
| `accuracy_m` | integer | yes |  |  |
| `location_status` | text | yes |  |  |
| `employment_id` | bigint | no |  |  |
| `correction_id` | bigint | yes |  | set on source 'correction' |
| `legal_entity_id` | bigint | no |  |  |
| `place_id` | bigint | yes |  | where it was made (address looked up by core) |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `attendance_events_pkey` | Primary key | PRIMARY KEY (id) |
| `attendance_events_public_id_unique` | Unique | UNIQUE (public_id) |
| `attendance_events_correction_id_attendance_corrections_id_fk` | Foreign key | FOREIGN KEY (correction_id) REFERENCES hrms.attendance_corrections(id) |
| `attendance_events_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `attendance_events_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `attendance_events_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `attendance_events_place_id_places_id_fk` | Foreign key | FOREIGN KEY (place_id) REFERENCES core.places(id) |
| `attendance_events_accuracy_check` | Check | CHECK (((accuracy_m IS NULL) OR (accuracy_m >= 0))) |
| `attendance_events_correction_link` | Check | CHECK (((source = 'correction'::text) = (correction_id IS NOT NULL))) |
| `attendance_events_kind_check` | Check | CHECK ((kind = ANY (ARRAY['in'::text, 'out'::text]))) |
| `attendance_events_lat_lng_together` | Check | CHECK (((latitude IS NULL) = (longitude IS NULL))) |
| `attendance_events_location_status_check` | Check | CHECK (((location_status IS NULL) OR (location_status = ANY (ARRAY['inside'::text, 'outside'::text, 'poor_accuracy'::text, 'not_configured'::text, 'not_taken'::text])))) |
| `attendance_events_source_check` | Check | CHECK ((source = ANY (ARRAY['app'::text, 'web'::text, 'supervisor'::text, 'park_counter'::text, 'gate'::text, 'correction'::text, 'auto'::text]))) |

Indexes: `idx_att_employment_time`: btree (employment_id, occurred_at); `idx_att_person_time`: btree (person_id, occurred_at)

Triggers: `trg_punch_append_only` → `hrms.forbid_punch_change()`; `trg_punch_month_lock` → `hrms.guard_locked_month_punch()`; `trg_punch_order` → `hrms.check_punch_order()` (see [connections.md](connections.md#triggers)).

### hrms.attendance_exclusions

Punches left out of the work day by an approved correction. Never edited or deleted (trigger, migration 0011).

Defined in `src/modules/hrms/attendance/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `punch_id` | bigint | no |  |  |
| `correction_id` | bigint | no |  |  |
| `reason` | text | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `attendance_exclusions_pkey` | Primary key | PRIMARY KEY (id) |
| `attendance_exclusions_punch_id_unique` | Unique | UNIQUE (punch_id) |
| `attendance_exclusions_correction_id_attendance_corrections_id_f` | Foreign key | FOREIGN KEY (correction_id) REFERENCES hrms.attendance_corrections(id) |
| `attendance_exclusions_punch_id_attendance_events_id_fk` | Foreign key | FOREIGN KEY (punch_id) REFERENCES hrms.attendance_events(id) |

Triggers: `trg_exclusion_append_only` → `hrms.forbid_exclusion_change()` (see [connections.md](connections.md#triggers)).

### hrms.certificates

A person's certificate (with its file). review → verified; expired once past expires_on (daily job).

Defined in `src/modules/hrms/skills/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `person_id` | bigint | no |  |  |
| `name` | text | no |  |  |
| `expires_on` | date | yes |  |  |
| `status` | text | no | `'review'` |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `issuer` | text | yes |  |  |
| `number` | text | yes |  | the certificate's own number (never logged) |
| `issued_on` | date | yes |  |  |
| `file_path` | text | yes |  | relative to the uploads folder |
| `file_type` | text | yes |  | pdf, jpg or png |
| `verified_by` | bigint | yes |  |  |
| `verified_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `certificates_pkey` | Primary key | PRIMARY KEY (id) |
| `certificates_public_id_unique` | Unique | UNIQUE (public_id) |
| `certificates_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `certificates_verified_by_persons_id_fk` | Foreign key | FOREIGN KEY (verified_by) REFERENCES core.persons(id) |
| `certificates_dates_check` | Check | CHECK (((issued_on IS NULL) OR (expires_on IS NULL) OR (expires_on >= issued_on))) |
| `certificates_not_self_verified` | Check | CHECK (((verified_by IS NULL) OR (verified_by <> person_id))) |
| `certificates_status_check` | Check | CHECK ((status = ANY (ARRAY['review'::text, 'verified'::text, 'expired'::text]))) |

Indexes: `idx_certificates_expires`: btree (tenant_id, expires_on)

### hrms.departments

A company's departments. code_prefix starts its employee codes (ATS → ATS001, ATS002 ...).

Defined in `src/modules/hrms/people/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `legal_entity_id` | bigint | no |  |  |
| `name` | text | no |  |  |
| `code_prefix` | text | no |  |  |
| `head_person_id` | bigint | yes |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `departments_pkey` | Primary key | PRIMARY KEY (id) |
| `departments_company_name_unique` | Unique | UNIQUE (legal_entity_id, name) |
| `departments_company_prefix_unique` | Unique | UNIQUE (legal_entity_id, code_prefix) |
| `departments_id_company_unique` | Unique | UNIQUE (id, legal_entity_id) |
| `departments_public_id_unique` | Unique | UNIQUE (public_id) |
| `departments_head_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (head_person_id) REFERENCES core.persons(id) |
| `departments_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `departments_prefix_format` | Check | CHECK ((code_prefix ~ '^[A-Z]{2,6}$'::text)) |

### hrms.designations

Job titles a company uses (for positions; an employment's designation stays free text).

Defined in `src/modules/hrms/people/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `legal_entity_id` | bigint | no |  |  |
| `name` | text | no |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `designations_pkey` | Primary key | PRIMARY KEY (id) |
| `designations_company_name_unique` | Unique | UNIQUE (legal_entity_id, name) |
| `designations_id_company_unique` | Unique | UNIQUE (id, legal_entity_id) |
| `designations_public_id_unique` | Unique | UNIQUE (public_id) |
| `designations_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |

### hrms.employments

A person's job in one company. joining (offer accepted, not started) → active → (notice) → exited. The employee code never changes, even when the department does.

Defined in `src/modules/hrms/people/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `person_id` | bigint | no |  |  |
| `employee_code` | text | no |  |  |
| `employment_type` | text | no |  |  |
| `joined_on` | date | no |  |  |
| `exit_on` | date | yes |  |  |
| `status` | text | no | `'active'` |  |
| `manager_person_id` | bigint | yes |  |  |
| `designation` | text | yes |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `is_primary` | boolean | no | `false` |  |
| `exit_reason` | text | yes |  |  |
| `recruited_on` | date | yes |  |  |
| `department_id` | bigint | yes |  |  |
| `offer_letter_path` | text | yes |  | relative to the uploads folder |
| `offer_letter_type` | text | yes |  | pdf, jpg or png |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `employments_pkey` | Primary key | PRIMARY KEY (id) |
| `employments_company_code_unique` | Unique | UNIQUE (legal_entity_id, employee_code) |
| `employments_id_company_unique` | Unique | UNIQUE (id, legal_entity_id) |
| `employments_public_id_unique` | Unique | UNIQUE (public_id) |
| `employments_department_company_fk` | Foreign key | FOREIGN KEY (department_id, legal_entity_id) REFERENCES hrms.departments(id, legal_entity_id) |
| `employments_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `employments_manager_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (manager_person_id) REFERENCES core.persons(id) |
| `employments_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `employments_exit_after_join` | Check | CHECK (((exit_on IS NULL) OR (exit_on >= joined_on))) |
| `employments_exited_has_date_and_reason` | Check | CHECK (((status <> 'exited'::text) OR ((exit_on IS NOT NULL) AND (exit_reason IS NOT NULL)))) |
| `employments_manager_not_self` | Check | CHECK ((manager_person_id <> person_id)) |
| `employments_recruited_before_join` | Check | CHECK (((recruited_on IS NULL) OR (recruited_on <= joined_on))) |
| `employments_status_check` | Check | CHECK ((status = ANY (ARRAY['joining'::text, 'active'::text, 'notice'::text, 'exited'::text]))) |

Indexes: `uq_active_employment_per_company`: unique btree (person_id, legal_entity_id) WHERE (status = ANY (ARRAY['joining'::text, 'active'::text, 'notice'::text])); `uq_one_primary_employment`: unique btree (person_id) WHERE (is_primary AND (status = 'active'::text))

### hrms.expense_categories

fuel, travel, food, materials, other ... per tenant; receipt_required decides whether a photo/PDF must be attached.

Defined in `src/modules/hrms/expenses/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `code` | text | no |  |  |
| `name` | text | no |  |  |
| `receipt_required` | boolean | no | `true` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `expense_categories_pkey` | Primary key | PRIMARY KEY (id) |
| `expense_categories_tenant_code_unique` | Unique | UNIQUE (tenant_id, code) |

### hrms.expense_claims

submitted → approved → paid, or submitted → rejected. A paid claim never changes (trigger in migration 0006).

Defined in `src/modules/hrms/expenses/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `person_id` | bigint | no |  |  |
| `category_id` | bigint | no |  |  |
| `spent_on` | date | no |  |  |
| `amount_paise` | bigint | no |  |  |
| `ticket_id` | bigint | yes |  | link to a service ticket |
| `status` | text | no | `'submitted'` |  |
| `employment_id` | bigint | no |  |  |
| `description` | text | yes |  |  |
| `receipt_path` | text | yes |  | relative to the uploads folder |
| `approved_by` | bigint | yes |  |  |
| `approved_at` | timestamp with time zone | yes |  |  |
| `approved_amount_paise` | bigint | yes |  |  |
| `rejected_by` | bigint | yes |  |  |
| `rejected_at` | timestamp with time zone | yes |  |  |
| `rejection_reason` | text | yes |  |  |
| `paid_at` | timestamp with time zone | yes |  |  |
| `payment_ref` | text | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |
| `legal_entity_id` | bigint | no |  |  |
| `currency` | char(3) | no | `'INR'` | of amount_paise / approved_amount_paise |
| `decided_as` | text | yes |  | approver \| hr \| management \| no_approval_required (see migration 0021) |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `expense_claims_pkey` | Primary key | PRIMARY KEY (id) |
| `expense_claims_public_id_unique` | Unique | UNIQUE (public_id) |
| `expense_claims_approved_by_persons_id_fk` | Foreign key | FOREIGN KEY (approved_by) REFERENCES core.persons(id) |
| `expense_claims_category_id_expense_categories_id_fk` | Foreign key | FOREIGN KEY (category_id) REFERENCES hrms.expense_categories(id) |
| `expense_claims_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `expense_claims_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `expense_claims_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `expense_claims_rejected_by_persons_id_fk` | Foreign key | FOREIGN KEY (rejected_by) REFERENCES core.persons(id) |
| `expense_claims_ticket_id_tickets_id_fk` | Foreign key | FOREIGN KEY (ticket_id) REFERENCES tickets.tickets(id) |
| `expense_claims_amount_positive` | Check | CHECK ((amount_paise > 0)) |
| `expense_claims_approved_within_claim` | Check | CHECK (((approved_amount_paise IS NULL) OR ((approved_amount_paise > 0) AND (approved_amount_paise <= amount_paise)))) |
| `expense_claims_decided_as_check` | Check | CHECK (((decided_as IS NULL) OR (decided_as = ANY (ARRAY['approver'::text, 'hr'::text, 'management'::text, 'no_approval_required'::text])))) |
| `expense_claims_decided_fields` | Check | CHECK ((((status <> ALL (ARRAY['approved'::text, 'paid'::text])) OR ((approved_at IS NOT NULL) AND (decided_as IS NOT NULL))) AND ((status <> 'rejected'::text) OR ((rejected_by IS NOT NULL) AND (decided_as IS NOT NULL))))) |
| `expense_claims_decider_required` | Check | CHECK (((decided_as IS NULL) OR ((decided_as = 'no_approval_required'::text) = ((approved_by IS NULL) AND (rejected_by IS NULL))))) |
| `expense_claims_not_self_approved` | Check | CHECK (((approved_by IS NULL) OR (approved_by <> person_id))) |
| `expense_claims_not_self_rejected` | Check | CHECK (((rejected_by IS NULL) OR (rejected_by <> person_id))) |
| `expense_claims_paid_has_details` | Check | CHECK (((status <> 'paid'::text) OR ((paid_at IS NOT NULL) AND (payment_ref IS NOT NULL)))) |
| `expense_claims_rejected_has_reason` | Check | CHECK (((status <> 'rejected'::text) OR (rejection_reason IS NOT NULL))) |
| `expense_claims_status_check` | Check | CHECK ((status = ANY (ARRAY['submitted'::text, 'approved'::text, 'rejected'::text, 'paid'::text]))) |

Indexes: `idx_expense_claims_employment`: btree (employment_id); `idx_expense_claims_person`: btree (person_id)

Triggers: `trg_paid_claim_frozen` → `hrms.forbid_paid_claim_change()` (see [connections.md](connections.md#triggers)).

### hrms.holiday_calendars

One holiday list per company per year.

Defined in `src/modules/hrms/calendar/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `year` | integer | no |  |  |
| `name` | text | no |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `holiday_calendars_pkey` | Primary key | PRIMARY KEY (id) |
| `holiday_calendars_company_year_unique` | Unique | UNIQUE (legal_entity_id, year) |
| `holiday_calendars_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |

### hrms.holidays

is_optional: a restricted holiday — a working day that staff may take as leave.

Defined in `src/modules/hrms/calendar/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  |  |
| `calendar_id` | bigint | no |  |  |
| `date` | date | no |  |  |
| `name` | text | no |  |  |
| `is_optional` | boolean | no | `false` |  |
| `created_by` | bigint | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `holidays_pkey` | Primary key | PRIMARY KEY (id) |
| `holidays_calendar_date_unique` | Unique | UNIQUE (calendar_id, date) |
| `holidays_public_id_unique` | Unique | UNIQUE (public_id) |
| `holidays_calendar_id_holiday_calendars_id_fk` | Foreign key | FOREIGN KEY (calendar_id) REFERENCES hrms.holiday_calendars(id) |
| `holidays_created_by_persons_id_fk` | Foreign key | FOREIGN KEY (created_by) REFERENCES core.persons(id) |

### hrms.leave_ledger

Every change to a leave balance, never edited or deleted (trigger, migration 0009). Balance = sum of `days`. taken is negative (on approval); taken_reversal gives it back (approved leave cancelled).

Defined in `src/modules/hrms/leave/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `employment_id` | bigint | no |  |  |
| `leave_type_id` | bigint | no |  |  |
| `year` | integer | no |  |  |
| `entry` | text | no |  |  |
| `days` | numeric(5,1) | no |  |  |
| `leave_request_id` | bigint | yes |  |  |
| `reason` | text | yes |  |  |
| `posted_by` | bigint | no |  |  |
| `posted_at` | timestamp with time zone | no | `now()` |  |
| `legal_entity_id` | bigint | no |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `leave_ledger_pkey` | Primary key | PRIMARY KEY (id) |
| `leave_ledger_public_id_unique` | Unique | UNIQUE (public_id) |
| `leave_ledger_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `leave_ledger_leave_request_id_leave_requests_id_fk` | Foreign key | FOREIGN KEY (leave_request_id) REFERENCES hrms.leave_requests(id) |
| `leave_ledger_leave_type_id_leave_types_id_fk` | Foreign key | FOREIGN KEY (leave_type_id) REFERENCES hrms.leave_types(id) |
| `leave_ledger_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `leave_ledger_posted_by_persons_id_fk` | Foreign key | FOREIGN KEY (posted_by) REFERENCES core.persons(id) |
| `leave_ledger_days_not_zero` | Check | CHECK ((days <> (0)::numeric)) |
| `leave_ledger_entry_check` | Check | CHECK ((entry = ANY (ARRAY['opening'::text, 'grant'::text, 'taken'::text, 'taken_reversal'::text, 'adjustment'::text]))) |
| `leave_ledger_reason_required` | Check | CHECK (((entry <> ALL (ARRAY['opening'::text, 'adjustment'::text, 'grant'::text])) OR (reason IS NOT NULL))) |
| `leave_ledger_request_link` | Check | CHECK (((entry = ANY (ARRAY['taken'::text, 'taken_reversal'::text])) = (leave_request_id IS NOT NULL))) |
| `leave_ledger_taken_sign` | Check | CHECK ((((entry <> 'taken'::text) OR (days < (0)::numeric)) AND ((entry <> 'taken_reversal'::text) OR (days > (0)::numeric)))) |

Indexes: `idx_leave_ledger_balance`: btree (employment_id, leave_type_id, year); `uq_leave_ledger_one_opening`: unique btree (employment_id, leave_type_id, year) WHERE (entry = 'opening'::text); `uq_leave_ledger_request_entry`: unique btree (leave_request_id, entry, year) WHERE (leave_request_id IS NOT NULL)

Triggers: `trg_leave_ledger_append_only` → `hrms.forbid_ledger_change()` (see [connections.md](connections.md#triggers)).

### hrms.leave_requests

A leave request on one job. `days` is counted when applying (holidays and weekly offs skipped) and kept. Submitted or approved requests of the same job never overlap (exclusion constraint, migration 0009).

Defined in `src/modules/hrms/leave/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `person_id` | bigint | no |  |  |
| `leave_type_id` | bigint | no |  |  |
| `from_date` | date | no |  |  |
| `to_date` | date | no |  |  |
| `days` | numeric(5,1) | no |  |  |
| `status` | text | no | `'submitted'` |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `from_half` | text | no | `'full'` |  |
| `to_half` | text | no | `'full'` |  |
| `reason` | text | yes |  |  |
| `approver_person_id` | bigint | yes |  |  |
| `decided_by` | bigint | yes |  |  |
| `decided_at` | timestamp with time zone | yes |  |  |
| `decision_reason` | text | yes |  |  |
| `cancelled_by` | bigint | yes |  |  |
| `cancelled_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |
| `decided_as` | text | yes |  | approver \| hr \| management \| no_approval_required (see migration 0021) |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `leave_requests_pkey` | Primary key | PRIMARY KEY (id) |
| `leave_requests_public_id_unique` | Unique | UNIQUE (public_id) |
| `leave_requests_approver_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (approver_person_id) REFERENCES core.persons(id) |
| `leave_requests_cancelled_by_persons_id_fk` | Foreign key | FOREIGN KEY (cancelled_by) REFERENCES core.persons(id) |
| `leave_requests_decided_by_persons_id_fk` | Foreign key | FOREIGN KEY (decided_by) REFERENCES core.persons(id) |
| `leave_requests_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `leave_requests_leave_type_id_leave_types_id_fk` | Foreign key | FOREIGN KEY (leave_type_id) REFERENCES hrms.leave_types(id) |
| `leave_requests_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `leave_requests_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `leave_requests_dates_check` | Check | CHECK ((to_date >= from_date)) |
| `leave_requests_days_check` | Check | CHECK ((days > (0)::numeric)) |
| `leave_requests_decided_as_check` | Check | CHECK (((decided_as IS NULL) OR (decided_as = ANY (ARRAY['approver'::text, 'hr'::text, 'management'::text, 'no_approval_required'::text])))) |
| `leave_requests_decided_fields` | Check | CHECK (((status = 'cancelled'::text) OR ((status = ANY (ARRAY['approved'::text, 'rejected'::text])) = ((decided_at IS NOT NULL) AND (decided_as IS NOT NULL))))) |
| `leave_requests_decider_required` | Check | CHECK (((decided_as IS NULL) OR ((decided_as = 'no_approval_required'::text) = (decided_by IS NULL)))) |
| `leave_requests_halves_check` | Check | CHECK (((from_half = ANY (ARRAY['full'::text, 'second_half'::text])) AND (to_half = ANY (ARRAY['full'::text, 'first_half'::text])))) |
| `leave_requests_not_own_approver` | Check | CHECK (((approver_person_id IS NULL) OR (approver_person_id <> person_id))) |
| `leave_requests_not_own_decision` | Check | CHECK (((decided_by IS NULL) OR (decided_by <> person_id))) |
| `leave_requests_rejected_has_reason` | Check | CHECK (((status <> 'rejected'::text) OR (decision_reason IS NOT NULL))) |
| `leave_requests_status_check` | Check | CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text]))) |

Indexes: `idx_leave_requests_approver`: btree (approver_person_id, status); `idx_leave_requests_employment`: btree (employment_id, from_date)

### hrms.leave_types

Defined in `src/modules/hrms/leave/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `code` | text | no |  |  |
| `name` | text | no |  |  |
| `policy_key` | text | no |  |  |
| `is_paid` | boolean | no | `true` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `leave_types_pkey` | Primary key | PRIMARY KEY (id) |
| `leave_types_tenant_code_unique` | Unique | UNIQUE (tenant_id, code) |

### hrms.month_locks

A company's month closed for payroll: its work days are locked and no punch, correction, leave or overtime may change it (HRMS_MONTH_LOCKED). Only a System Admin unlocks, with a reason; the row keeps who locked and who unlocked. One open lock per company and month; locking again after an unlock adds a new row.

Defined in `src/modules/hrms/attendance/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `legal_entity_id` | bigint | no |  |  |
| `year` | integer | no |  |  |
| `month` | integer | no |  |  |
| `locked_by` | bigint | no |  |  |
| `locked_at` | timestamp with time zone | no | `now()` |  |
| `unlocked_by` | bigint | yes |  |  |
| `unlocked_at` | timestamp with time zone | yes |  |  |
| `unlock_reason` | text | yes |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `month_locks_pkey` | Primary key | PRIMARY KEY (id) |
| `month_locks_public_id_unique` | Unique | UNIQUE (public_id) |
| `month_locks_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `month_locks_locked_by_persons_id_fk` | Foreign key | FOREIGN KEY (locked_by) REFERENCES core.persons(id) |
| `month_locks_unlocked_by_persons_id_fk` | Foreign key | FOREIGN KEY (unlocked_by) REFERENCES core.persons(id) |
| `month_locks_month_check` | Check | CHECK ((((month >= 1) AND (month <= 12)) AND ((year >= 2000) AND (year <= 2100)))) |
| `month_locks_unlock_together` | Check | CHECK ((((unlocked_by IS NULL) = (unlocked_at IS NULL)) AND ((unlocked_by IS NULL) = (unlock_reason IS NULL)))) |

Indexes: `uq_month_lock_open`: unique btree (legal_entity_id, year, month) WHERE (unlocked_at IS NULL)

### hrms.overtime_requests

A request to pay extra time on one job's day as overtime. Asked by the person or their manager; planned overtime (a future date) is allowed. Approved minutes count on the day up to its extra minutes (applied when the day is built).

Defined in `src/modules/hrms/attendance/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  |  |
| `person_id` | bigint | no |  |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `work_date` | date | no |  |  |
| `minutes` | integer | no |  |  |
| `reason` | text | no |  |  |
| `ticket_id` | bigint | yes |  |  |
| `status` | text | no | `'submitted'` |  |
| `requested_by` | bigint | no |  |  |
| `approver_person_id` | bigint | yes |  |  |
| `decided_by` | bigint | yes |  |  |
| `decided_at` | timestamp with time zone | yes |  |  |
| `decision_reason` | text | yes |  |  |
| `cancelled_by` | bigint | yes |  |  |
| `cancelled_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |
| `decided_as` | text | yes |  | approver \| hr \| management \| no_approval_required (see migration 0021) |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `overtime_requests_pkey` | Primary key | PRIMARY KEY (id) |
| `overtime_requests_public_id_unique` | Unique | UNIQUE (public_id) |
| `overtime_requests_approver_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (approver_person_id) REFERENCES core.persons(id) |
| `overtime_requests_cancelled_by_persons_id_fk` | Foreign key | FOREIGN KEY (cancelled_by) REFERENCES core.persons(id) |
| `overtime_requests_decided_by_persons_id_fk` | Foreign key | FOREIGN KEY (decided_by) REFERENCES core.persons(id) |
| `overtime_requests_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `overtime_requests_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `overtime_requests_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `overtime_requests_requested_by_persons_id_fk` | Foreign key | FOREIGN KEY (requested_by) REFERENCES core.persons(id) |
| `overtime_requests_ticket_id_tickets_id_fk` | Foreign key | FOREIGN KEY (ticket_id) REFERENCES tickets.tickets(id) |
| `overtime_requests_decided_as_check` | Check | CHECK (((decided_as IS NULL) OR (decided_as = ANY (ARRAY['approver'::text, 'hr'::text, 'management'::text, 'no_approval_required'::text])))) |
| `overtime_requests_decided_fields` | Check | CHECK (((status <> ALL (ARRAY['approved'::text, 'rejected'::text])) OR ((decided_at IS NOT NULL) AND (decided_as IS NOT NULL)))) |
| `overtime_requests_decider_required` | Check | CHECK (((decided_as IS NULL) OR ((decided_as = 'no_approval_required'::text) = (decided_by IS NULL)))) |
| `overtime_requests_minutes_check` | Check | CHECK (((minutes >= 1) AND (minutes <= 1440))) |
| `overtime_requests_not_own_approver` | Check | CHECK (((approver_person_id IS NULL) OR ((approver_person_id <> person_id) AND (approver_person_id <> requested_by)))) |
| `overtime_requests_not_own_decision` | Check | CHECK (((decided_by IS NULL) OR ((decided_by <> person_id) AND (decided_by <> requested_by)))) |
| `overtime_requests_reason_length` | Check | CHECK ((char_length(reason) >= 3)) |
| `overtime_requests_rejected_has_reason` | Check | CHECK (((status <> 'rejected'::text) OR (decision_reason IS NOT NULL))) |
| `overtime_requests_status_check` | Check | CHECK ((status = ANY (ARRAY['submitted'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text]))) |

Indexes: `idx_overtime_approver`: btree (approver_person_id, status); `idx_overtime_employment_date`: btree (employment_id, work_date)

### hrms.person_private

A person's private details. Returned masked; shown in full only by a reveal, which is audited. Never logged.

Defined in `src/modules/hrms/people/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `person_id` | bigint | no |  |  |
| `tenant_id` | bigint | no |  |  |
| `aadhaar` | text | yes |  |  |
| `pan` | text | yes |  |  |
| `updated_by` | bigint | no |  |  |
| `updated_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `person_private_pkey` | Primary key | PRIMARY KEY (person_id) |
| `person_private_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `person_private_updated_by_persons_id_fk` | Foreign key | FOREIGN KEY (updated_by) REFERENCES core.persons(id) |
| `person_private_aadhaar_format` | Check | CHECK (((aadhaar IS NULL) OR (aadhaar ~ '^[0-9]{12}$'::text))) |
| `person_private_pan_format` | Check | CHECK (((pan IS NULL) OR (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'::text))) |

### hrms.person_skills

A person's skill and level. Verified by someone else (never themselves).

Defined in `src/modules/hrms/skills/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `person_id` | bigint | no |  |  |
| `skill_id` | bigint | no |  |  |
| `level` | text | no |  |  |
| `verified_by` | bigint | yes |  |  |
| `verified_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `person_skills_pkey` | Primary key | PRIMARY KEY (id) |
| `person_skills_person_skill_unique` | Unique | UNIQUE (person_id, skill_id) |
| `person_skills_public_id_unique` | Unique | UNIQUE (public_id) |
| `person_skills_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `person_skills_skill_id_skills_id_fk` | Foreign key | FOREIGN KEY (skill_id) REFERENCES hrms.skills(id) |
| `person_skills_verified_by_persons_id_fk` | Foreign key | FOREIGN KEY (verified_by) REFERENCES core.persons(id) |
| `person_skills_level_check` | Check | CHECK ((level = ANY (ARRAY['trainee'::text, 'skilled'::text, 'expert'::text]))) |
| `person_skills_not_self_verified` | Check | CHECK (((verified_by IS NULL) OR (verified_by <> person_id))) |
| `person_skills_verified_together` | Check | CHECK (((verified_by IS NULL) = (verified_at IS NULL))) |

### hrms.positions

A planned or open job in a department; filled by the employment of the person hired.

Defined in `src/modules/hrms/people/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `department_id` | bigint | no |  |  |
| `designation_id` | bigint | no |  |  |
| `status` | text | no | `'planned'` |  |
| `notes` | text | yes |  |  |
| `filled_by_employment_id` | bigint | yes |  |  |
| `filled_at` | timestamp with time zone | yes |  |  |
| `created_by` | bigint | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `positions_pkey` | Primary key | PRIMARY KEY (id) |
| `positions_public_id_unique` | Unique | UNIQUE (public_id) |
| `positions_created_by_persons_id_fk` | Foreign key | FOREIGN KEY (created_by) REFERENCES core.persons(id) |
| `positions_department_company_fk` | Foreign key | FOREIGN KEY (department_id, legal_entity_id) REFERENCES hrms.departments(id, legal_entity_id) |
| `positions_designation_company_fk` | Foreign key | FOREIGN KEY (designation_id, legal_entity_id) REFERENCES hrms.designations(id, legal_entity_id) |
| `positions_employment_company_fk` | Foreign key | FOREIGN KEY (filled_by_employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `positions_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `positions_filled_has_employment` | Check | CHECK (((status = 'filled'::text) = (filled_by_employment_id IS NOT NULL))) |
| `positions_status_check` | Check | CHECK ((status = ANY (ARRAY['planned'::text, 'open'::text, 'filled'::text]))) |

Indexes: `idx_positions_company_status`: btree (legal_entity_id, status)

### hrms.skills

A company's skills list, grouped by department (department optional).

Defined in `src/modules/hrms/skills/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `code` | text | no |  |  |
| `name` | text | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `legal_entity_id` | bigint | no |  |  |
| `department_id` | bigint | yes |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `skills_pkey` | Primary key | PRIMARY KEY (id) |
| `skills_company_code_unique` | Unique | UNIQUE (legal_entity_id, code) |
| `skills_id_company_unique` | Unique | UNIQUE (id, legal_entity_id) |
| `skills_public_id_unique` | Unique | UNIQUE (public_id) |
| `skills_department_company_fk` | Foreign key | FOREIGN KEY (department_id, legal_entity_id) REFERENCES hrms.departments(id, legal_entity_id) |
| `skills_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |

### hrms.weekly_off_rules

Weekly offs of a company: its default (no employment_id) or one person's override (employment_id), valid over a date range. The override wins. Rules of the same company, or of the same job, never overlap (exclusion constraints, migration 0008).

Defined in `src/modules/hrms/calendar/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `employment_id` | bigint | yes |  | set: one person's override (of a job in that company) |
| `valid_from` | date | no |  |  |
| `valid_to` | date | yes |  |  |
| `rule` | jsonb | no |  |  |
| `created_by` | bigint | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `weekly_off_rules_pkey` | Primary key | PRIMARY KEY (id) |
| `weekly_off_rules_public_id_unique` | Unique | UNIQUE (public_id) |
| `weekly_off_rules_created_by_persons_id_fk` | Foreign key | FOREIGN KEY (created_by) REFERENCES core.persons(id) |
| `weekly_off_rules_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `weekly_off_rules_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `weekly_off_rules_dates` | Check | CHECK (((valid_to IS NULL) OR (valid_to >= valid_from))) |
| `weekly_off_rules_rule_object` | Check | CHECK ((jsonb_typeof(rule) = 'object'::text)) |

Indexes: `idx_weekly_off_rules_employment`: btree (employment_id)

### hrms.work_days

One calculated row per job per date (IST), rebuilt from punches. A locked day never changes (trigger).

Defined in `src/modules/hrms/attendance/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `person_id` | bigint | no |  |  |
| `work_date` | date | no |  |  |
| `worked_minutes` | integer | no | `0` |  |
| `day_status` | text | no |  |  |
| `locked_for_payroll` | boolean | no | `false` |  |
| `employment_id` | bigint | no |  |  |
| `first_in` | timestamp with time zone | yes |  |  |
| `last_out` | timestamp with time zone | yes |  |  |
| `updated_at` | timestamp with time zone | no | `now()` |  |
| `leave_days` | numeric(2,1) | no | `'0'` | 0, 0.5 or 1 |
| `absent_days` | numeric(2,1) | no | `'0'` | 0, 0.5 or 1 |
| `worked_on_leave` | boolean | no | `false` |  |
| `extra_minutes` | integer | no | `0` | worked beyond the full-day setting |
| `approved_overtime_minutes` | integer | no | `0` | approved requests, at most extra_minutes |
| `legal_entity_id` | bigint | no |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `work_days_pkey` | Primary key | PRIMARY KEY (id) |
| `work_days_employment_date_unique` | Unique | UNIQUE (employment_id, work_date) |
| `work_days_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `work_days_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `work_days_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `work_days_extra_check` | Check | CHECK ((((extra_minutes >= 0) AND (extra_minutes <= worked_minutes)) AND ((approved_overtime_minutes >= 0) AND (approved_overtime_minutes <= extra_minutes)))) |
| `work_days_leave_absent_check` | Check | CHECK (((leave_days = ANY (ARRAY[(0)::numeric, 0.5, (1)::numeric])) AND (absent_days = ANY (ARRAY[(0)::numeric, 0.5, (1)::numeric])) AND ((leave_days + absent_days) <= (1)::numeric))) |
| `work_days_minutes_check` | Check | CHECK (((worked_minutes >= 0) AND (worked_minutes <= 1440))) |
| `work_days_status_check` | Check | CHECK ((day_status = ANY (ARRAY['present'::text, 'half_day'::text, 'absent'::text, 'leave'::text, 'holiday'::text, 'weekly_off'::text, 'missed_punch'::text]))) |

Indexes: `idx_work_days_person_date`: btree (person_id, work_date)

Triggers: `trg_locked_day` → `hrms.guard_locked_day()`; `trg_work_day_month_lock` → `hrms.guard_locked_month_day()` (see [connections.md](connections.md#triggers)).

## Schema `payroll`

### payroll.bank_accounts

Where a job's salary is paid, from a date. Never edited or deleted: a change is a new row. The account number is shown masked by the API and only appears in full in the bank upload file.

Defined in `src/modules/payroll/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `account_holder` | text | no |  |  |
| `account_number` | text | no |  |  |
| `ifsc` | text | no |  |  |
| `effective_from` | date | no |  |  |
| `created_by` | bigint | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `bank_accounts_pkey` | Primary key | PRIMARY KEY (id) |
| `bank_accounts_employment_from_unique` | Unique | UNIQUE (employment_id, effective_from) |
| `bank_accounts_public_id_unique` | Unique | UNIQUE (public_id) |
| `bank_accounts_created_by_persons_id_fk` | Foreign key | FOREIGN KEY (created_by) REFERENCES core.persons(id) |
| `bank_accounts_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `bank_accounts_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `bank_accounts_ifsc_format` | Check | CHECK ((ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'::text)) |
| `bank_accounts_number_format` | Check | CHECK ((account_number ~ '^[0-9]{6,18}$'::text)) |

Triggers: `trg_bank_accounts_append_only` → `payroll.forbid_change()` (see [connections.md](connections.md#triggers)).

### payroll.payroll_adjustments

An addition (bonus …) or deduction (PT, TDS, ESI, advance …) on one person's pay; only while the run is a draft.

Defined in `src/modules/payroll/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  |  |
| `item_id` | bigint | no |  |  |
| `kind` | text | no |  |  |
| `label` | text | no |  |  |
| `amount_paise` | bigint | no |  |  |
| `currency` | char(3) | no | `'INR'` |  |
| `note` | text | yes |  |  |
| `created_by` | bigint | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `payroll_adjustments_pkey` | Primary key | PRIMARY KEY (id) |
| `payroll_adjustments_public_id_unique` | Unique | UNIQUE (public_id) |
| `payroll_adjustments_created_by_persons_id_fk` | Foreign key | FOREIGN KEY (created_by) REFERENCES core.persons(id) |
| `payroll_adjustments_item_id_payroll_items_id_fk` | Foreign key | FOREIGN KEY (item_id) REFERENCES payroll.payroll_items(id) |
| `payroll_adjustments_amount_positive` | Check | CHECK ((amount_paise > 0)) |
| `payroll_adjustments_kind_check` | Check | CHECK ((kind = ANY (ARRAY['addition'::text, 'deduction'::text]))) |

Indexes: `idx_payroll_adjustments_item`: btree (item_id)

Triggers: `trg_payroll_adjustments_draft` → `payroll.guard_draft_adjustment()` (see [connections.md](connections.md#triggers)).

### payroll.payroll_items

One person's pay in a run (all amounts in paise). Changes only while the run is a draft (trigger).

Defined in `src/modules/payroll/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `run_id` | bigint | no |  |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `currency` | char(3) | no | `'INR'` |  |
| `monthly_salary_paise` | bigint | no |  |  |
| `days_in_month` | integer | no |  |  |
| `employed_days` | integer | no |  |  |
| `absent_days` | numeric(4,1) | no |  |  |
| `lop_amount_paise` | bigint | no |  |  |
| `salary_for_month_paise` | bigint | no |  |  |
| `additions_total_paise` | bigint | no | `0` |  |
| `deductions_total_paise` | bigint | no | `0` |  |
| `net_pay_paise` | bigint | no |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `payroll_items_pkey` | Primary key | PRIMARY KEY (id) |
| `payroll_items_public_id_unique` | Unique | UNIQUE (public_id) |
| `payroll_items_run_employment_unique` | Unique | UNIQUE (run_id, employment_id) |
| `payroll_items_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `payroll_items_run_company_fk` | Foreign key | FOREIGN KEY (run_id, legal_entity_id) REFERENCES payroll.payroll_runs(id, legal_entity_id) |
| `payroll_items_amounts_check` | Check | CHECK (((monthly_salary_paise > 0) AND (lop_amount_paise >= 0) AND (salary_for_month_paise >= 0) AND (additions_total_paise >= 0) AND (deductions_total_paise >= 0) AND (absent_days >= (0)::numeric))) |
| `payroll_items_net_check` | Check | CHECK (((net_pay_paise = ((salary_for_month_paise + additions_total_paise) - deductions_total_paise)) AND (net_pay_paise >= 0))) |

Triggers: `trg_payroll_items_draft` → `payroll.guard_draft_item()` (see [connections.md](connections.md#triggers)).

### payroll.payroll_runs

One payroll per company per month: draft (recalculate and adjust freely) → approved (frozen) → paid. Approved by someone other than whoever prepared it last. After approval only "paid" may be recorded (trigger).

Defined in `src/modules/payroll/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `legal_entity_id` | bigint | no |  |  |
| `year` | integer | no |  |  |
| `month` | integer | no |  |  |
| `status` | text | no | `'draft'` |  |
| `currency` | char(3) | no | `'INR'` |  |
| `prepared_by` | bigint | no |  |  |
| `prepared_at` | timestamp with time zone | no | `now()` |  |
| `approved_by` | bigint | yes |  |  |
| `approved_at` | timestamp with time zone | yes |  |  |
| `paid_at` | timestamp with time zone | yes |  |  |
| `bank_ref` | text | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `payroll_runs_pkey` | Primary key | PRIMARY KEY (id) |
| `payroll_runs_company_month_unique` | Unique | UNIQUE (legal_entity_id, year, month) |
| `payroll_runs_id_company_unique` | Unique | UNIQUE (id, legal_entity_id) |
| `payroll_runs_public_id_unique` | Unique | UNIQUE (public_id) |
| `payroll_runs_approved_by_persons_id_fk` | Foreign key | FOREIGN KEY (approved_by) REFERENCES core.persons(id) |
| `payroll_runs_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `payroll_runs_prepared_by_persons_id_fk` | Foreign key | FOREIGN KEY (prepared_by) REFERENCES core.persons(id) |
| `payroll_runs_approved_fields` | Check | CHECK (((status = 'draft'::text) = ((approved_by IS NULL) AND (approved_at IS NULL)))) |
| `payroll_runs_month_check` | Check | CHECK ((((month >= 1) AND (month <= 12)) AND ((year >= 2000) AND (year <= 2100)))) |
| `payroll_runs_not_own_approval` | Check | CHECK (((approved_by IS NULL) OR (approved_by <> prepared_by))) |
| `payroll_runs_paid_fields` | Check | CHECK (((status = 'paid'::text) = ((paid_at IS NOT NULL) AND (bank_ref IS NOT NULL)))) |
| `payroll_runs_status_check` | Check | CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'paid'::text]))) |

Triggers: `trg_payroll_runs_frozen` → `payroll.guard_run()` (see [connections.md](connections.md#triggers)).

### payroll.salaries

A job's fixed monthly salary from a date. Never edited or deleted (trigger, migration 0020): a change is a new row.

Defined in `src/modules/payroll/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `monthly_amount_paise` | bigint | no |  |  |
| `currency` | char(3) | no | `'INR'` |  |
| `effective_from` | date | no |  |  |
| `note` | text | yes |  |  |
| `created_by` | bigint | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `salaries_pkey` | Primary key | PRIMARY KEY (id) |
| `salaries_employment_from_unique` | Unique | UNIQUE (employment_id, effective_from) |
| `salaries_public_id_unique` | Unique | UNIQUE (public_id) |
| `salaries_created_by_persons_id_fk` | Foreign key | FOREIGN KEY (created_by) REFERENCES core.persons(id) |
| `salaries_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `salaries_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `salaries_amount_positive` | Check | CHECK ((monthly_amount_paise > 0)) |

Triggers: `trg_salaries_append_only` → `payroll.forbid_change()` (see [connections.md](connections.md#triggers)).

## Schema `tickets`

### tickets.number_series

A company's ticket numbers: PREFIX-0001 … HR sets the prefix and the next number (e.g. after importing Froid tickets).

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `prefix` | text | no |  |  |
| `next_number` | integer | no | `1` |  |
| `updated_by` | bigint | yes |  |  |
| `updated_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `number_series_pkey` | Primary key | PRIMARY KEY (id) |
| `number_series_legal_entity_id_unique` | Unique | UNIQUE (legal_entity_id) |
| `number_series_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `number_series_updated_by_persons_id_fk` | Foreign key | FOREIGN KEY (updated_by) REFERENCES core.persons(id) |
| `number_series_next_positive` | Check | CHECK ((next_number >= 1)) |
| `number_series_prefix_format` | Check | CHECK ((prefix ~ '^[A-Z0-9]{1,10}$'::text)) |

### tickets.reassign_requests

An assignee asks to be taken off a ticket; the approver (the ticket's supervisor, or the next approver when the supervisor is the one asking) picks who takes over. Never decided by the person who asked.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `ticket_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `from_employment_id` | bigint | no |  |  |
| `requested_by` | bigint | no |  |  |
| `reason` | text | no |  |  |
| `approver_person_id` | bigint | yes |  |  |
| `status` | text | no | `'pending'` |  |
| `new_employment_id` | bigint | yes |  |  |
| `decided_by` | bigint | yes |  |  |
| `decided_as` | text | yes |  |  |
| `decided_at` | timestamp with time zone | yes |  |  |
| `decision_reason` | text | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `reassign_requests_pkey` | Primary key | PRIMARY KEY (id) |
| `reassign_requests_public_id_unique` | Unique | UNIQUE (public_id) |
| `reassign_requests_approver_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (approver_person_id) REFERENCES core.persons(id) |
| `reassign_requests_decided_by_persons_id_fk` | Foreign key | FOREIGN KEY (decided_by) REFERENCES core.persons(id) |
| `reassign_requests_from_company_fk` | Foreign key | FOREIGN KEY (from_employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `reassign_requests_new_company_fk` | Foreign key | FOREIGN KEY (new_employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `reassign_requests_requested_by_persons_id_fk` | Foreign key | FOREIGN KEY (requested_by) REFERENCES core.persons(id) |
| `reassign_requests_ticket_company_fk` | Foreign key | FOREIGN KEY (ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |
| `reassign_requests_approved_has_person` | Check | CHECK (((status <> 'approved'::text) OR (new_employment_id IS NOT NULL))) |
| `reassign_requests_decided_as_check` | Check | CHECK (((decided_as IS NULL) OR (decided_as = ANY (ARRAY['approver'::text, 'management'::text])))) |
| `reassign_requests_decided_fields` | Check | CHECK (((status = 'pending'::text) = ((decided_at IS NULL) AND (decided_by IS NULL) AND (decided_as IS NULL)))) |
| `reassign_requests_not_own_approver` | Check | CHECK (((approver_person_id IS NULL) OR (approver_person_id <> requested_by))) |
| `reassign_requests_not_own_decision` | Check | CHECK (((decided_by IS NULL) OR (decided_by <> requested_by))) |
| `reassign_requests_rejected_has_reason` | Check | CHECK (((status <> 'rejected'::text) OR (decision_reason IS NOT NULL))) |
| `reassign_requests_status_check` | Check | CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))) |

Indexes: `idx_reassign_requests_approver`: btree (approver_person_id, status); `reassign_requests_one_pending`: unique btree (ticket_id, from_employment_id) WHERE (status = 'pending'::text)

Triggers: `trg_reassign_requests_never_deleted` → `tickets.forbid_delete()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_assignees

Who works on a ticket. Taking someone off sets ended_at (never deleted). Among the current assignees exactly one is primary (unique index + a deferred check in migration 0023).

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `ticket_id` | bigint | no |  |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `is_primary` | boolean | no | `false` |  |
| `assigned_by` | bigint | no |  |  |
| `assigned_at` | timestamp with time zone | no | `now()` |  |
| `ended_by` | bigint | yes |  |  |
| `ended_at` | timestamp with time zone | yes |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_assignees_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_assignees_assigned_by_persons_id_fk` | Foreign key | FOREIGN KEY (assigned_by) REFERENCES core.persons(id) |
| `ticket_assignees_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `ticket_assignees_ended_by_persons_id_fk` | Foreign key | FOREIGN KEY (ended_by) REFERENCES core.persons(id) |
| `ticket_assignees_ticket_company_fk` | Foreign key | FOREIGN KEY (ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |
| `ticket_assignees_ended_fields` | Check | CHECK (((ended_by IS NULL) = (ended_at IS NULL))) |

Indexes: `idx_ticket_assignees_employment`: btree (employment_id); `ticket_assignees_one_current`: unique btree (ticket_id, employment_id) WHERE (ended_at IS NULL); `ticket_assignees_one_primary`: unique btree (ticket_id) WHERE (is_primary AND (ended_at IS NULL))

Triggers: `trg_ticket_assignees_never_deleted` → `tickets.forbid_delete()`; `trg_ticket_assignees_one_primary` → `tickets.check_one_primary()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_attachments

A photo, file or signed sheet on a ticket. The file lives under uploads/; only its relative path is stored. Append-only. daily_update_id: sent with that daily update (same ticket).

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `ticket_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `kind` | text | no |  |  |
| `file_path` | text | no |  |  |
| `file_type` | text | no |  |  |
| `uploaded_by` | bigint | no |  |  |
| `uploaded_at` | timestamp with time zone | no | `now()` |  |
| `daily_update_id` | bigint | yes |  |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_attachments_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_attachments_id_ticket_unique` | Unique | UNIQUE (id, ticket_id) |
| `ticket_attachments_public_id_unique` | Unique | UNIQUE (public_id) |
| `ticket_attachments_daily_update_fk` | Foreign key | FOREIGN KEY (daily_update_id, ticket_id) REFERENCES tickets.ticket_daily_updates(id, ticket_id) |
| `ticket_attachments_ticket_company_fk` | Foreign key | FOREIGN KEY (ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |
| `ticket_attachments_uploaded_by_persons_id_fk` | Foreign key | FOREIGN KEY (uploaded_by) REFERENCES core.persons(id) |
| `ticket_attachments_kind_check` | Check | CHECK ((kind = ANY (ARRAY['photo'::text, 'file'::text, 'signoff'::text]))) |
| `ticket_attachments_type_check` | Check | CHECK ((file_type = ANY (ARRAY['jpg'::text, 'png'::text, 'pdf'::text]))) |

Indexes: `idx_ticket_attachments_ticket`: btree (ticket_id)

Triggers: `trg_ticket_attachments_append_only` → `tickets.forbid_change()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_checklist_results

A checklist answer. Append-only: answering again adds a row; the newest per item counts.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `ticket_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `item` | text | no |  |  |
| `result` | text | no |  |  |
| `note` | text | yes |  |  |
| `checked_by` | bigint | no |  |  |
| `checked_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_checklist_results_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_checklist_results_checked_by_persons_id_fk` | Foreign key | FOREIGN KEY (checked_by) REFERENCES core.persons(id) |
| `ticket_checklist_ticket_company_fk` | Foreign key | FOREIGN KEY (ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |
| `ticket_checklist_result_check` | Check | CHECK ((result = ANY (ARRAY['pass'::text, 'fail'::text, 'na'::text]))) |

Indexes: `idx_ticket_checklist_ticket`: btree (ticket_id)

Triggers: `trg_ticket_checklist_append_only` → `tickets.forbid_change()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_daily_updates

One person's daily update on a ticket: note and percent complete (photos / files are attachments pointing at it). Append-only.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `ticket_id` | bigint | no |  |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `work_date` | date | no |  |  |
| `note` | text | no |  |  |
| `percent_complete` | smallint | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_daily_updates_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_daily_updates_id_ticket_unique` | Unique | UNIQUE (id, ticket_id) |
| `ticket_daily_updates_one_per_day` | Unique | UNIQUE (ticket_id, employment_id, work_date) |
| `ticket_daily_updates_public_id_unique` | Unique | UNIQUE (public_id) |
| `ticket_daily_updates_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `ticket_daily_updates_ticket_company_fk` | Foreign key | FOREIGN KEY (ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |
| `ticket_daily_updates_note_length` | Check | CHECK (((length(note) >= 1) AND (length(note) <= 1000))) |
| `ticket_daily_updates_percent_check` | Check | CHECK (((percent_complete >= 0) AND (percent_complete <= 100))) |

Indexes: `idx_ticket_daily_updates_date`: btree (work_date)

Triggers: `trg_ticket_daily_updates_append_only` → `tickets.forbid_change()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_events

The ticket's timeline. Append-only (trigger). actor null: the system.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `ticket_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `actor_person_id` | bigint | yes |  |  |
| `action` | text | no |  |  |
| `details` | jsonb | yes |  |  |
| `at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_events_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_events_actor_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (actor_person_id) REFERENCES core.persons(id) |
| `ticket_events_ticket_company_fk` | Foreign key | FOREIGN KEY (ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |

Indexes: `idx_ticket_events_ticket`: btree (ticket_id, id)

Triggers: `trg_ticket_events_append_only` → `tickets.forbid_change()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_links

from_ticket follows / is rework of to_ticket. Both of the same company (both keys carry legal_entity_id). Append-only.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `from_ticket_id` | bigint | no |  |  |
| `to_ticket_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `kind` | text | no |  |  |
| `created_by` | bigint | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_links_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_links_unique` | Unique | UNIQUE (from_ticket_id, to_ticket_id, kind) |
| `ticket_links_created_by_persons_id_fk` | Foreign key | FOREIGN KEY (created_by) REFERENCES core.persons(id) |
| `ticket_links_from_company_fk` | Foreign key | FOREIGN KEY (from_ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |
| `ticket_links_to_company_fk` | Foreign key | FOREIGN KEY (to_ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |
| `ticket_links_kind_check` | Check | CHECK ((kind = ANY (ARRAY['follows'::text, 'rework_of'::text]))) |
| `ticket_links_not_self` | Check | CHECK ((from_ticket_id <> to_ticket_id)) |

Indexes: `idx_ticket_links_to`: btree (to_ticket_id)

Triggers: `trg_ticket_links_append_only` → `tickets.forbid_change()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_signoffs

The customer's sign-off: who signed, and the photo of the signed sheet (an attachment of the same ticket). Append-only.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `ticket_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `signer_name` | text | no |  |  |
| `signer_role` | text | yes |  |  |
| `signed_at` | timestamp with time zone | no |  |  |
| `photo_attachment_id` | bigint | no |  |  |
| `recorded_by` | bigint | no |  |  |
| `recorded_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_signoffs_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_signoffs_public_id_unique` | Unique | UNIQUE (public_id) |
| `ticket_signoffs_photo_same_ticket_fk` | Foreign key | FOREIGN KEY (photo_attachment_id, ticket_id) REFERENCES tickets.ticket_attachments(id, ticket_id) |
| `ticket_signoffs_recorded_by_persons_id_fk` | Foreign key | FOREIGN KEY (recorded_by) REFERENCES core.persons(id) |
| `ticket_signoffs_ticket_company_fk` | Foreign key | FOREIGN KEY (ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |

Triggers: `trg_ticket_signoffs_append_only` → `tickets.forbid_change()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_time_adjustments

A reviewer's change to a person's daily ticket time (+ or - minutes on one ticket), with a reason. The calculated allocation and the timelogs never change; the day's time is allocation + adjustments. Rows sent together share batch_id. Never by the person whose time it is. Append-only.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `batch_id` | uuid | no |  |  |
| `ticket_id` | bigint | no |  |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `person_id` | bigint | no |  |  |
| `work_date` | date | no |  |  |
| `minutes` | integer | no |  |  |
| `reason` | text | no |  |  |
| `adjusted_by` | bigint | no |  |  |
| `adjusted_as` | text | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_time_adjustments_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_time_adjustments_batch_ticket_unique` | Unique | UNIQUE (batch_id, ticket_id) |
| `ticket_time_adjustments_adjusted_by_persons_id_fk` | Foreign key | FOREIGN KEY (adjusted_by) REFERENCES core.persons(id) |
| `ticket_time_adjustments_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `ticket_time_adjustments_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `ticket_time_adjustments_ticket_company_fk` | Foreign key | FOREIGN KEY (ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |
| `ticket_time_adjustments_as_check` | Check | CHECK ((adjusted_as = ANY (ARRAY['head'::text, 'management'::text]))) |
| `ticket_time_adjustments_minutes_check` | Check | CHECK ((minutes <> 0)) |
| `ticket_time_adjustments_not_own` | Check | CHECK ((adjusted_by <> person_id)) |
| `ticket_time_adjustments_reason_check` | Check | CHECK ((length(TRIM(BOTH FROM reason)) >= 3)) |

Indexes: `idx_ticket_time_adjustments_person_date`: btree (person_id, work_date)

Triggers: `trg_ticket_time_adjustments_append_only` → `tickets.forbid_change()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_time_allocations

A person's calculated time on a ticket for one work day (IST date), in minutes: recalculated from the timelogs and the attended periods whenever either changes (policy tickets.time.split). Never more than the day's attendance in total.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `ticket_id` | bigint | no |  |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `person_id` | bigint | no |  |  |
| `work_date` | date | no |  |  |
| `minutes` | integer | no |  |  |
| `calculated_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_time_allocations_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_time_allocations_unique` | Unique | UNIQUE (ticket_id, employment_id, work_date) |
| `ticket_time_allocations_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `ticket_time_allocations_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (person_id) REFERENCES core.persons(id) |
| `ticket_time_allocations_ticket_company_fk` | Foreign key | FOREIGN KEY (ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |
| `ticket_time_allocations_minutes_check` | Check | CHECK ((minutes >= 0)) |

Indexes: `idx_ticket_time_allocations_person_date`: btree (person_id, work_date)

Triggers: `trg_ticket_time_allocations_never_deleted` → `tickets.forbid_delete()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_timelogs

Ticket punch: time a person (on one of their jobs) works on a ticket. Several may run at once. Append-only, except that an open log is closed once (ended_at, end_reason): manual (ticket punch-out), day_punch_out (the daily punch-out stopped it) or unfinished (the daily punch-in became a missed punch; counts no time). Trigger: migration 0024.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no |  |  |
| `ticket_id` | bigint | no |  |  |
| `employment_id` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `started_at` | timestamp with time zone | no |  |  |
| `ended_at` | timestamp with time zone | yes |  |  |
| `end_reason` | text | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |
| `place_id` | bigint | yes |  | where the ticket punch-in was made (address looked up by core) |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_timelogs_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_timelogs_public_id_unique` | Unique | UNIQUE (public_id) |
| `ticket_timelogs_employment_company_fk` | Foreign key | FOREIGN KEY (employment_id, legal_entity_id) REFERENCES hrms.employments(id, legal_entity_id) |
| `ticket_timelogs_place_id_places_id_fk` | Foreign key | FOREIGN KEY (place_id) REFERENCES core.places(id) |
| `ticket_timelogs_ticket_company_fk` | Foreign key | FOREIGN KEY (ticket_id, legal_entity_id) REFERENCES tickets.tickets(id, legal_entity_id) |
| `ticket_timelogs_end_after_start` | Check | CHECK (((ended_at IS NULL) OR (ended_at >= started_at))) |
| `ticket_timelogs_end_fields` | Check | CHECK (((ended_at IS NULL) = (end_reason IS NULL))) |
| `ticket_timelogs_end_reason_check` | Check | CHECK (((end_reason IS NULL) OR (end_reason = ANY (ARRAY['manual'::text, 'day_punch_out'::text, 'unfinished'::text])))) |

Indexes: `idx_ticket_timelogs_employment`: btree (employment_id, started_at); `ticket_timelogs_one_running`: unique btree (ticket_id, employment_id) WHERE (ended_at IS NULL)

Triggers: `trg_ticket_timelogs_close_only` → `tickets.guard_timelog()` (see [connections.md](connections.md#triggers)).

### tickets.ticket_types

A kind of ticket a company works with. One row per saved VERSION: `public_id` is the type's id (the same on every version), (public_id, version) is unique, and exactly one version is current. Editing adds a row; old versions stay (a trigger in migration 0022 refuses deletes and any change but active / is_current). Types are deactivated, never deleted. `active` is kept on the current version only. Name and code are unique per company among current versions.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `version` | integer | no | `1` |  |
| `is_current` | boolean | no | `true` |  |
| `legal_entity_id` | bigint | no |  |  |
| `code` | text | no |  |  |
| `name` | text | no |  |  |
| `owner_department_id` | bigint | yes |  | null: company-wide (managed by admin and Management only) |
| `is_standard` | boolean | no | `false` |  |
| `active` | boolean | no | `true` |  |
| `sort_order` | integer | no | `100` |  |
| `fields` | jsonb | no | `'[]'` |  |
| `completion_rules` | jsonb | no | `'{}'` |  |
| `checklist_items` | jsonb | no | `'[]'` |  |
| `created_by` | bigint | no |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `ticket_types_pkey` | Primary key | PRIMARY KEY (id) |
| `ticket_types_id_company_unique` | Unique | UNIQUE (id, legal_entity_id) |
| `ticket_types_id_version_company_unique` | Unique | UNIQUE (id, version, legal_entity_id) |
| `ticket_types_public_version_unique` | Unique | UNIQUE (public_id, version) |
| `ticket_types_created_by_persons_id_fk` | Foreign key | FOREIGN KEY (created_by) REFERENCES core.persons(id) |
| `ticket_types_department_company_fk` | Foreign key | FOREIGN KEY (owner_department_id, legal_entity_id) REFERENCES hrms.departments(id, legal_entity_id) |
| `ticket_types_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `ticket_types_code_format` | Check | CHECK ((code ~ '^[a-z][a-z0-9_]{1,39}$'::text)) |
| `ticket_types_json_shapes` | Check | CHECK (((jsonb_typeof(fields) = 'array'::text) AND (jsonb_typeof(completion_rules) = 'object'::text) AND (jsonb_typeof(checklist_items) = 'array'::text))) |
| `ticket_types_version_check` | Check | CHECK ((version >= 1)) |

Indexes: `ticket_types_company_code_unique`: unique btree (legal_entity_id, code) WHERE is_current; `ticket_types_company_name_unique`: unique btree (legal_entity_id, lower(name)) WHERE is_current; `ticket_types_one_current`: unique btree (public_id) WHERE is_current

Triggers: `trg_ticket_types_versions_kept` → `tickets.guard_ticket_type()` (see [connections.md](connections.md#triggers)).

### tickets.tickets

A piece of work. Uses one saved version of its type (type_id is that version's row), so later edits of the type never change it. Never deleted: cancelled instead. Every change also writes a ticket_event.

Defined in `src/modules/tickets/schema.ts`.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identity |  |
| `tenant_id` | bigint | no |  |  |
| `public_id` | uuid | no | `gen_random_uuid()` |  |
| `number` | text | no |  |  |
| `priority` | smallint | no | `3` |  |
| `status` | text | no | `'open'` |  |
| `scheduled_at` | timestamp with time zone | no |  |  |
| `description` | text | yes |  |  |
| `created_by` | bigint | no |  |  |
| `legal_entity_id` | bigint | no |  |  |
| `type_id` | bigint | no |  |  |
| `type_version` | integer | no |  |  |
| `type_details` | jsonb | no | `'{}'` |  |
| `title` | text | no |  |  |
| `customer_id` | uuid | yes |  | the customer's public id; its foreign key comes with the customer register (Sales) |
| `site` | text | yes |  |  |
| `project_id` | bigint | yes |  | projects come later |
| `department_id` | bigint | no |  |  |
| `supervisor_person_id` | bigint | no |  |  |
| `required_skill_id` | bigint | yes |  |  |
| `due_date` | date | yes |  |  |
| `hold_reason` | text | yes |  |  |
| `cancel_reason` | text | yes |  |  |
| `completed_at` | timestamp with time zone | yes |  |  |
| `head_approved_by` | bigint | yes |  |  |
| `head_approved_at` | timestamp with time zone | yes |  |  |
| `created_at` | timestamp with time zone | no | `now()` |  |

| Constraint | Kind | Definition |
| --- | --- | --- |
| `tickets_pkey` | Primary key | PRIMARY KEY (id) |
| `tickets_company_number_unique` | Unique | UNIQUE (legal_entity_id, number) |
| `tickets_id_company_unique` | Unique | UNIQUE (id, legal_entity_id) |
| `tickets_public_id_unique` | Unique | UNIQUE (public_id) |
| `tickets_created_by_persons_id_fk` | Foreign key | FOREIGN KEY (created_by) REFERENCES core.persons(id) |
| `tickets_department_company_fk` | Foreign key | FOREIGN KEY (department_id, legal_entity_id) REFERENCES hrms.departments(id, legal_entity_id) |
| `tickets_head_approved_by_persons_id_fk` | Foreign key | FOREIGN KEY (head_approved_by) REFERENCES core.persons(id) |
| `tickets_legal_entity_id_legal_entities_id_fk` | Foreign key | FOREIGN KEY (legal_entity_id) REFERENCES core.legal_entities(id) |
| `tickets_skill_company_fk` | Foreign key | FOREIGN KEY (required_skill_id, legal_entity_id) REFERENCES hrms.skills(id, legal_entity_id) |
| `tickets_supervisor_person_id_persons_id_fk` | Foreign key | FOREIGN KEY (supervisor_person_id) REFERENCES core.persons(id) |
| `tickets_type_version_company_fk` | Foreign key | FOREIGN KEY (type_id, type_version, legal_entity_id) REFERENCES tickets.ticket_types(id, version, legal_entity_id) |
| `tickets_cancel_has_reason` | Check | CHECK (((status <> 'cancelled'::text) OR (cancel_reason IS NOT NULL))) |
| `tickets_completed_fields` | Check | CHECK (((status = 'completed'::text) = (completed_at IS NOT NULL))) |
| `tickets_description_length` | Check | CHECK (((description IS NULL) OR (length(description) <= 1000))) |
| `tickets_details_object` | Check | CHECK ((jsonb_typeof(type_details) = 'object'::text)) |
| `tickets_head_approval_fields` | Check | CHECK (((head_approved_by IS NULL) = (head_approved_at IS NULL))) |
| `tickets_hold_has_reason` | Check | CHECK (((status <> 'on_hold'::text) OR (hold_reason IS NOT NULL))) |
| `tickets_priority_check` | Check | CHECK (((priority >= 1) AND (priority <= 5))) |
| `tickets_status_check` | Check | CHECK ((status = ANY (ARRAY['open'::text, 'assigned'::text, 'in_progress'::text, 'on_hold'::text, 'completed'::text, 'cancelled'::text]))) |

Indexes: `idx_tickets_company_status`: btree (legal_entity_id, status); `idx_tickets_department`: btree (department_id)

Triggers: `trg_tickets_never_deleted` → `tickets.forbid_delete()` (see [connections.md](connections.md#triggers)).
