-- =====================================================================
-- AGELESS PLATFORM · DATABASE · PART 1: CORE (shared foundation)
-- PostgreSQL 16. One database, one schema per module.
-- Conventions
--   id          bigint identity, used for joins and foreign keys
--   public_id   uuid (UUIDv7 made by the app; random default as fallback),
--               used in APIs, events, files and links between systems
--   tenant_id   on every table; row-level security keeps tenants apart
--   money       bigint paise; times timestamptz (UTC), shown in IST
--   history     ledgers and logs are append-only (trigger blocks edits)
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA core;

CREATE FUNCTION core.forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '%.% is append-only: % not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP USING ERRCODE='restrict_violation'; END $$;
CREATE FUNCTION core.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------- tenants and organisation ----------
CREATE TABLE core.tenants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name text NOT NULL, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE core.legal_entities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  code varchar(12) NOT NULL, name text NOT NULL,
  legal_form text NOT NULL CHECK (legal_form IN ('partnership','private_limited','llp','proprietorship','other')),
  pan varchar(10), UNIQUE (tenant_id, code));

CREATE TABLE core.branches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  legal_entity_id bigint NOT NULL REFERENCES core.legal_entities(id),
  code varchar(20) NOT NULL, name text NOT NULL, state_code char(2) NOT NULL,
  gstin char(15), address text, is_active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code));

CREATE TABLE core.departments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  code varchar(20) NOT NULL, name text NOT NULL,
  parent_id bigint REFERENCES core.departments(id),
  kind text NOT NULL DEFAULT 'department' CHECK (kind IN ('department','resource_group')),
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));

-- Places people work and machines stand: offices, workshops, parks, customer sites
CREATE TABLE core.locations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  branch_id bigint REFERENCES core.branches(id),
  customer_id bigint,                                  -- FK added below (customer sites)
  type text NOT NULL CHECK (type IN ('office','workshop','store','park','customer_site','other')),
  code varchar(30) NOT NULL, name text NOT NULL, address text, state_code char(2),
  latitude numeric(9,6), longitude numeric(9,6),
  punch_radius_m integer CHECK (punch_radius_m > 0),
  route_id bigint,                                     -- FK added below
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (type <> 'customer_site' OR customer_id IS NOT NULL));

CREATE TABLE core.routes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  branch_id bigint REFERENCES core.branches(id),
  code varchar(20) NOT NULL, name text NOT NULL, UNIQUE (tenant_id, code));
ALTER TABLE core.locations ADD FOREIGN KEY (route_id) REFERENCES core.routes(id);

-- ---------- parties: customers, suppliers, contractor companies ----------
CREATE TABLE core.parties (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  name text NOT NULL,
  roles text[] NOT NULL CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['customer','supplier','contractor','consultant','outside_workshop']::text[]),
  gstin char(15), pan varchar(10), state_code char(2), phone text, email text,
  source_system text, source_ref text,                 -- e.g. 'froid', for imports
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','archived')),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX uq_party_source ON core.parties(tenant_id, source_system, source_ref) WHERE source_ref IS NOT NULL;
ALTER TABLE core.locations ADD FOREIGN KEY (customer_id) REFERENCES core.parties(id);

-- ---------- people: one record per human ----------
CREATE TABLE core.persons (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  person_type text NOT NULL CHECK (person_type IN ('employee','external_worker','contractor_staff')),
  contractor_party_id bigint REFERENCES core.parties(id), -- the contractor company for contractor_staff
  display_name text NOT NULL,                            -- 'Vishnu (Design)' style when names repeat
  full_name text NOT NULL,
  work_email text, mobile text,
  photo_file_id bigint,                                  -- FK added below
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','exited')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (person_type <> 'contractor_staff' OR contractor_party_id IS NOT NULL));
CREATE UNIQUE INDEX uq_person_mobile ON core.persons(tenant_id, mobile) WHERE mobile IS NOT NULL;
CREATE TRIGGER trg_person_touch BEFORE UPDATE ON core.persons FOR EACH ROW EXECUTE FUNCTION core.touch();

CREATE TABLE core.users (                               -- a login; not every person has one
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  person_id bigint NOT NULL UNIQUE REFERENCES core.persons(id),
  username varchar(60) NOT NULL, password_hash text, mfa_enabled boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true, last_login_at timestamptz,
  UNIQUE (tenant_id, username));

CREATE TABLE core.roles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  code varchar(40) NOT NULL, name text NOT NULL, UNIQUE (tenant_id, code));
CREATE TABLE core.permissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code varchar(80) NOT NULL UNIQUE, module text NOT NULL);       -- e.g. hrms.leave.approve
CREATE TABLE core.role_permissions (
  role_id bigint NOT NULL REFERENCES core.roles(id),
  permission_id bigint NOT NULL REFERENCES core.permissions(id),
  PRIMARY KEY (role_id, permission_id));
CREATE TABLE core.role_assignments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  role_id bigint NOT NULL REFERENCES core.roles(id),
  scope text NOT NULL CHECK (scope IN ('own','team','branch','department','all')),
  branch_id bigint REFERENCES core.branches(id), department_id bigint REFERENCES core.departments(id),
  valid_from date NOT NULL, valid_to date,
  granted_by bigint NOT NULL REFERENCES core.persons(id),
  CHECK (granted_by <> person_id), CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (scope <> 'branch' OR branch_id IS NOT NULL), CHECK (scope <> 'department' OR department_id IS NOT NULL));

-- ---------- files and audit ----------
CREATE TABLE core.files (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  storage_key text NOT NULL UNIQUE, mime_type text NOT NULL, size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 bytea NOT NULL, purpose text NOT NULL,          -- receipt, certificate, ticket_photo, id_proof ...
  is_private boolean NOT NULL DEFAULT false,
  uploaded_by bigint NOT NULL REFERENCES core.persons(id), uploaded_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE core.persons ADD FOREIGN KEY (photo_file_id) REFERENCES core.files(id);

CREATE TABLE core.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  actor_person_id bigint REFERENCES core.persons(id),
  module text NOT NULL, action text NOT NULL, record_type text, record_public_id uuid,
  changes jsonb, via text NOT NULL DEFAULT 'web' CHECK (via IN ('web','app','api','ai','system','import')),
  at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER trg_audit_append BEFORE UPDATE OR DELETE ON core.audit_events FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

-- ---------- settings and policies (versioned, effective-dated) ----------
CREATE TABLE core.policies (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  policy_key text NOT NULL,                              -- hrms.leave.entitlement, hrms.attendance.grace ...
  scope text NOT NULL DEFAULT 'company' CHECK (scope IN ('company','legal_entity','branch','department','employment_type','grade')),
  scope_ref text,                                        -- id or code of the scope, null for company
  version integer NOT NULL CHECK (version > 0),
  effective_from date NOT NULL, value jsonb NOT NULL,
  approved_by bigint REFERENCES core.persons(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, policy_key, scope, scope_ref, version),
  CHECK ((scope = 'company') = (scope_ref IS NULL)));
CREATE TRIGGER trg_policy_append BEFORE UPDATE OR DELETE ON core.policies FOR EACH ROW EXECUTE FUNCTION core.forbid_change();
-- The rule in force on a date: newest version with effective_from <= date, most specific scope first (done in the service).

-- ---------- approvals (shared by every module) ----------
CREATE TABLE core.approval_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  module text NOT NULL, request_type text NOT NULL,      -- hrms.leave, hrms.expense, tickets.reassign ...
  subject_public_id uuid NOT NULL, round smallint NOT NULL DEFAULT 1,
  amount_paise bigint CHECK (amount_paise >= 0),
  requested_by bigint NOT NULL REFERENCES core.persons(id),
  approver_person_id bigint REFERENCES core.persons(id), -- resolved by rule (manager, supervisor, HR)
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
  UNIQUE (tenant_id, request_type, subject_public_id, round),
  CHECK (approver_person_id IS NULL OR approver_person_id <> requested_by));
CREATE UNIQUE INDEX uq_one_pending ON core.approval_requests(tenant_id, request_type, subject_public_id) WHERE status = 'pending';

CREATE TABLE core.approval_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  approval_request_id bigint NOT NULL REFERENCES core.approval_requests(id),
  decided_by bigint NOT NULL REFERENCES core.persons(id),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason text, decided_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decision = 'approved' OR reason IS NOT NULL));
CREATE FUNCTION core.check_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r core.approval_requests;
BEGIN
  SELECT * INTO r FROM core.approval_requests WHERE id = NEW.approval_request_id FOR UPDATE;
  IF r.requested_by = NEW.decided_by THEN RAISE EXCEPTION 'nobody can decide their own request'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'request is already %', r.status; END IF;
  UPDATE core.approval_requests SET status = NEW.decision, decided_at = NEW.decided_at WHERE id = r.id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_decision BEFORE INSERT ON core.approval_decisions FOR EACH ROW EXECUTE FUNCTION core.check_decision();
CREATE TRIGGER trg_decision_append BEFORE UPDATE OR DELETE ON core.approval_decisions FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

-- ---------- document numbering, taken inside the owning transaction ----------
CREATE TABLE core.number_series (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  doc_type text NOT NULL, prefix varchar(10) NOT NULL, fy char(4),
  digits smallint NOT NULL DEFAULT 4, next_number integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, doc_type, prefix, fy));
CREATE FUNCTION core.take_number(p_series bigint) RETURNS text LANGUAGE plpgsql AS $$
DECLARE s core.number_series;
BEGIN UPDATE core.number_series SET next_number = next_number + 1 WHERE id = p_series RETURNING * INTO s;
  IF NOT FOUND THEN RAISE EXCEPTION 'number series % missing', p_series; END IF;
  RETURN s.prefix || '-' || lpad((s.next_number - 1)::text, s.digits, '0'); END $$;

-- ---------- outbox: events for other modules, reports, AI ----------
CREATE TABLE core.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  event_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  module text NOT NULL, event_type text NOT NULL, event_version smallint NOT NULL DEFAULT 1,
  aggregate_public_id uuid NOT NULL, aggregate_version integer,
  caused_by bigint REFERENCES core.persons(id), correlation_id uuid,
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
CREATE INDEX idx_outbox_unpublished ON core.outbox(id) WHERE published_at IS NULL;

-- ---------- machines (used by service tickets now, workshop and parks later) ----------
CREATE TABLE core.machine_models (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  manufacturer text NOT NULL, name text NOT NULL, notes text, UNIQUE (tenant_id, manufacturer, name));
CREATE TABLE core.machines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  model_id bigint NOT NULL REFERENCES core.machine_models(id),
  code varchar(40) NOT NULL, serial_no text, location_id bigint NOT NULL REFERENCES core.locations(id),
  coverage text NOT NULL DEFAULT 'paid' CHECK (coverage IN ('warranty','amc','paid','internal')),
  coverage_until date, UNIQUE (tenant_id, code));
-- =====================================================================
-- PART 2: TICKETS (ticket engine + service tickets) — the parts HR links to
-- =====================================================================
CREATE SCHEMA tickets;

CREATE TABLE tickets.ticket_types (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  code varchar(40) NOT NULL, name text NOT NULL,
  owning_module text NOT NULL DEFAULT 'tickets',          -- later: workshop, site, operations raise their own types
  UNIQUE (tenant_id, code));

CREATE TABLE tickets.tickets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  number varchar(20) NOT NULL,                            -- AGE-0558
  type_id bigint NOT NULL REFERENCES tickets.ticket_types(id),
  customer_id bigint REFERENCES core.parties(id),
  location_id bigint REFERENCES core.locations(id),
  machine_id bigint REFERENCES core.machines(id),
  branch_id bigint REFERENCES core.branches(id),
  supervisor_person_id bigint REFERENCES core.persons(id),
  priority smallint NOT NULL CHECK (priority BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('open','assigned','in_progress','completed','reopened','cancelled')),
  scheduled_at timestamptz NOT NULL, due_at timestamptz,
  description text NOT NULL CHECK (length(description) <= 1000),
  created_by bigint NOT NULL REFERENCES core.persons(id), created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, cancel_reason text,
  UNIQUE (tenant_id, number),
  CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL));

CREATE TABLE tickets.ticket_people (
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  ticket_id bigint NOT NULL REFERENCES tickets.tickets(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  is_primary boolean NOT NULL DEFAULT false,
  assigned_by bigint NOT NULL REFERENCES core.persons(id), assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, person_id));
CREATE UNIQUE INDEX uq_one_primary ON tickets.ticket_people(ticket_id) WHERE is_primary;

-- Ticket punch in / out: time worked on a ticket
CREATE TABLE tickets.timelogs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,   -- made on the phone: a resend is accepted once
  ticket_id bigint NOT NULL REFERENCES tickets.tickets(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  started_at timestamptz NOT NULL, ended_at timestamptz,
  start_lat numeric(9,6), start_lng numeric(9,6), end_lat numeric(9,6), end_lng numeric(9,6),
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at > started_at));
CREATE UNIQUE INDEX uq_one_running_timelog ON tickets.timelogs(person_id) WHERE ended_at IS NULL;

CREATE TABLE tickets.ticket_events (                      -- timeline, append-only
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  ticket_id bigint NOT NULL REFERENCES tickets.tickets(id),
  actor_person_id bigint REFERENCES core.persons(id),
  event text NOT NULL, detail jsonb, at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER trg_ticket_events_append BEFORE UPDATE OR DELETE ON tickets.ticket_events FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

CREATE TABLE tickets.reassign_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  ticket_id bigint NOT NULL REFERENCES tickets.tickets(id),
  requested_by bigint NOT NULL REFERENCES core.persons(id),
  reason text NOT NULL, new_person_id bigint REFERENCES core.persons(id),
  approval_request_id bigint REFERENCES core.approval_requests(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')));
-- =====================================================================
-- PART 3: HRMS — people details, job history, skills, attendance,
-- work days, corrections, overtime, leave, expenses
-- Links: core (people, organisation, locations, files, approvals, policies)
--        tickets (timelogs, expenses and overtime on a ticket)
-- =====================================================================
CREATE SCHEMA hrms;

-- ---------- job architecture ----------
CREATE TABLE hrms.grades (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  code varchar(10) NOT NULL, name text NOT NULL, rank smallint NOT NULL,
  travel_grade smallint CHECK (travel_grade BETWEEN 1 AND 3),
  UNIQUE (tenant_id, code));
CREATE TABLE hrms.designations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  name text NOT NULL, department_id bigint REFERENCES core.departments(id),
  UNIQUE (tenant_id, name));

-- ---------- employment: one row per period of employment ----------
CREATE TABLE hrms.employments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  person_id bigint NOT NULL REFERENCES core.persons(id),
  legal_entity_id bigint NOT NULL REFERENCES core.legal_entities(id),
  employee_code varchar(20) NOT NULL,
  employment_type text NOT NULL CHECK (employment_type IN ('permanent','probation','contract','intern','external')),
  joined_on date NOT NULL, confirmed_on date, notice_given_on date, exit_on date, exit_reason text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','notice','exited')),
  UNIQUE (tenant_id, employee_code),
  CHECK (exit_on IS NULL OR exit_on >= joined_on),
  CHECK (status <> 'exited' OR (exit_on IS NOT NULL AND exit_reason IS NOT NULL)));
CREATE UNIQUE INDEX uq_one_active_employment ON hrms.employments(person_id) WHERE status <> 'exited';

-- Where someone sits, dated: branch, department, designation, grade, manager, base location
CREATE TABLE hrms.job_assignments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  employment_id bigint NOT NULL REFERENCES hrms.employments(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  valid_from date NOT NULL, valid_to date,
  branch_id bigint NOT NULL REFERENCES core.branches(id),
  department_id bigint NOT NULL REFERENCES core.departments(id),
  designation_id bigint NOT NULL REFERENCES hrms.designations(id),
  grade_id bigint REFERENCES hrms.grades(id),
  manager_person_id bigint REFERENCES core.persons(id),
  base_location_id bigint REFERENCES core.locations(id),
  change_reason text NOT NULL DEFAULT 'joining' CHECK (change_reason IN ('joining','transfer','promotion','redesignation','manager_change','correction')),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (manager_person_id IS NULL OR manager_person_id <> person_id),
  EXCLUDE USING gist (person_id WITH =, daterange(valid_from, coalesce(valid_to,'infinity'), '[]') WITH &&));

-- ---------- private details (separate permission) ----------
CREATE TABLE hrms.person_private (
  person_id bigint PRIMARY KEY REFERENCES core.persons(id),
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  date_of_birth date, blood_group varchar(5),
  address_enc bytea, emergency_contact_enc bytea,
  pan_enc bytea, uan varchar(12), esic_no varchar(17),
  aadhaar_masked varchar(14) CHECK (aadhaar_masked IS NULL OR aadhaar_masked ~ '^X{4}-?X{4}-?[0-9]{4}$'),
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE hrms.bank_accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  account_no_enc bytea NOT NULL, ifsc varchar(11) NOT NULL CHECK (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  entered_by bigint NOT NULL REFERENCES core.persons(id), verified_by bigint REFERENCES core.persons(id),
  is_primary boolean NOT NULL DEFAULT true,
  CHECK (verified_by IS NULL OR verified_by <> entered_by));
CREATE UNIQUE INDEX uq_one_primary_bank ON hrms.bank_accounts(person_id) WHERE is_primary;

CREATE TABLE hrms.person_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  doc_type text NOT NULL CHECK (doc_type IN ('id_proof','address_proof','education','experience','offer_letter','contract','other')),
  number_masked text, file_id bigint NOT NULL REFERENCES core.files(id),
  verified_by bigint REFERENCES core.persons(id), valid_until date);

-- ---------- skills, certificates, training ----------
CREATE TABLE hrms.skills (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  code varchar(40) NOT NULL, name text NOT NULL, category text,
  needs_certificate boolean NOT NULL DEFAULT false, UNIQUE (tenant_id, code));
CREATE TABLE hrms.person_skills (
  person_id bigint NOT NULL REFERENCES core.persons(id),
  skill_id bigint NOT NULL REFERENCES hrms.skills(id),
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  level text NOT NULL CHECK (level IN ('trainee','skilled','expert')),
  verified_by bigint REFERENCES core.persons(id), verified_at timestamptz,
  is_primary_trade boolean NOT NULL DEFAULT false,
  PRIMARY KEY (person_id, skill_id),
  CHECK (verified_by IS NULL OR verified_by <> person_id),
  CHECK ((verified_by IS NULL) = (verified_at IS NULL)));
CREATE UNIQUE INDEX uq_one_primary_trade ON hrms.person_skills(person_id) WHERE is_primary_trade;
CREATE TABLE hrms.certificates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  skill_id bigint REFERENCES hrms.skills(id),
  name text NOT NULL, issuer text NOT NULL, cert_no text,
  issued_on date NOT NULL, expires_on date, file_id bigint NOT NULL REFERENCES core.files(id),
  status text NOT NULL DEFAULT 'review' CHECK (status IN ('review','verified','rejected','expired')),
  verified_by bigint REFERENCES core.persons(id),
  CHECK (expires_on IS NULL OR expires_on > issued_on),
  CHECK (verified_by IS NULL OR verified_by <> person_id));
CREATE INDEX idx_cert_expiry ON hrms.certificates(expires_on) WHERE status = 'verified';
CREATE TABLE hrms.training_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  course text NOT NULL, provider text, completed_on date, due_on date, file_id bigint REFERENCES core.files(id));

-- ---------- shifts and holidays (rules come from core.policies) ----------
CREATE TABLE hrms.shifts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  code varchar(20) NOT NULL, name text NOT NULL,
  starts_at time NOT NULL, ends_at time NOT NULL, break_minutes smallint NOT NULL DEFAULT 0,
  crosses_midnight boolean GENERATED ALWAYS AS (ends_at < starts_at) STORED,
  UNIQUE (tenant_id, code));
CREATE TABLE hrms.shift_assignments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  shift_id bigint NOT NULL REFERENCES hrms.shifts(id),
  weekly_offs smallint[] NOT NULL DEFAULT '{0}',             -- 0 = Sunday
  valid_from date NOT NULL, valid_to date,
  EXCLUDE USING gist (person_id WITH =, daterange(valid_from, coalesce(valid_to,'infinity'), '[]') WITH &&));
CREATE TABLE hrms.holiday_calendars (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  name text NOT NULL, branch_id bigint REFERENCES core.branches(id), year smallint NOT NULL);
CREATE TABLE hrms.holidays (
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  calendar_id bigint NOT NULL REFERENCES hrms.holiday_calendars(id),
  on_date date NOT NULL, name text NOT NULL, is_optional boolean NOT NULL DEFAULT false,
  PRIMARY KEY (calendar_id, on_date));

-- ---------- attendance: raw punches, append-only ----------
CREATE TABLE hrms.attendance_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL UNIQUE,                            -- made on the phone: a resend is stored once
  person_id bigint NOT NULL REFERENCES core.persons(id),
  kind text NOT NULL CHECK (kind IN ('in','out')),
  source text NOT NULL CHECK (source IN ('app','web','supervisor','park_counter','gate','correction')),
  occurred_at timestamptz NOT NULL,                          -- when it happened (phone time)
  received_at timestamptz NOT NULL DEFAULT now(),            -- when the server got it
  latitude numeric(9,6), longitude numeric(9,6), accuracy_m integer,
  location_id bigint REFERENCES core.locations(id), distance_m integer,
  location_status text CHECK (location_status IN ('inside','outside','poor_accuracy','not_configured','not_taken')),
  recorded_by bigint REFERENCES core.persons(id),           -- supervisor marking a crew, or the person
  correction_id bigint,                                      -- FK added below
  device_id text,
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK (source <> 'correction' OR correction_id IS NOT NULL));
CREATE INDEX idx_att_person_time ON hrms.attendance_events(person_id, occurred_at);
CREATE TRIGGER trg_att_append BEFORE UPDATE OR DELETE ON hrms.attendance_events FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

-- In and out must alternate per person (no two open punches)
CREATE FUNCTION hrms.check_punch_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_kind text;
BEGIN
  PERFORM pg_advisory_xact_lock(NEW.person_id);
  SELECT kind INTO last_kind FROM hrms.attendance_events
   WHERE person_id = NEW.person_id AND occurred_at <= NEW.occurred_at
   ORDER BY occurred_at DESC, id DESC LIMIT 1;
  IF NEW.source <> 'correction' AND coalesce(last_kind,'out') = NEW.kind THEN
    RAISE EXCEPTION 'punch % rejected: last punch was also %', NEW.kind, coalesce(last_kind,'out (none yet)');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_punch_order BEFORE INSERT ON hrms.attendance_events FOR EACH ROW EXECUTE FUNCTION hrms.check_punch_order();

-- ---------- work days: one validated record per person per date ----------
CREATE TABLE hrms.work_days (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  work_date date NOT NULL,
  first_in timestamptz, last_out timestamptz,
  worked_minutes integer NOT NULL DEFAULT 0 CHECK (worked_minutes BETWEEN 0 AND 1440),
  break_minutes integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  overtime_minutes integer NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0),
  ticket_minutes integer NOT NULL DEFAULT 0 CHECK (ticket_minutes >= 0),   -- sum of ticket timelogs that day
  day_status text NOT NULL CHECK (day_status IN ('present','half_day','absent','leave','holiday','weekly_off','missed_punch')),
  policy_versions jsonb,                                     -- which rule versions were applied
  validated_by bigint REFERENCES core.persons(id), validated_at timestamptz,
  locked_for_payroll boolean NOT NULL DEFAULT false,
  UNIQUE (person_id, work_date),
  CHECK (overtime_minutes <= worked_minutes),
  CHECK (last_out IS NULL OR first_in IS NULL OR last_out > first_in));
CREATE FUNCTION hrms.guard_locked_day() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.locked_for_payroll THEN RAISE EXCEPTION 'work day % is locked for payroll', OLD.work_date; END IF; RETURN NEW; END $$;
CREATE TRIGGER trg_locked_day BEFORE UPDATE OR DELETE ON hrms.work_days FOR EACH ROW EXECUTE FUNCTION hrms.guard_locked_day();

-- ---------- corrections and overtime ----------
CREATE TABLE hrms.attendance_corrections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  person_id bigint NOT NULL REFERENCES core.persons(id),
  work_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('missed_in','missed_out','wrong_time','location','other')),
  requested_in timestamptz, requested_out timestamptz,
  reason text NOT NULL CHECK (length(reason) >= 10),
  approval_request_id bigint REFERENCES core.approval_requests(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_out IS NULL OR requested_in IS NULL OR requested_out > requested_in));
CREATE UNIQUE INDEX uq_one_open_correction ON hrms.attendance_corrections(person_id, work_date) WHERE status = 'pending';
ALTER TABLE hrms.attendance_events ADD FOREIGN KEY (correction_id) REFERENCES hrms.attendance_corrections(id);

CREATE TABLE hrms.overtime_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  person_id bigint NOT NULL REFERENCES core.persons(id),
  work_date date NOT NULL, minutes integer NOT NULL CHECK (minutes > 0 AND minutes <= 720),
  ticket_id bigint REFERENCES tickets.tickets(id),           -- overtime for a ticket
  reason text NOT NULL, requested_by bigint NOT NULL REFERENCES core.persons(id),
  approval_request_id bigint REFERENCES core.approval_requests(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')));

-- ---------- leave ----------
CREATE TABLE hrms.leave_types (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  code varchar(10) NOT NULL, name text NOT NULL,
  is_paid boolean NOT NULL DEFAULT true,
  policy_key text NOT NULL,                                  -- rules (entitlement, carry-forward...) in core.policies
  is_active boolean NOT NULL DEFAULT true, UNIQUE (tenant_id, code));

CREATE TABLE hrms.leave_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  person_id bigint NOT NULL REFERENCES core.persons(id),
  leave_type_id bigint NOT NULL REFERENCES hrms.leave_types(id),
  from_date date NOT NULL, to_date date NOT NULL,
  from_half text NOT NULL DEFAULT 'full' CHECK (from_half IN ('full','second_half')),
  to_half text NOT NULL DEFAULT 'full' CHECK (to_half IN ('full','first_half')),
  days numeric(5,1) NOT NULL CHECK (days > 0),               -- worked out by the service from policy and holidays
  reason text, approval_request_id bigint REFERENCES core.approval_requests(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date),
  EXCLUDE USING gist (person_id WITH =, daterange(from_date, to_date, '[]') WITH &&) WHERE (status IN ('pending','approved')));

-- Leave balances as a ledger: grants, accruals, usage, adjustments, carry-forward
CREATE TABLE hrms.leave_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  person_id bigint NOT NULL REFERENCES core.persons(id),
  leave_type_id bigint NOT NULL REFERENCES hrms.leave_types(id),
  period_year smallint NOT NULL,
  entry text NOT NULL CHECK (entry IN ('opening','accrual','grant','taken','taken_reversal','adjustment','carry_forward','lapse','encashment')),
  days numeric(5,1) NOT NULL CHECK (days <> 0),
  leave_request_id bigint REFERENCES hrms.leave_requests(id),
  reason text, posted_by bigint REFERENCES core.persons(id), posted_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry IN ('taken','encashment','lapse') AND days < 0) OR (entry IN ('opening','accrual','grant','taken_reversal','carry_forward') AND days > 0) OR entry = 'adjustment'),
  CHECK (entry NOT IN ('taken','taken_reversal') OR leave_request_id IS NOT NULL),
  CHECK (entry <> 'adjustment' OR reason IS NOT NULL));
CREATE TRIGGER trg_leave_ledger_append BEFORE UPDATE OR DELETE ON hrms.leave_ledger FOR EACH ROW EXECUTE FUNCTION core.forbid_change();
CREATE VIEW hrms.leave_balances AS
  SELECT tenant_id, person_id, leave_type_id, period_year, sum(days) AS balance_days
    FROM hrms.leave_ledger GROUP BY tenant_id, person_id, leave_type_id, period_year;

-- ---------- expenses ----------
CREATE TABLE hrms.expense_categories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  code varchar(20) NOT NULL, name text NOT NULL,
  receipt_required boolean NOT NULL DEFAULT true, policy_key text,   -- limits by grade in core.policies
  UNIQUE (tenant_id, code));

CREATE TABLE hrms.expense_claims (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES core.tenants(id),
  public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  person_id bigint NOT NULL REFERENCES core.persons(id),
  legal_entity_id bigint NOT NULL REFERENCES core.legal_entities(id),
  spent_on date NOT NULL, category_id bigint NOT NULL REFERENCES hrms.expense_categories(id),
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  description text NOT NULL,
  receipt_file_id bigint REFERENCES core.files(id),
  ticket_id bigint REFERENCES tickets.tickets(id),           -- expense made for a service ticket
  project_public_id uuid,                                    -- Operations project, when that module exists
  approval_request_id bigint REFERENCES core.approval_requests(id),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','approved','rejected','paid','cancelled')),
  approved_amount_paise bigint CHECK (approved_amount_paise >= 0),
  paid_at timestamptz, payment_ref text,                     -- written back by Accounts
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_amount_paise IS NULL OR approved_amount_paise <= amount_paise),
  CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND payment_ref IS NOT NULL AND approved_amount_paise IS NOT NULL)));

-- Receipt required by category: enforced at submit
CREATE FUNCTION hrms.check_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE need boolean;
BEGIN
  SELECT receipt_required INTO need FROM hrms.expense_categories WHERE id = NEW.category_id;
  IF NEW.status = 'submitted' AND need AND NEW.receipt_file_id IS NULL THEN
    RAISE EXCEPTION 'this expense category needs a receipt photo';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_receipt BEFORE INSERT OR UPDATE ON hrms.expense_claims FOR EACH ROW EXECUTE FUNCTION hrms.check_receipt();

-- ---------- reporting views that join across schemas (read-only) ----------
-- Who is available on a date, with skills: used by ticket assignment
CREATE VIEW hrms.v_availability AS
SELECT p.tenant_id, p.id AS person_id, p.display_name, d.d::date AS on_date,
       EXISTS (SELECT 1 FROM hrms.leave_requests lr WHERE lr.person_id = p.id AND lr.status IN ('approved','pending')
               AND d.d::date BETWEEN lr.from_date AND lr.to_date) AS on_leave,
       (SELECT array_agg(s.code ORDER BY s.code) FROM hrms.person_skills ps JOIN hrms.skills s ON s.id = ps.skill_id
         WHERE ps.person_id = p.id AND ps.verified_by IS NOT NULL) AS verified_skills,
       (SELECT count(*) FROM tickets.ticket_people tp JOIN tickets.tickets t ON t.id = tp.ticket_id
         WHERE tp.person_id = p.id AND t.status IN ('assigned','in_progress','reopened')
           AND t.scheduled_at::date = d.d::date) AS tickets_that_day
  FROM core.persons p CROSS JOIN generate_series(current_date, current_date + 13, interval '1 day') d
 WHERE p.status = 'active';

-- Hours on tickets against attendance, per person per day
CREATE VIEW hrms.v_day_hours AS
SELECT w.tenant_id, w.person_id, w.work_date, w.worked_minutes,
       coalesce((SELECT sum(extract(epoch FROM (tl.ended_at - tl.started_at)) / 60)::int
                   FROM tickets.timelogs tl
                  WHERE tl.person_id = w.person_id AND tl.ended_at IS NOT NULL
                    AND (tl.started_at AT TIME ZONE 'Asia/Kolkata')::date = w.work_date), 0) AS ticket_minutes
  FROM hrms.work_days w;
-- =====================================================================
-- PART 4: TENANT ISOLATION AND ROLES
-- The app connects as app_runtime, which does not own the tables;
-- FORCE row-level security applies the tenant rule to everyone but the owner.
-- =====================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN CREATE ROLE app_runtime LOGIN PASSWORD 'change-me'; END IF;
END $$;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_schema, table_name FROM information_schema.columns
            WHERE column_name='tenant_id' AND table_schema IN ('core','tickets','hrms')
              AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema IN ('core','tickets','hrms'))
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.table_schema, r.table_name);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = current_setting('app.tenant_id', true)::bigint) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::bigint)$p$, r.table_schema, r.table_name);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA core, tickets, hrms TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, tickets, hrms TO app_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core, tickets, hrms TO app_runtime;
