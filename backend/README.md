# Ageless backend — guide

The API and database for the Ageless platform. This guide covers what is built so far (project basics, sign-in with
roles, and the HRMS **People** area), how to run it, and how to call every endpoint. Rules for writing code are in
`CLAUDE.md` (root and `backend/`); this file is for running and using the backend.

**Contents**
1. [What is built so far](#1-what-is-built-so-far)
2. [Set up a new PC](#2-set-up-a-new-pc)
3. [Run it](#3-run-it)
4. [How the backend is organised](#4-how-the-backend-is-organised)
5. [The database](#5-the-database)
6. [Connecting to the API](#6-connecting-to-the-api)
7. [API reference](#7-api-reference)
8. [Try it: a full walkthrough](#8-try-it-a-full-walkthrough)
9. [Tests](#9-tests)
10. [Adding a new endpoint](#10-adding-a-new-endpoint)
11. [Not built yet](#11-not-built-yet)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. What is built so far

| Area | What works |
| --- | --- |
| Project basics | One error format, input validation, seed data, API tests on their own database |
| Sign-in and roles | Sign in with a phone number or email + password (JWT); roles with permissions and a scope (own / team / all); create logins, reset passwords, give and end roles |
| People | Create a person with contacts and a first job; search and list; view; rename or change status |
| Contacts | Add phone/email (a number may be shared by several people); end a contact (kept as history); list everyone sharing a number |
| Employments | Add a job in another company; change manager, department (the code stays), designation; make a job primary; exit a job; `joining` before `active`; offer letter file; employee codes generated per department prefix (ATS001 …) |
| Organisation | Departments with heads (approver after the manager), designations, positions (planned → open → filled) — ATPL seeded |
| Skills | Skills list per company and department; person skills and certificates (with files) verified by someone else; skills matrix; expiring certificates; daily job |
| Reports and month lock | Leave, expense and work-hours reports with CSV; HR locks a company's month (nothing in it can change), System Admin unlocks with a reason |
| Attendance | Punch in / out per job (resend-safe, order enforced across companies), today, my history, daily register, work hours, rebuild work days; corrections (missed or wrong punches) approved by the manager, punches never edited |
| Leave | Apply on your own job (days counted from the calendar, half days), approve / reject by the manager (else HR, else the CEO), cancel (approved leave gives the days back), balances from a ledger, HR opening balances and adjustments, report; approved leave shows on work days |
| Calendar | Holidays per company and year; weekly offs per company or per person; each job's calendar (working / weekly off / holiday), used by attendance and the leave-day count |
| Policies | Company settings (day rules, leave balance check, overtime paid, sign-in hours) stored as versions: the newest version in force on a date wins, a company's own before the group default |
| Expenses | Submit a claim on your own job with a receipt file; your claims; the manager approves (or a lower amount) or rejects; HR marks paid; report by company and dates |

Tech: NestJS 10 · PostgreSQL 16+ · Drizzle ORM · Zod · JWT (`@nestjs/jwt`) · bcrypt · Vitest + Supertest · pnpm workspaces + Turborepo.

---

## 2. Set up a new PC

You need **Node.js 22**, **pnpm 9** (`npm i -g pnpm@9`), **Git**, and **PostgreSQL** (16 or newer).

1. **Create your database login** (once). In psql as the `postgres` user, run `backend/docs/setup/local-pc.sql`:
   it creates the login `ageless` (password `ageless_dev`, allowed to create databases) and the database `ageless_dev`.
   On the office server, ask the lead for your own `dev_<name>` database instead (`backend/docs/setup/office-server.sql`).
2. **Settings file.** Copy `backend/.env.example` to `backend/.env` and fill in the values:
   ```
   DATABASE_URL=postgres://ageless:ageless_dev@localhost:5434/ageless_dev       # your database
   TEST_DATABASE_URL=postgres://ageless:ageless_dev@localhost:5434/ageless_test  # used only by tests; emptied on every test run
   PORT=3000                                                                     # API port
   JWT_SECRET=<long random text>                                                 # signs login tokens; the API won't start without it
   ```
   Use the port your PostgreSQL listens on (the default install is 5432; this team's PCs use 5434).
   For `JWT_SECRET`, any long random text works, e.g. the output of
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. `backend/.env` is never committed.
3. **Install, build the database, add starter data** (from the repository root):
   ```
   pnpm install
   pnpm db:migrate
   pnpm db:seed
   ```
4. **Start the API:** `pnpm --filter @ageless/backend dev`, then open
   http://localhost:3000/api/hrms/people/health — you should see `{"module":"hrms","sub":"people","ok":true}`.
   Then sign in as a demo person (section 5) to call the other endpoints.

---

## 3. Run it

All commands run from the **repository root**.

| Command | What it does |
| --- | --- |
| `pnpm --filter @ageless/backend dev` | Start the API with auto-restart on save, reading `backend/.env`. http://localhost:3000/api |
| `pnpm build` | Compile `shared/` and `backend/` to `dist/` |
| `node backend/dist/main.js` | Run the compiled API (production style). It does **not** read `.env`: set `DATABASE_URL`, `PORT` and `JWT_SECRET` in the environment |
| `pnpm test` | All tests (rules + API). Empties, migrates and seeds `TEST_DATABASE_URL` first |
| `pnpm typecheck` | TypeScript check of every package |
| `pnpm boundaries` | Check the backend's module boundary rules |
| `pnpm db:migrate` | Apply new migrations to the database in `backend/.env` |
| `pnpm db:generate -- --name <what_changed>` | Create a migration after editing a `schema.ts` (PowerShell: `npm run db:generate '--' --name <what_changed>`) |
| `pnpm db:seed` | Add the fictional starter data (roles, demo people and their logins). Safe to run again: existing rows are left alone |
| `pnpm db:reset` | Delete and rebuild your development database (refuses anything not named `dev_*`, `ageless_dev`, `ageless_test`). Run `pnpm db:seed` after it |

**Every day:** `git pull` → `pnpm install` → `pnpm db:migrate` → `pnpm --filter @ageless/backend dev`.
**Before you hand in work:** `pnpm typecheck`, `pnpm test`, `pnpm boundaries` and `pnpm build` all pass.

Production-style run in PowerShell:
```powershell
pnpm build
$env:DATABASE_URL = 'postgres://ageless:ageless_dev@localhost:5434/ageless_dev'; $env:PORT = '3000'; $env:JWT_SECRET = '<long random text>'
node backend/dist/main.js
```

---

## 4. How the backend is organised

```
backend/
  src/
    main.ts                    starts the app (prefix /api, port from PORT)
    app.module.ts              registers every module
    platform/
      db/                      the database pool (DB), transaction types (Tx, Conn), violatedConstraint()
      http/                    AppError, error filter, ZodValidationPipe, RequestContext, @Public/@SignedIn/@Permission
      time.ts                  todayIst(), requireEnv()
      storage.ts               saveUpload() / discardUpload(): files under backend/uploads (or UPLOAD_DIR)
    modules/
      core/                    persons, contacts, tenants, companies; CoreFacade (the only way other modules write here)
        auth/                  ← built: sign-in (JWT), the global AuthGuard, logins, role assignments
      tickets/                 service tickets (table only so far)
      hrms/
        people/                ← built: people, contacts, employments
          api/                 controllers: people, contacts, employments
          application/         people.service.ts: the use cases, each in one transaction, with scope checks
          domain/              pure rules + unit tests (contact clean-up, exit date, next primary job, permission codes)
          infrastructure/      people.repository.ts: database queries
          schema.ts            hrms.employments table
          *.api.spec.ts        API tests
        expenses/              ← built: categories, claims, approve / reject / pay, report (same layout as people/)
        attendance/            ← built: punches, work days (rebuilt from punches), today, history, register, work hours
        leave/                 ← leave-days.ts only (pure day count); no database yet
        skills/ reports/       health endpoint only so far
      sales/ operations/ ...   later modules (README only)
    test/                      test setup (empty + migrate + seed the test database), sign-in and people helpers
  drizzle/                     migrations, applied in order (0000 … 0007)
  uploads/                     uploaded files (receipts/<year>/<month>/<uuid>.<ext>) — git-ignored, back it up
  scripts/                     db-reset.mjs, db-seed.mjs
  docs/                        reference SQL for all planned tables; database setup SQL
shared/                        @ageless/shared: Zod request shapes and response types, used by backend and (later) web
```

**What happens on a request**
```
HTTP request
  → /api prefix
  → AuthGuard        route marked @Public()? → let it through (health, login)
                     else read "Authorization: Bearer <token>"        (401 AUTH_MISSING / AUTH_INVALID / AUTH_EXPIRED)
                     reload the login: still active? person still active? token newer than the last password change?
                     load today's roles → permissions with scope (own / team / all)
                     route needs @Permission('x')? caller must hold x   (403 FORBIDDEN)
  → Controller       ZodValidationPipe checks body / query / path        (400 VALIDATION)
  → Service          opens a transaction; checks the scope against the person being read or changed (403 FORBIDDEN);
                     applies the rules
      → Repository   reads/writes hrms.* tables
      → CoreFacade   writes core.* tables (persons, contacts) inside the same transaction
  → JSON response
Any error on the way → ErrorFilter → { code, message, details? }
```

---

## 5. The database

One PostgreSQL database, one schema per module: `core`, `hrms`, `tickets`. Changes only through migrations.

| Migration | Adds |
| --- | --- |
| `0000_initial` | `core.persons`; hrms tables for attendance, leave, expenses, skills, employments (first version); `tickets.tickets` |
| `0001_core_tenants_legal_entities` | `core.tenants`, `core.legal_entities` (companies) |
| `0002_people_manager_fields` | employments: `manager_person_id`, `department`, `designation`; a person can't be their own manager |
| `0003_people_company_and_contacts` | employments: company link, `is_primary`, employee code unique per company, one active job per company, one primary; `core.person_contacts` |
| `0004_people_employment_exit` | employments: `exit_reason`; exit date not before joining; an exited job must have date and reason |
| `0005_core_logins_and_roles` | `core.users`, `roles`, `permissions` (with the permission list), `role_permissions`, `role_assignments` |
| `0006_hrms_expenses` | claims: job link, receipt path, approval / rejection / payment columns, rules below, paid claims frozen (trigger); category code unique; 4 expense permissions |
| `0007_hrms_attendance` | punches and work days get the job link; work day first in / last out; one work day per job and date; triggers: punches append-only, punch order per person, locked days frozen; 3 attendance permissions |
| `0008_hrms_calendar` | `hrms.holiday_calendars`, `hrms.holidays`, `hrms.weekly_off_rules` (company default or person override; no overlaps, using the `btree_gist` extension); 1 calendar permission |
| `0009_hrms_leave_requests` | leave types `is_paid`; leave requests get job, company, halves, reason, approver, decision and cancel columns (no overlap of submitted/approved leave on one job; nobody decides their own); `hrms.leave_ledger` (append-only trigger); 4 leave permissions |
| `0010_policies_and_day_split` | `core.policies` (versions, append-only trigger); work days get `leave_days`, `absent_days` (0 / 0.5 / 1) and `worked_on_leave` (existing rows filled from their status); 1 policy permission |
| `0011_hrms_attendance_corrections` | `hrms.attendance_corrections` (one open per job and date; nobody decides their own), `hrms.attendance_exclusions` (append-only), punches get `correction_id`; punch order check ignores left-out punches; 1 permission |
| `0012_attendance_auto_punch_out` | punch source `auto` (a forgotten punch-out closed by the system) |
| `0013_overtime_requests` | `hrms.overtime_requests`; work days get `extra_minutes` (copied from the old `overtime_minutes`) and `approved_overtime_minutes` |
| `0014_drop_work_day_overtime_minutes` | removes `work_days.overtime_minutes` (extra time is no longer overtime by itself) |
| `0015_company_safe_employment_links` | every table pointing at a job also stores its company, with a composite foreign key to `employments(id, legal_entity_id)` (punches, work days, leave requests and ledger, expense claims, corrections, overtime, weekly-off overrides); `expense_claims.currency` (INR) |
| `0016_atpl_departments_positions` | `hrms.departments`, `hrms.designations`, `hrms.positions`; employments: `department_id`, `recruited_on`, offer letter, status `joining`; positions permission |
| `0017_drop_employment_department_text` | removes the old free-text `employments.department` (no data in it) |
| `0018_skills_and_certificates` | skills per company (and department), `hrms.person_skills`, certificates with issuer, number, dates, file and verification; 4 skills permissions |
| `0019_month_locks` | `hrms.month_locks`; triggers refuse punches and new work days in a locked month; month lock / unlock permissions |

**Tables used so far**

| Table | Holds | Key rules (enforced by the database) |
| --- | --- | --- |
| `core.tenants` | the company group (tenant 1) | |
| `core.legal_entities` | companies: AE, ATPL | code unique per tenant |
| `core.persons` | one row per human | `public_id` unique |
| `core.person_contacts` | phones, emails | kind is phone/email/other; one current primary per kind; `ended_at` instead of deleting; the same number may belong to several people |
| `hrms.employments` | a person's job in one company | employee code unique per company; one **active** job per person per company; one active primary per person; manager ≠ person; exited ⇒ exit date + reason |
| `core.users` | a login for a person (not everyone has one) | one per person; login phone and login email each unique across all logins; at least one of them; password stored only as a bcrypt hash |
| `core.permissions` | what can be done, e.g. `hrms.people.view` | code unique; the list comes from migrations |
| `core.roles`, `core.role_permissions` | roles per tenant and their permissions | role code unique per tenant |
| `core.policies` | a policy value (JSON) for the group (no company) or one company, with version, effective-from date and who approved it | **never updated or deleted**; version unique per tenant, company and key |
| `hrms.departments`, `hrms.designations` | a company's departments (name, code prefix, head) and job titles | prefix 2–6 capitals, unique per company |
| `hrms.positions` | a planned / open / filled job in a department | filled ⇔ the hiring employment is set (same company) |
| `hrms.skills`, `hrms.person_skills`, `hrms.certificates` | skills list; a person's skill and level; a person's certificate | **nobody verifies their own**; one row per person and skill; certificate status review / verified / expired |
| `hrms.month_locks` | a company's month closed for payroll: who locked, who unlocked and why | one open lock per company and month; **no punch or new work day in a locked month** |
| `core.role_assignments` | a person holds a role with a scope, from / to dates | scope own/team/all; nobody grants a role to themselves; ended with `ended_at`, never deleted |
| `hrms.attendance_events` | punches: job, in/out, device time, received time, position | **never updated or deleted**; `public_id` unique (resend stored once); in/out alternate per person across jobs, out closes the same job's in (`HRMS_PUNCH_ORDER`) |
| `hrms.attendance_corrections` | a request to fix one job's day: kind, requested in / out, punches to leave out, reason, status, who asked, approver, decision | one **submitted** per job and date; reason ≥ 10 characters; in < out; decided_by and approver ≠ the person and ≠ who asked; rejected ⇒ reason |
| `hrms.attendance_exclusions` | punches an approved correction left out of the day | **never updated or deleted**; a punch is left out at most once |
| `hrms.overtime_requests` | a request to pay extra time on one job's day: minutes, reason, optional ticket, status, who asked, approver, decision | minutes 1–1440; decided_by and approver ≠ the person and ≠ who asked; rejected ⇒ reason |
| `hrms.work_days` | one row per job per IST date, calculated from punches | one per job and date; status list; minutes 0–1440, extra ≤ worked, approved overtime ≤ extra; **a locked day can't change** |
| `hrms.holiday_calendars`, `hrms.holidays` | one holiday list per company per year; a holiday's date, name, optional (restricted) or not | one list per company and year; one holiday per list and date |
| `hrms.weekly_off_rules` | weekly off for a company (default) or one job (override), valid from / to, rule as JSON | exactly one of company / job; to ≥ from; **no two rules of the same company, or the same job, overlap** |
| `hrms.leave_types` | GL General leave (seed) | code unique per tenant |
| `hrms.leave_requests` | leave on one job: dates, halves, days counted at apply time, status, approver, decision | **no two submitted/approved requests of one job overlap**; status list; to ≥ from; days > 0; `decided_by` and `approver_person_id` ≠ the person; rejected ⇒ reason |
| `hrms.leave_ledger` | every balance change: opening, grant, taken, taken_reversal, adjustment (per job, type, year) | **never updated or deleted**; taken < 0, reversal > 0, both linked to a request; opening / adjustment / grant need a reason; one opening per job, type and year |
| `hrms.expense_categories` | fuel, travel, food, materials, other | code unique per tenant; `receipt_required` |
| `hrms.expense_claims` | a claim on one job: amount in paise, receipt path, status | amount > 0; status submitted / approved / rejected / paid; `approved_by` and `rejected_by` ≠ the claimant; approved amount ≤ claimed; paid ⇒ `paid_at` + `payment_ref`; rejected ⇒ reason; **a paid claim can't be updated or deleted** |

**Seed data** (`pnpm db:seed`, all fictional). Every demo login uses the password **`demo-pass-1`** (development only).

| Person (`publicId`) | Job | Sign in with | Role (scope) |
| --- | --- | --- | --- |
| Demo Supervisor (`…0001`) | AE-D001 | `+91 00000 00001` or `demo.supervisor@example.com` | Supervisor (team) |
| Demo Technician (`…0002`) | AE-D002, reports to Demo Supervisor | `+91 00000 00002` | Employee (own) |
| Demo Engineer (`…0003`) | ATPL-D001 | `demo.engineer@example.com` | Employee (own) |
| Demo HR (`…0004`) | AE-D003 | `demo.hr@example.com` | HR (all) |
| Demo Admin (`…0005`) | ATPL-D002 | `demo.admin@example.com` | System admin (all) |
| Demo CEO (`…0006`) | AE-D004 | `demo.ceo@example.com` | CEO (team): last leave approver |

ATPL departments: Designing `ATD`, Software Development `ATS`, Hardware & IoT `ATH`, CGI Content Development `ATC`,
HR & Accounts `ATHR` (no heads yet); 13 ATPL designations (Designer … Accounts Executive). No skills are seeded.

`…0001` means `00000000-0000-4000-8000-000000000001`. Tenant `1`, companies `AE` (Ageless Entertainments) and
`ATPL` (Ageless Technologies). Expense categories: `fuel`, `travel`, `materials`, `other` need a receipt; `food` does not.
Weekly off for both companies: every Sunday and the 2nd and 4th Saturday, from 2025-04-01 (until HR confirms). No holidays are seeded. Leave type: `GL` General leave, paid (until HR confirms the types).
Policies (group defaults, version 1 from 2025-04-01, until HR confirms): `core.auth.session_hours` 12,
`hrms.attendance.full_day_minutes` 480, `hrms.attendance.half_day_minutes` 240, `hrms.attendance.max_open_punch_hours` 16,
`hrms.leave.balance_check` false, `hrms.overtime.payable` false, `hrms.attendance.auto_punch_out_hours` 8.
Demo jobs: `…0101` Supervisor, `…0102` Technician, `…0103` Engineer, `…0104` HR, `…0105` Admin, `…0106` CEO.

**Roles and permissions** (seeded for tenant 1)

| Permission | Employee | Supervisor | HR | System admin |
| --- | --- | --- | --- | --- |
| `hrms.people.view` — view people, contacts, jobs | ✓ | ✓ | ✓ | ✓ |
| `hrms.people.create` — create people | | | ✓ | |
| `hrms.people.update` — rename, change status | | | ✓ | |
| `hrms.contacts.manage` — add / end contacts | | | ✓ | |
| `hrms.contacts.review` — who shares a number | | | ✓ | |
| `hrms.employments.manage` — add jobs, exit jobs | | | ✓ | |
| `hrms.employments.update` — manager, department, designation, primary | | ✓ | ✓ | |
| `core.users.manage` — logins and roles | | | | ✓ |
| `hrms.expenses.submit` — submit / see own claims | ✓ | ✓ | ✓ | |
| `hrms.expenses.approve` — approve / reject claims | | ✓ (jobs they manage) | ✓ | |
| `hrms.expenses.pay` — mark claims paid | | | ✓ | |
| `hrms.expenses.report` — expense report | | | ✓ | |
| `hrms.attendance.punch` — punch, today, my history | ✓ | ✓ | ✓ | |
| `hrms.attendance.view` — register, work hours | | ✓ (self + team) | ✓ | |
| `hrms.attendance.rebuild` — recalculate work days | | | ✓ | ✓ |

The **scope** comes from the role assignment: **own** = only yourself; **team** = yourself (view only) plus the people
whose active job lists you as manager; **all** = everyone in the tenant. A sixth role, Admin user, exists with no
permissions yet (it arrives with service tickets).

---

## 6. Connecting to the API

**Base URL:** `http://localhost:3000/api` (port from `PORT`).

**Live API docs:** `http://localhost:3000/api/docs` (Swagger page: every endpoint with its permission, request and
answer shapes and errors; press **Authorize**, paste the token from sign-in, then **Try it out**). The raw OpenAPI 3
spec is at `http://localhost:3000/api/docs.json` — import it into Postman, or generate a typed client from it.
Both are built from the code (the Zod shapes in `shared/` and the routes), so they are always current.
`API_DOCS=off` in `backend/.env` hides them (e.g. on a public server). The tables below are a short overview.

**1. Sign in** — `POST /api/auth/login` with the person's login phone or email (any phone format) and password:
```json
{ "login": "demo.hr@example.com", "password": "demo-pass-1" }
```
Answer: `{ "token": "eyJhbGciOi…", "expiresAt": "2026-11-03T18:00:00.000Z" }` (valid 12 hours).

**2. Send the token on every other request**

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <token>` |
| `Content-Type` | `application/json` for requests with a body |

The token stops working early if the password is changed or reset, the login is deactivated, or the person has no
active job left. There is no logout call: the web app simply forgets the token. Role changes apply on the next request.

**Ids:** every record is identified by its `publicId` (uuid). Internal database ids never appear in the API.

**Dates:** `YYYY-MM-DD` (e.g. `2026-01-05`). Times are UTC ISO strings (e.g. `2026-11-03T06:03:29.968Z`).

**Phone numbers** are stored without spaces, dashes or brackets (`+91 00000 12345` → `+910000012345`), so sign-in,
searches and shared-number checks match whatever format is typed. Emails are stored in lower case.

**Errors** always look like this:
```json
{ "code": "VALIDATION", "message": "Invalid request body",
  "details": [ { "path": "employment.joinedOn", "message": "Required" } ] }
```
`details` appears only for validation errors; `path` names the field (dots for nesting).

| Code | HTTP | When |
| --- | --- | --- |
| `VALIDATION` | 400 | body, query or path value is missing or wrong |
| `BAD_REQUEST` | 400 | body is not valid JSON |
| `AUTH_FAILED` | 401 | sign-in: wrong login or password (same answer for both, on purpose) |
| `AUTH_MISSING` | 401 | no `Authorization: Bearer` token |
| `AUTH_INVALID` | 401 | token broken, or ended (password changed, login or person no longer active) — sign in again |
| `AUTH_EXPIRED` | 401 | token older than its 12 hours — sign in again |
| `AUTH_WRONG_PASSWORD` | 400 | changing your password: the current password is wrong |
| `FORBIDDEN` | 403 | you lack the permission, or the person is outside your scope |
| `NOT_FOUND` | 404 | no such route |
| `INTERNAL` | 500 | unexpected error (details only in the server log) |
| `HRMS_UNKNOWN_COMPANY` | 400 | `legalEntityCode` is not a company in your tenant |
| `HRMS_MANAGER_NOT_FOUND` | 400 | `managerPublicId` is not a person in your tenant |
| `HRMS_SELF_MANAGER` | 400 | a person set as their own manager |
| `HRMS_EXIT_BEFORE_JOIN` | 400 | exit date before joining date |
| `HRMS_PERSON_NOT_FOUND` | 404 | no such person in your tenant |
| `HRMS_EMPLOYMENT_NOT_FOUND` | 404 | no such employment in your tenant |
| `HRMS_CONTACT_NOT_FOUND` | 404 | no such contact in your tenant |
| `HRMS_DUPLICATE_EMPLOYMENT` | 409 | the person already has an active job in that company |
| `HRMS_DUPLICATE_EMPLOYEE_CODE` | 409 | that employee code is already used in that company |
| `HRMS_CONTACT_ALREADY_ENDED` | 409 | the contact was already ended |
| `HRMS_EMPLOYMENT_NOT_ACTIVE` | 409 | exiting a job twice, or making an exited job primary |
| `HRMS_NOT_YOUR_EMPLOYMENT` | 403 | expense claim on a job that isn't yours |
| `HRMS_UNKNOWN_CATEGORY` | 400 | no expense category with that code |
| `HRMS_RECEIPT_REQUIRED` | 400 | the category needs a receipt file |
| `HRMS_RECEIPT_TYPE` | 400 | the receipt isn't a JPEG, PNG or PDF (checked from the file's content) |
| `TOO_LARGE` | 413 | receipt over 5 MB |
| `HRMS_DUPLICATE_ID` | 409 | a claim `publicId` already used by someone else |
| `HRMS_CLAIM_NOT_FOUND` | 404 | no such expense claim in your tenant |
| `HRMS_SELF_APPROVAL` | 403 | approving or rejecting your own claim |
| `HRMS_APPROVED_TOO_HIGH` | 400 | approved amount above the claimed amount |
| `HRMS_CLAIM_NOT_PENDING` | 409 | the claim was already approved or rejected |
| `HRMS_CLAIM_NOT_APPROVED` | 409 | marking paid a claim that isn't approved |
| `HRMS_CLAIM_PAID` | 409 | the claim is paid and can't change |
| `HRMS_PUNCH_ORDER` | 409 | punch out of order (two ins, an out with nothing to close, or an out on another job) |
| `HRMS_PUNCH_IN_FUTURE` | 400 | punch time more than 5 minutes ahead |
| `HRMS_EMPLOYMENT_NOT_ACTIVE` (punch) | 409 | punching on a job that has ended |
| `CORE_PERSON_NOT_FOUND` | 404 | logins/roles: no such person in your tenant |
| `CORE_USER_NOT_FOUND` | 404 | no such login |
| `CORE_USER_EXISTS` | 409 | the person already has a login |
| `CORE_LOGIN_TAKEN` | 409 | another login already uses that phone or email |
| `CORE_UNKNOWN_ROLE` | 400 | no role with that code |
| `CORE_SELF_GRANT` | 403 | giving a role to yourself |
| `CORE_ROLE_ASSIGNMENT_NOT_FOUND` | 404 | no such role assignment |
| `CORE_ROLE_ALREADY_ENDED` | 409 | the role was already ended |

**Calling from PowerShell**
```powershell
$login = Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/auth/login' -ContentType 'application/json' `
  -Body '{"login":"demo.hr@example.com","password":"demo-pass-1"}'
$h = @{ Authorization = "Bearer $($login.token)" }
Invoke-RestMethod -Uri 'http://localhost:3000/api/hrms/people?search=demo' -Headers $h
```
**Calling with curl** (bash)
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" \
  -d '{"login":"demo.hr@example.com","password":"demo-pass-1"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/hrms/people?search=demo"
```
**From the web app (later):** import the request shapes from `@ageless/shared`, keep the token in memory, and use
`GET /api/auth/me` to decide which menus to show (the backend checks every request anyway).

---

## 7. API reference

| # | Method and path | Purpose | Who (permission) | Success |
| --- | --- | --- | --- | --- |
| 0 | `GET /api/hrms/{people,attendance,calendar,leave,expenses,skills,reports}/health` | Is the API up? | anyone, no token | 200 |
| A1 | `POST /api/auth/login` | Sign in | anyone, no token | 200 `{ token, expiresAt }` |
| A2 | `GET /api/auth/me` | Who am I, my roles and permissions | anyone signed in | 200 |
| A3 | `POST /api/auth/password` | Change my password | anyone signed in | 200 `{ token, expiresAt }` |
| U1 | `POST /api/core/users` | Create a login for a person | `core.users.manage` (all) | 201 `{ publicId }` |
| U2 | `POST /api/core/users/:publicId/reset-password` | Set a new password | `core.users.manage` (all) | 204 |
| U3 | `POST /api/core/role-assignments` | Give a person a role | `core.users.manage` (all) | 201 `{ publicId }` |
| U4 | `POST /api/core/role-assignments/:publicId/end` | End a role | `core.users.manage` (all) | 204 |
| P1 | `GET /api/core/policies` | Stored policy versions | `core.policies.manage` (all) | 200 list |
| P2 | `GET /api/core/policies/in-force` | The value used on a date | `core.policies.manage` (all) | 200 |
| P3 | `POST /api/core/policies` | Add a new version | `core.policies.manage` (all) | 201 policy (200 if resent) |
| 1 | `POST /api/hrms/people` | Create person + contacts + first job | `hrms.people.create` (all) | 201 `{ publicId }` |
| 2 | `GET /api/hrms/people` | Search / list people | `hrms.people.view` — list limited to your scope | 200 list |
| 3 | `GET /api/hrms/people/:publicId` | View one person | `hrms.people.view` | 200 person |
| 4 | `PATCH /api/hrms/people/:publicId` | Change display name and/or status | `hrms.people.update` | 200 person |
| 5 | `POST /api/hrms/people/:publicId/contacts` | Add a phone/email | `hrms.contacts.manage` | 201 `{ publicId }` |
| 6 | `POST /api/hrms/people/:publicId/employments` | Add a job in another company | `hrms.employments.manage` | 201 `{ publicId }` |
| 7 | `POST /api/hrms/contacts/:id/end` | End a contact (kept as history) | `hrms.contacts.manage` | 204 |
| 8 | `GET /api/hrms/contacts/shared?value=` | Everyone currently using a phone/email | `hrms.contacts.review` (all) | 200 |
| 9 | `PATCH /api/hrms/employments/:publicId` | Change manager, department, designation, or make primary | `hrms.employments.update` | 200 person |
| 10 | `POST /api/hrms/employments/:publicId/exit` | Exit a job | `hrms.employments.manage` | 200 person |
| T1 | `POST /api/hrms/attendance/punches` | Punch in or out | `hrms.attendance.punch` | 201 punch (200 if resent) |
| T2 | `GET /api/hrms/attendance/today` | Am I in, since when, minutes today | `hrms.attendance.punch` | 200 |
| T3 | `GET /api/hrms/attendance/history` | My days per company | `hrms.attendance.punch` | 200 |
| T4 | `GET /api/hrms/attendance/register` | Everyone's day on a date | `hrms.attendance.view` | 200 |
| T5 | `GET /api/hrms/attendance/work-hours` | Totals per person over dates | `hrms.attendance.view` | 200 |
| T6 | `POST /api/hrms/attendance/rebuild` | Recalculate work days | `hrms.attendance.rebuild` (all) | 200 |
| K1 | `POST /api/hrms/attendance/corrections` | Ask to fix a day (own, or a team member's) | `hrms.attendance.punch` | 201 correction (200 if resent) |
| K2 | `GET /api/hrms/attendance/corrections/mine` | Corrections about me or filed by me | `hrms.attendance.punch` | 200 |
| K3 | `GET /api/hrms/attendance/corrections/to-approve` | Waiting for my decision | `hrms.attendance.approve` | 200 |
| K4 | `POST /api/hrms/attendance/corrections/:publicId/approve` | Approve: adds punches, leaves out wrong ones, rebuilds the day | `hrms.attendance.approve` | 200 |
| K5 | `POST /api/hrms/attendance/corrections/:publicId/reject` | Reject with a reason | `hrms.attendance.approve` | 200 |
| K6 | `POST /api/hrms/attendance/corrections/:publicId/cancel` | Cancel (the person or who filed it) | `hrms.attendance.punch` | 200 |
| O1 | `POST /api/hrms/attendance/overtime` | Ask for overtime (own, or a team member's; future dates allowed) | `hrms.attendance.punch` | 201 request (200 if resent) |
| O2 | `GET /api/hrms/attendance/overtime/mine` | Requests about me or filed by me | `hrms.attendance.punch` | 200 |
| O3 | `GET /api/hrms/attendance/overtime/to-approve` | Waiting for my decision | `hrms.attendance.approve` | 200 |
| O4 | `POST /api/hrms/attendance/overtime/:publicId/approve` | Approve and rebuild the day | `hrms.attendance.approve` | 200 |
| O5 | `POST /api/hrms/attendance/overtime/:publicId/reject` | Reject with a reason | `hrms.attendance.approve` | 200 |
| O6 | `POST /api/hrms/attendance/overtime/:publicId/cancel` | Cancel (the person or who filed it) | `hrms.attendance.punch` | 200 |
| M1 | `GET /api/hrms/month-locks?company=&year=` | Month locks, unlocked ones too | HR or System admin | 200 |
| M2 | `POST /api/hrms/month-locks` | Lock a company's ended month | `hrms.month.lock` (all) | 201 |
| M3 | `POST /api/hrms/month-locks/:publicId/unlock` | Unlock with a reason | `hrms.month.unlock` (all) | 200 |
| D1 | departments, designations, positions, activate, offer letter | see `backend/docs/api/people.md` | | |
| S1 | `GET /api/hrms/skills`, `POST /api/hrms/skills` | Skills list / add one | anyone signed in / `hrms.skills.manage` (all) | 200 / 201 |
| S2 | `POST /api/hrms/people/:publicId/skills` | Add a skill or change its level | `hrms.skills.add` (own / team / all) | 201 |
| S3 | `POST /api/hrms/person-skills/:publicId/verify` | Verify (never your own) | `hrms.skills.verify` (team / all) | 200 |
| S4 | `POST /api/hrms/people/:publicId/certificates` | Add a certificate (multipart, optional `file`) | `hrms.skills.add` | 201 |
| S5 | `POST /api/hrms/certificates/:publicId/verify`, `GET …/file` | Verify (never your own); the file | `hrms.skills.verify`; person, manager, HR | 200 |
| S6 | `GET /api/hrms/skills/matrix?company=&department=&skill=` | People with skills and certificates | `hrms.skills.view` (own / team / all) | 200 |
| S7 | `GET /api/hrms/certificates/expiring?days=30` | Certificates expiring soon | `hrms.skills.manage` (all) | 200 |
| C1 | `GET /api/hrms/calendar` | One job's days: working, weekly off, holiday | `hrms.people.view` (own job, team, all) | 200 |
| C2 | `GET /api/hrms/holidays` | Holidays of a year | anyone signed in | 200 list |
| C3 | `POST /api/hrms/holidays` | Add a holiday | `hrms.calendar.manage` (all) | 201 holiday (200 if resent) |
| C4 | `DELETE /api/hrms/holidays/:publicId` | Remove a future holiday | `hrms.calendar.manage` (all) | 204 |
| C5 | `GET /api/hrms/weekly-offs` | Weekly-off rules | `hrms.calendar.manage` (all) | 200 list |
| C6 | `POST /api/hrms/weekly-offs` | Set a company's or a person's weekly off | `hrms.calendar.manage` (all) | 201 rule (200 if resent) |
| L1 | `GET /api/hrms/leave/types` | Leave types | anyone signed in | 200 |
| L2 | `GET /api/hrms/leave/balances/mine` | My balance per company and type | `hrms.leave.apply` | 200 |
| L3 | `POST /api/hrms/leave/requests` | Apply for leave | `hrms.leave.apply` | 201 request (200 if resent) |
| L4 | `GET /api/hrms/leave/requests/mine` | My requests | `hrms.leave.apply` | 200 |
| L5 | `GET /api/hrms/leave/requests/to-approve` | Requests waiting for my decision | `hrms.leave.approve` | 200 |
| L6 | `POST /api/hrms/leave/requests/:publicId/approve` | Approve | `hrms.leave.approve` | 200 request |
| L7 | `POST /api/hrms/leave/requests/:publicId/reject` | Reject with a reason | `hrms.leave.approve` | 200 request |
| L8 | `POST /api/hrms/leave/requests/:publicId/cancel` | Cancel (the person or HR) | `hrms.leave.apply` | 200 request |
| L9 | `POST /api/hrms/leave/ledger/adjustments` | Opening balance or adjustment | `hrms.leave.manage` (all) | 201 entry (200 if resent) |
| L10 | `GET /api/hrms/leave/report` | Submitted and approved leave over dates | `hrms.leave.report` (team / all) | 200 |
| E1 | `GET /api/hrms/expenses/categories` | Expense categories | anyone signed in | 200 |
| E2 | `POST /api/hrms/expenses` | Submit a claim (multipart, optional receipt file) | `hrms.expenses.submit` | 201 claim (200 if resent) |
| E3 | `GET /api/hrms/expenses/mine` | My claims | `hrms.expenses.submit` | 200 list |
| E4 | `GET /api/hrms/expenses/to-approve` | Submitted claims on jobs I manage | `hrms.expenses.approve` | 200 |
| E5 | `POST /api/hrms/expenses/:publicId/approve` | Approve (optionally a lower amount) | `hrms.expenses.approve` | 200 claim |
| E6 | `POST /api/hrms/expenses/:publicId/reject` | Reject with a reason | `hrms.expenses.approve` | 200 claim |
| E7 | `POST /api/hrms/expenses/:publicId/mark-paid` | Mark an approved claim paid | `hrms.expenses.pay` (all) | 200 claim |
| E8 | `GET /api/hrms/expenses/report` | Totals by status and category | `hrms.expenses.report` (all) | 200 |

"person" means the full person view from #3. "(all)" means the permission must have scope all; elsewhere the scope is
checked against the person (a Supervisor may do #9 for their team, but not for themselves). Shapes live in
`shared/src/core/auth.ts`, `shared/src/hrms/people.ts`, `shared/src/hrms/attendance.ts`, `shared/src/hrms/calendar.ts`, `shared/src/hrms/leave.ts` and `shared/src/hrms/expenses.ts`.

### A1. Sign in — `POST /api/auth/login`
Body: `{ "login": "+91 00000 00001", "password": "demo-pass-1" }` — `login` is the login phone (any format) or email.
Answer `200 { "token": "…", "expiresAt": "…" }`. Errors: `AUTH_FAILED` (wrong login or password, or the login / person
is no longer active), `VALIDATION`.

### A2. Who am I — `GET /api/auth/me`
```json
{
  "person": { "publicId": "00000000-0000-4000-8000-000000000004", "displayName": "Demo HR" },
  "user": { "publicId": "00000000-0000-4000-8000-000000000304", "loginPhone": null, "loginEmail": "demo.hr@example.com" },
  "roles": [ { "publicId": "00000000-0000-4000-8000-000000000204", "code": "hr", "name": "HR", "scope": "all" } ],
  "permissions": { "hrms.people.view": "all", "hrms.people.create": "all", "hrms.people.update": "all",
                   "hrms.contacts.manage": "all", "hrms.contacts.review": "all",
                   "hrms.employments.manage": "all", "hrms.employments.update": "all" }
}
```
`permissions` gives the widest scope you hold each permission with, across all your roles.

### A3. Change my password — `POST /api/auth/password`
Body: `{ "currentPassword": "…", "newPassword": "…" }` (new: 8–72 characters). Answer: a **new** token — every older
token (on any device) stops working. Errors: `AUTH_WRONG_PASSWORD`, `VALIDATION`.

### U1. Create a login — `POST /api/core/users`
Body: `{ "personPublicId": "…", "loginPhone": "+91 00000 12345", "loginEmail": "someone@example.com", "password": "…" }`
— give a phone, an email, or both; password 8–72 characters. The phone may be a number other people also use as a
contact, but no other **login** may use it. Answer `201 { "publicId": "<login id>" }`.
Errors: `CORE_PERSON_NOT_FOUND`, `CORE_USER_EXISTS`, `CORE_LOGIN_TAKEN`, `VALIDATION`.

### U2. Reset a password — `POST /api/core/users/:publicId/reset-password`
`:publicId` is the login id from U1 (or `user.publicId` in A2). Body: `{ "newPassword": "…" }`. Answer `204`; the
person's existing tokens stop working. Errors: `CORE_USER_NOT_FOUND`.

### U3. Give a role — `POST /api/core/role-assignments`
Body: `{ "personPublicId": "…", "roleCode": "supervisor", "scope": "team", "validFrom": "2026-11-03", "validTo": "2027-03-31" }`
— role codes: `employee`, `supervisor`, `hr`, `admin_user`, `system_admin`; scope `own` / `team` / `all`;
`validFrom` defaults to today (IST), `validTo` optional. Answer `201 { "publicId": "<assignment id>" }`.
Errors: `CORE_SELF_GRANT` (yourself), `CORE_UNKNOWN_ROLE`, `CORE_PERSON_NOT_FOUND`.

### U4. End a role — `POST /api/core/role-assignments/:publicId/end`
No body. Answer `204`; takes effect on the person's next request; the record stays as history.
Errors: `CORE_ROLE_ASSIGNMENT_NOT_FOUND`, `CORE_ROLE_ALREADY_ENDED`.

### P1–P3. Policies — `/api/core/policies`
Settings that are not final are stored as versions and never changed. HR and System admin only. The keys, their value
shapes and built-in defaults are listed in `shared/src/core/policies.ts` (`POLICIES`); any other key is refused.
- `GET /api/core/policies?key=&company=` — stored versions, newest first.
- `GET /api/core/policies/in-force?key=hrms.attendance.full_day_minutes&company=AE&date=2026-11-04` →
  `{ key, company, date, value, source }`. Rule: among versions already effective on the date, the company's own newest
  version wins; else the group's newest; else the built-in default (`source: null`).
- `POST /api/core/policies` `{ "key": "hrms.attendance.full_day_minutes", "company": "AE", "value": 450, "effectiveFrom": "2026-12-01" }`
  adds the next version (leave out `company` for the group default). The caller is recorded as approver.

The backend reads them with `CoreFacade.getPolicy(tenantId, key, companyId, date)` (attendance per job's company and date).

The complete People reference (with departments, positions, joining and offer letters) is `backend/docs/api/people.md`.

### 1. Create a person — `POST /api/hrms/people`
Creates the person, their contacts and their first job **in one transaction**: all saved or none.
```json
{
  "displayName": "Demo Person",
  "contacts": [
    { "kind": "phone", "value": "+91 00000 12345", "label": "personal" },
    { "kind": "email", "value": "demo.person@example.com" }
  ],
  "employment": {
    "legalEntityCode": "ATPL",
    "departmentCode": "ATS",
    "engagementType": "permanent",
    "joinedOn": "2026-01-05",
    "designation": "Technician",
    "managerPublicId": "00000000-0000-4000-8000-000000000001"
  }
}
```
| Field | Rule |
| --- | --- |
| `displayName` | 2–100 characters |
| `contacts` | optional, up to 10. `kind`: `phone` / `email` / `other`; `value` 3–100 (email must be valid); `label` up to 40; `isPrimary` optional — at most one per kind. If none of a kind is marked, the first one is primary |
| `employment.legalEntityCode` | company code (`AE`, `ATPL`) |
| `employment.employeeCode` | 1–20 characters, unique within that company; leave it out with a `departmentCode` to get the next code for the department's prefix (ATS001 …); never changes |
| `employment.engagementType` | `permanent` / `probation` / `contract` / `intern` / `external` |
| `employment.joinedOn` | `YYYY-MM-DD` |
| `employment.departmentCode` | optional, a department's code prefix in that company |
| `employment.designation` | optional, up to 80 |
| `employment.status`, `recruitedOn` | `active` (default) or `joining`; recruited date optional — see `backend/docs/api/people.md` |
| `employment.managerPublicId` | optional, a person in your tenant |
| `employment.isPrimary` | optional, only `true`: the first job is always primary |

Answer `201 { "publicId": "cb55b426-…" }`. Errors: `VALIDATION`, `HRMS_UNKNOWN_COMPANY`, `HRMS_MANAGER_NOT_FOUND`,
`HRMS_DUPLICATE_EMPLOYEE_CODE` (nothing is saved). A phone number already used by someone else is fine.
Creating a person does not create a login: an admin does that with U1.

### 2. Search and list — `GET /api/hrms/people`
| Query | Meaning |
| --- | --- |
| `search` | part of the name, an employee code, or a current phone/email (any phone format) |
| `company` | only people with a job in this company (`AE`, `ATPL`) |
| `status` | only people with a job in this status: `active` / `notice` / `exited` (combined with `company` if both given) |
| `page`, `pageSize` | default 1 and 20; `pageSize` at most 100 |

Empty values (`?search=`) are ignored. Only people with at least one job are listed, sorted by name. With scope
**own** you see only yourself; with **team**, yourself and the people you manage.
```json
{
  "items": [
    { "publicId": "cb55b426-…", "displayName": "Demo Person", "status": "active",
      "primaryEmployment": { "company": "AE", "employeeCode": "ATS001", "department": { "code": "ATS", "name": "Software Development" },
                             "designation": "Technician", "status": "active" } }
  ],
  "page": 1, "pageSize": 20, "total": 1
}
```

### 3. View a person — `GET /api/hrms/people/:publicId`
Contacts: current first (primary first), then ended ones. Employments: primary first, then newest.
```json
{
  "publicId": "cb55b426-…", "displayName": "Demo Person", "status": "active",
  "contacts": [
    { "publicId": "75bebc72-…", "kind": "phone", "value": "+910000012345", "label": "personal", "isPrimary": true, "endedAt": null },
    { "publicId": "7cd9aaff-…", "kind": "email", "value": "demo.person@example.com", "label": null, "isPrimary": true, "endedAt": null }
  ],
  "employments": [
    { "publicId": "eae3367f-…", "company": { "code": "AE", "name": "Ageless Entertainments" },
      "employeeCode": "AE-0101", "engagementType": "permanent", "status": "active", "isPrimary": true,
      "joinedOn": "2026-01-05", "exitOn": null, "exitReason": null,
      "department": { "code": "ATS", "name": "Software Development" }, "designation": "Developer", "hasOfferLetter": false,
      "manager": { "publicId": "00000000-0000-4000-8000-000000000001", "displayName": "Demo Supervisor" } }
  ]
}
```
Errors: `VALIDATION` (not a uuid), `HRMS_PERSON_NOT_FOUND`, `FORBIDDEN` (outside your scope).

### 4. Change a person — `PATCH /api/hrms/people/:publicId`
Body: `{ "displayName": "Demo P.", "status": "inactive" }` — send one or both. `status`: `active` / `inactive` / `exited`.
Answer: the updated person. Errors: `VALIDATION` (empty body), `HRMS_PERSON_NOT_FOUND`, `FORBIDDEN`.

### 5. Add a contact — `POST /api/hrms/people/:publicId/contacts`
Body: `{ "kind": "phone", "value": "+91 00000 99999", "label": "family", "isPrimary": true }` (same rules as in #1).
The number may already belong to other people; they stay separate people. With `isPrimary: true` it replaces the
person's current primary of that kind. Without it, the contact is not primary.
Answer `201 { "publicId": "<contact id>" }`. Errors: `VALIDATION`, `HRMS_PERSON_NOT_FOUND`, `FORBIDDEN`.

### 6. Add a job in another company — `POST /api/hrms/people/:publicId/employments`
Body: the same fields as `employment` in #1. `isPrimary: true` moves primary to this job; otherwise it is not primary.
Answer `201 { "publicId": "<employment id>" }`.
Errors: `HRMS_DUPLICATE_EMPLOYMENT` (already active in that company), `HRMS_DUPLICATE_EMPLOYEE_CODE`,
`HRMS_UNKNOWN_COMPANY`, `HRMS_MANAGER_NOT_FOUND`, `HRMS_SELF_MANAGER`, `HRMS_PERSON_NOT_FOUND`, `FORBIDDEN`.

### 7. End a contact — `POST /api/hrms/contacts/:id/end`
`:id` is the contact's `publicId` (from #3). No body. Sets `endedAt` to now; the contact stays in the person's history,
drops out of search and the shared list. If it was primary, the person has no primary of that kind until one is set (#5).
Answer `204` (no body). Errors: `HRMS_CONTACT_NOT_FOUND`, `HRMS_CONTACT_ALREADY_ENDED`, `FORBIDDEN`.

### 8. Who shares this number — `GET /api/hrms/contacts/shared?value=+91 00000 99999`
For HR review. Matches current contacts exactly, in any phone format (URL-encode `+` as `%2B`). Never merges people.
```json
{
  "value": "+910000099999",
  "people": [
    { "publicId": "cb55b426-…", "displayName": "Demo Person", "status": "active",
      "contact": { "publicId": "64a4604c-…", "kind": "phone", "label": "family", "isPrimary": true } },
    { "publicId": "00000000-0000-4000-8000-000000000002", "displayName": "Demo Technician", "status": "active",
      "contact": { "publicId": "c70e7aa8-…", "kind": "phone", "label": null, "isPrimary": false } }
  ]
}
```

### 9. Change a job — `PATCH /api/hrms/employments/:publicId`
Body — any of:
| Field | Meaning |
| --- | --- |
| `managerPublicId` | new manager (uuid), or `null` to remove |
| `departmentCode` | a department of the job's company (a transfer: the employee code stays), or `null` to clear |
| `designation` | new text, or `null` to clear |
| `isPrimary` | `true` only: makes this job primary and removes primary from the person's other job, in one transaction |

A Supervisor may do this for the people they manage (not for their own job); HR for everyone.
Answer: the updated person. Errors: `VALIDATION` (empty body), `HRMS_SELF_MANAGER`, `HRMS_MANAGER_NOT_FOUND`,
`HRMS_EMPLOYMENT_NOT_ACTIVE` (making an exited job primary), `HRMS_EMPLOYMENT_NOT_FOUND`, `FORBIDDEN`.

### 10. Exit a job — `POST /api/hrms/employments/:publicId/exit`
Body: `{ "exitOn": "2026-06-30", "exitReason": "Moved to ATPL full time" }` (reason 3–200 characters).
In one transaction:
- the job becomes `exited` with the date and reason (the record is kept);
- if it was primary and another active job exists, the most recently joined active job becomes primary;
- if no active job is left, the person's status becomes `inactive` (the exited job stays marked primary as history),
  and their login stops working.

Answer: the updated person. Errors: `HRMS_EXIT_BEFORE_JOIN`, `HRMS_EMPLOYMENT_NOT_ACTIVE` (already exited),
`HRMS_EMPLOYMENT_NOT_FOUND`, `FORBIDDEN`.

### T1. Punch — `POST /api/hrms/attendance/punches`
```json
{ "publicId": "<uuid made on the device>", "employmentPublicId": "<one of your jobs>", "kind": "in",
  "occurredAt": "2026-11-03T09:02:00+05:30", "latitude": 12.97, "longitude": 77.59, "accuracyM": 15 }
```
`latitude` / `longitude` / `accuracyM` optional (send latitude and longitude together). Answer `201` with the punch;
the **same `publicId` again** answers `200` with the stored punch (nothing new is saved). After every punch the job's
work day for that IST date is recalculated in the same transaction.
Rules (checked by the database for every punch): `in` and `out` alternate **per person across all their jobs**; an
`out` must close the `in` of the same job; a late (offline) punch must also fit the punch after it.
**Automatic punch-out** (policy `hrms.attendance.auto_punch_out_hours`, 8): a punch-in that arrives while an earlier
punch-in is still open and at least 8 hours old first adds a punch-out (`source: "auto"`) at that punch-in + 8 hours, so a
forgotten punch-out never blocks the next morning. That day keeps its minutes but stays `missed_punch` until a correction
is approved (the correction replaces the automatic punch-out). Within the 8 hours a second punch-in is still refused, and
a real punch-out after more than 8 hours (overtime) is kept as it is.
Errors: `HRMS_PUNCH_ORDER` (409), `HRMS_NOT_YOUR_EMPLOYMENT`, `HRMS_EMPLOYMENT_NOT_ACTIVE`, `HRMS_PUNCH_IN_FUTURE`
(more than 5 minutes ahead), `HRMS_DUPLICATE_ID`, `VALIDATION`.

### T2. Today — `GET /api/hrms/attendance/today`
`{ "date": "2026-11-03", "punchedIn": true, "since": "2026-11-03T03:32:00.000Z", "employment": { "publicId": "…", "company": "AE" }, "workedMinutes": 95 }`
— `workedMinutes` counts today on all jobs, with the open punch-in counted up to now. `lastMissedPunchDate`: the latest
earlier day still a missed punch with no open correction (null when none), so the app can ask for a correction.

### T3. My history — `GET /api/hrms/attendance/history?from=2026-11-01&to=2026-11-30`
One row per day and company, newest first (at most 93 days). Today is calculated live: while punched in it shows
`"status": "working", "running": true` with the minutes so far. Each row has `punches`: every stored punch of that job
that day `{ publicId, kind, occurredAt, source, corrected }` — `corrected: true` means an approved correction left it out
(it is still stored); `source: "correction"` marks a punch a correction added.
```json
[ { "date": "2026-10-07", "employment": { "publicId": "…", "company": "AE", "employeeCode": "AE-0101" },
    "firstIn": "2026-10-07T03:30:00.000Z", "lastOut": "2026-10-07T13:00:00.000Z",
    "workedMinutes": 510, "extraMinutes": 30, "approvedOvertimeMinutes": 0, "status": "present", "locked": false, "running": false } ]
```
Statuses: `present` (≥ 8 h), `half_day` (≥ 4 h), `absent` (less), `missed_punch` (an `in` without `out` that day),
`working` (today, still in). Full and half day are policies `hrms.attendance.full_day_minutes` / `half_day_minutes`
(480 / 240). `extraMinutes` is time worked beyond the full day — **not overtime by itself**; `approvedOvertimeMinutes` is
what approved overtime requests allow, never more than `extraMinutes`.

### T4. Daily register — `GET /api/hrms/attendance/register?date=2026-11-03&company=AE`
Everyone with an active job (in that company, or all) and their day. No work day means `absent` on a working day,
`weekly_off` or `holiday` otherwise; today is live. A short stint on a weekly off or holiday also shows as that day, not `absent`.
Supervisors see themselves and the people they manage; HR sees everyone. Answer `{ date, company, rows, summary, totals }`
where each row is a history row plus `person`, `summary` counts rows per status and `totals` adds up `leaveDays` and
`absentDays`. Each row has `leaveDays` and `absentDays` (0, 0.5 or 1) and `workedOnLeave`:

| Leave that day | Worked a full day | Worked a half day | Worked less / nothing |
| --- | --- | --- | --- |
| none | present (0 / 0) | half_day (0 / 0.5) | absent (0 / 1) |
| half | present (0.5 / 0), worked on leave | present (0.5 / 0) | half_day (0.5 / 0.5) |
| full | present (1 / 0), worked on leave | leave (1 / 0), worked on leave | leave (1 / 0) |

(leave days / absent days). Weekly offs and holidays are neither; a missed punch-out is not counted as absent.

### T5. Work hours — `GET /api/hrms/attendance/work-hours?company=AE&from=2026-11-01&to=2026-11-30`
Per job held during the range: `days: { present, halfDay, missedPunch, absent, leave }`, `leaveDays`, `absentDays`,
`workedMinutes`, `extraMinutes`, `approvedOvertimeMinutes` and `overtimePayable` (the company's `hrms.overtime.payable` policy, false by default). A past working day (before today, while
the job was held) with nothing recorded counts as one absent day. Same visibility as the register. Has `producedAt`;
`&format=csv` downloads the same numbers as CSV (period, company and production time on top).

### T6. Rebuild work days — `POST /api/hrms/attendance/rebuild`
Body: `{ "personPublicId": "…", "from": "2026-11-01", "to": "2026-11-30" }` (or `employmentPublicId` for one job).
Recalculates every stored day in the range from its punches; locked days are skipped. HR and System admin (scope all).
Answer `{ "rebuilt": 12, "skippedLocked": 0 }`.

### K1. Ask for a correction — `POST /api/hrms/attendance/corrections`
```json
{ "employmentPublicId": "…", "workDate": "2026-11-03", "kind": "wrong_time", "punchIdsToExclude": ["…"],
  "requestedOut": "2026-11-03T18:00:00+05:30", "reason": "The gate reader stamped the wrong time" }
```
`kind`: `missed_out` (needs `requestedOut`), `missed_in` (needs `requestedIn`), `wrong_time` (needs the wrong punch ids and
the right time), `other`. Times must be on the work date (IST); `reason` at least 10 characters. For your own job, or as the
job's manager for a team member. The approver is the job's manager, then HR, then the CEO — never the person or whoever
filed it. Errors: `HRMS_DAY_LOCKED` (409), `HRMS_CORRECTION_OPEN` (409, the day already has one waiting),
`HRMS_CORRECTION_FUTURE`, `HRMS_CORRECTION_OUTSIDE_DAY`, `HRMS_CORRECTION_UNKNOWN_PUNCH` (400), `FORBIDDEN` (403).

### K4–K6. Approve, reject, cancel
- **Approve** (no body): in one transaction the wrong punches get an exclusion, the requested times are added as punches
  (`source: "correction"`, allowed by the order rule even in the past), and the day is rebuilt. Nobody approves a
  correction about themselves or filed by them (`HRMS_SELF_APPROVAL`, 403); a Supervisor only when named as approver.
  `HRMS_DAY_LOCKED` if the day was locked meanwhile.
- **Reject**: `{ "reason": "Gate log shows 15:00" }`. **Cancel**: no body; the person or whoever filed it.
- Only a submitted correction can be decided or cancelled (`HRMS_CORRECTION_NOT_PENDING`, 409).

### O1–O6. Overtime — `/api/hrms/attendance/overtime`
Extra time is paid as overtime only when approved.
- **Ask**: `{ "employmentPublicId": "…", "workDate": "2026-11-03", "minutes": 90, "reason": "Site handover ran late", "ticketPublicId": "…" }`
  (ticket optional). For your own job, or as the job's manager for a team member. A future date is planned overtime.
  The approver is the job's manager, then HR, then the CEO — never the person or whoever filed it. `HRMS_DAY_LOCKED` (409)
  for a locked day, `HRMS_UNKNOWN_TICKET` (400).
- **Approve** (no body): the day's `approvedOvertimeMinutes` = the approved minutes of that day, at most its
  `extraMinutes`; the day is rebuilt. A day not built yet (a future date) gets it when its punches come in.
  `HRMS_SELF_APPROVAL` (403), `HRMS_DAY_LOCKED` (409).
- **Reject**: `{ "reason": "…" }`. **Cancel**: no body; the person or whoever filed it, also after approval (the day is
  rebuilt) unless the day is locked.
### C1. A job's calendar — `GET /api/hrms/calendar?employment=…&from=2026-11-01&to=2026-11-30`
Each date: `{ date, kind: "working" | "weekly_off" | "holiday", holiday, optionalHoliday }` (at most 366 days). The
person's own weekly-off rule wins over the company's; a holiday wins over a weekly off; an optional (restricted) holiday
stays a working day and is named in `optionalHoliday`. You see your own jobs; a Supervisor their team's; HR everyone's.
Attendance work days and the leave-day count both take holidays and weekly offs from here.

### C2. Holidays — `GET /api/hrms/holidays?company=AE&year=2026`
`[{ publicId, company, date, name, isOptional }]`, by date. `company` is optional (all companies).

### C3. Add a holiday — `POST /api/hrms/holidays`
`{ "publicId": "…", "company": "AE", "date": "2026-11-08", "name": "Diwali", "isOptional": false }` (`publicId` optional;
the same one again answers 200 with the stored holiday). The year's list is created on first use. Work days already stored
for that company and date are rebuilt (locked days are not). Errors: `HRMS_HOLIDAY_EXISTS` (409, that date already has
one), `HRMS_UNKNOWN_COMPANY` (400).

### C4. Remove a holiday — `DELETE /api/hrms/holidays/:publicId`
Only a holiday still to come: `HRMS_HOLIDAY_PAST` (409) otherwise, and `HRMS_HOLIDAY_IN_USE` (409) when an approved leave of
someone in that company covers it.

### C5. Weekly-off rules — `GET /api/hrms/weekly-offs?company=AE&employment=…`
Company defaults (`employment: null`) and person overrides, each `{ publicId, company, employment, validFrom, validTo, rule }`.

### C6. Set a weekly off — `POST /api/hrms/weekly-offs`
```json
{ "company": "AE", "validFrom": "2026-12-01", "rule": { "weekdays": [0], "nthWeekdays": [{ "weekday": 6, "nth": [2, 4] }] } }
```
Weekdays are 0 = Sunday … 6 = Saturday; this rule is every Sunday plus the 2nd and 4th Saturday. Send
`employmentPublicId` instead of `company` for one person's override. `validTo` is optional. The same company's (or job's)
rule that is still open and started earlier is ended the day before `validFrom`; any other overlap is refused with
`HRMS_WEEKLY_OFF_OVERLAP` (409). Stored work days from `validFrom` on are rebuilt (not locked ones).

### L1–L2. Leave types and my balances
`GET /api/hrms/leave/types` → `[{ code, name, isPaid }]`. `GET /api/hrms/leave/balances/mine` → one row per active job and
leave type: `{ employment: { publicId, company }, leaveType: { code, name }, balance }`. The balance is the sum of every
ledger row of that job and type (all years; there is no yearly lapse or carry-forward rule yet).

### L3. Apply — `POST /api/hrms/leave/requests`
```json
{ "publicId": "…", "employmentPublicId": "…", "leaveTypeCode": "GL", "fromDate": "2026-12-07", "toDate": "2026-12-09",
  "fromHalf": "second_half", "toHalf": "full", "reason": "Family function" }
```
On one of your own active jobs. `fromHalf` / `toHalf` default to `full`. Days are counted now from the job's calendar
(holidays and weekly offs skipped, half days count 0.5) and saved on the request. The approver is the job's manager; with
no manager the request has no approver and HR decides. Errors: `HRMS_LEAVE_OVERLAP` (409, submitted or approved leave on
this job already covers a date — another company's job may), `HRMS_LEAVE_NO_WORKING_DAYS` (400), `HRMS_NOT_YOUR_EMPLOYMENT`
(403), `HRMS_UNKNOWN_LEAVE_TYPE` (400), `HRMS_LEAVE_BALANCE` (409, only when the balance check is on — it is off by default).

### L4–L5. My requests, requests to approve
`GET /api/hrms/leave/requests/mine?status=` (newest first). `GET /api/hrms/leave/requests/to-approve`: submitted requests
naming you as approver (Supervisor), or everyone else's (HR).

### L6–L8. Approve, reject, cancel
- **Approve** (no body): never your own (`HRMS_SELF_APPROVAL`, 403); a Supervisor only when named as approver. In one
  transaction: `taken` ledger rows (negative, one per year the leave touches), status `approved`, and the work days rebuilt —
  a working day on leave shows `leave` (a day worked in full, or half worked beside half a day of leave, shows `present`).
- **Reject**: `{ "reason": "Busy week" }` (required).
- **Cancel**: `{ "reason": "…" }` (optional), by the person or HR. A submitted request is just cancelled. An approved one
  only if it starts today or later (`HRMS_LEAVE_STARTED`, 409 otherwise): `taken_reversal` rows give the days back and the
  work days are rebuilt. `HRMS_LEAVE_NOT_PENDING` / `HRMS_LEAVE_CLOSED` (409) when the status does not allow the step.

### L9. Opening balance or adjustment — `POST /api/hrms/leave/ledger/adjustments`
`{ "employmentPublicId": "…", "leaveTypeCode": "GL", "year": 2026, "entry": "opening", "days": 12, "reason": "Opening balance" }`.
`entry` is `opening` (one per job, type and year: `HRMS_OPENING_EXISTS`, 409) or `adjustment` (+ or −). Days in steps of 0.5;
a reason is required. HR only, and never on their own balance.

### L10. Report — `GET /api/hrms/leave/report?company=AE&from=2026-12-01&to=2026-12-31`
Submitted and approved requests that touch the dates (`rows`), `approvedDaysByType`, and `people`: per person and job the
approved days **inside the period** by leave type (`takenByType`) and the current balance by type (`balanceByType`).
HR sees everyone; a Supervisor themselves and the people they manage. `producedAt`; `&format=csv`: one line per
person, job and leave type.

### M1–M3. Month lock — `/api/hrms/month-locks`
HR locks an **ended** month for a company: `{ "company": "AE", "year": 2026, "month": 10 }` (`HRMS_MONTH_NOT_ENDED`,
`HRMS_MONTH_ALREADY_LOCKED`). The month's work days are locked, and nothing may change that month — punches,
corrections, leave (any day of the request), overtime — `HRMS_MONTH_LOCKED` (409); the database refuses punches and new
work days too. A System Admin unlocks: `POST …/:publicId/unlock` `{ "reason": "…" }` — who, when and why are kept, and
the work days are unlocked. Locking again adds a new record.

### S1–S7. Skills and certificates
HR keeps the skills list per company (optionally per department). A person adds their skill (`level`: trainee /
skilled / expert) and certificates (name, issuer, number, issued / expires dates, optional PDF / JPEG / PNG file);
their manager or HR verifies — never the person (`HRMS_SELF_VERIFICATION`). A changed level needs verifying again.
A certificate past its date shows as `expired` at once and cannot be verified (`HRMS_CERTIFICATE_EXPIRED`).
`GET /api/hrms/certificates/expiring?days=30` lists the valid ones expiring within the days given, with `daysLeft`.

**Daily job**: `pnpm --filter @ageless/backend build`, then `pnpm --filter @ageless/backend hrms:daily` once a day
(Windows Task Scheduler or cron). It stores certificates past their date as `expired` and prints how many expire within
30 days. Notifications come later.

### E1. Expense categories — `GET /api/hrms/expenses/categories`
`[ { "code": "food", "name": "Food", "receiptRequired": false }, { "code": "fuel", "name": "Fuel", "receiptRequired": true }, … ]`

### E2. Submit a claim — `POST /api/hrms/expenses`
Sent as **multipart/form-data** (a normal browser form with a file input):

| Field | Rule |
| --- | --- |
| `employmentPublicId` | one of **your own** jobs (from `GET /api/hrms/people/:yourId`) — someone else's gives `HRMS_NOT_YOUR_EMPLOYMENT` |
| `categoryCode` | `fuel` / `travel` / `food` / `materials` / `other` |
| `spentOn` | `YYYY-MM-DD` |
| `amountPaise` | whole paise above 0 (₹123.45 → `12345`) |
| `description` | optional, up to 500 characters |
| `publicId` | optional uuid made by the app; sending the same one again returns the stored claim (200) instead of a second claim |
| `receipt` (file) | JPEG, PNG or PDF, at most 5 MB; **required** when the category's `receiptRequired` is true |

The file's type is read from its content, not its name. It is saved as
`backend/uploads/receipts/<year>/<month>/<random uuid>.<ext>`; the claim stores that relative path in `receiptPath`.
Answer `201` with the claim:
```json
{
  "publicId": "7c1e…", "status": "submitted", "spentOn": "2026-01-10", "amountPaise": 12345,
  "person": { "publicId": "…0002", "displayName": "Demo Technician" },
  "employment": { "publicId": "…0102", "company": "AE", "employeeCode": "AE-D002" },
  "category": { "code": "fuel", "name": "Fuel" }, "description": "Diesel for site visit",
  "receiptPath": "receipts/2026/11/5f0c…png",
  "approvedAmountPaise": null, "approvedBy": null, "approvedAt": null,
  "rejectedBy": null, "rejectedAt": null, "rejectionReason": null,
  "paidAt": null, "paymentRef": null, "createdAt": "2026-11-03T09:12:44.120Z"
}
```
PowerShell (PowerShell 7+, or `curl.exe` on any Windows):
```powershell
curl.exe -X POST http://localhost:3000/api/hrms/expenses -H "Authorization: Bearer $($login.token)" `
  -F employmentPublicId=00000000-0000-4000-8000-000000000102 -F categoryCode=fuel -F spentOn=2026-01-10 `
  -F amountPaise=12345 -F "receipt=@C:\path\to\receipt.jpg"
```
Errors: `VALIDATION`, `HRMS_NOT_YOUR_EMPLOYMENT`, `HRMS_EMPLOYMENT_NOT_FOUND`, `HRMS_UNKNOWN_CATEGORY`,
`HRMS_RECEIPT_REQUIRED`, `HRMS_RECEIPT_TYPE`, `TOO_LARGE`, `HRMS_DUPLICATE_ID`.

### E3. My claims — `GET /api/hrms/expenses/mine?status=&page=&pageSize=`
Newest first; `status` optional (`submitted` / `approved` / `rejected` / `paid`). Answer `{ items, page, pageSize, total }`.

### E4. Claims for me to approve — `GET /api/hrms/expenses/to-approve`
Submitted claims on jobs whose **manager is you** (never your own), oldest first. Answer: a list of claims.

### E5. Approve — `POST /api/hrms/expenses/:publicId/approve`
Body: `{}` to approve the claimed amount, or `{ "approvedAmountPaise": 42000 }` for less. Who may: the manager of the
claim's job (Supervisor, scope team) or anyone with scope all (HR) — **never the claimant**. Sets `status: approved`,
`approvedBy`, `approvedAt`, `approvedAmountPaise`.
Errors: `HRMS_SELF_APPROVAL`, `FORBIDDEN` (not your team), `HRMS_APPROVED_TOO_HIGH`, `HRMS_CLAIM_NOT_PENDING`,
`HRMS_CLAIM_PAID`, `HRMS_CLAIM_NOT_FOUND`.

### E6. Reject — `POST /api/hrms/expenses/:publicId/reject`
Body: `{ "reason": "No bill for this meal" }` (3–500 characters, required). Same "who may" as E5. Sets
`status: rejected`, `rejectedBy`, `rejectedAt`, `rejectionReason`. A rejected claim is final (submit a new one).

### E7. Mark paid — `POST /api/hrms/expenses/:publicId/mark-paid`
Body: `{ "paymentRef": "NEFT-0001", "paidAt": "2026-11-03T10:00:00Z" }` (`paidAt` optional, default now). Only an
**approved** claim; HR (scope all). After this the claim **never changes** — the API answers `HRMS_CLAIM_PAID` and the
database refuses any update or delete of the row.

### E8. Report — `GET /api/hrms/expenses/report?company=AE&from=2026-01-01&to=2026-01-31`
By the date spent (`from`, `to` inclusive, required); `company` optional (all companies). HR (scope all). Also `rows`:
per person, category and status (paise), and `producedAt`. `&format=csv`: those rows in rupees with a TOTAL line.
```json
{
  "company": "AE", "from": "2026-01-01", "to": "2026-01-31",
  "byStatus":   [ { "status": "paid", "count": 1, "amountPaise": 10000 }, { "status": "submitted", "count": 1, "amountPaise": 2000 } ],
  "byCategory": [ { "code": "food", "name": "Food", "count": 1, "amountPaise": 2000, "approvedPaise": 0, "paidPaise": 0 },
                  { "code": "fuel", "name": "Fuel", "count": 1, "amountPaise": 10000, "approvedPaise": 9000, "paidPaise": 9000 } ],
  "total": { "count": 2, "amountPaise": 12000, "approvedPaise": 9000, "paidPaise": 9000 }
}
```
`amountPaise` = claimed; `approvedPaise` = approved amounts of approved + paid claims; `paidPaise` = approved amounts of paid claims.
---

## 8. Try it: a full walkthrough

With the API running (`pnpm --filter @ageless/backend dev`) and the seed loaded, paste this into PowerShell. It signs in
as Demo HR, creates a fictional person in your development database and goes through every People endpoint.
```powershell
$api = 'http://localhost:3000/api'
$login = Invoke-RestMethod -Method Post -Uri "$api/auth/login" -ContentType 'application/json' -Body (@{ login = 'demo.hr@example.com'; password = 'demo-pass-1' } | ConvertTo-Json)
$h = @{ Authorization = "Bearer $($login.token)" }
function Send($method, $path, $body) {
  $p = @{ Method = $method; Uri = "$api$path"; Headers = $h; ContentType = 'application/json' }
  if ($body) { $p.Body = $body | ConvertTo-Json -Depth 5 }
  Invoke-RestMethod @p
}

Send GET '/auth/me'                                                             # who am I

# 1. create (use a new employee code each time you run this)
$person = Send POST '/hrms/people' @{
  displayName = 'Demo Person'
  contacts    = @(@{ kind = 'phone'; value = '+91 00000 12345'; label = 'personal' })
  employment  = @{ legalEntityCode = 'AE'; employeeCode = 'AE-0101'; engagementType = 'permanent'; joinedOn = '2026-01-05'
                   managerPublicId = '00000000-0000-4000-8000-000000000001' }
}
$id = $person.publicId

Send GET "/hrms/people?search=demo%20person"                                    # 2. search
Send GET "/hrms/people/$id"                                                     # 3. view
Send PATCH "/hrms/people/$id" @{ displayName = 'Demo P.' }                       # 4. rename
Send POST "/hrms/people/$id/contacts" @{ kind = 'phone'; value = '+91 00000 99999'; isPrimary = $true }   # 5. add contact
Send GET '/hrms/contacts/shared?value=%2B91%2000000%2099999'                     # 8. who uses this number
$old = ((Send GET "/hrms/people/$id").contacts | Where-Object value -eq '+910000012345').publicId
Send POST "/hrms/contacts/$old/end"                                              # 7. end the old number
Send POST "/hrms/people/$id/employments" @{ legalEntityCode = 'ATPL'; employeeCode = 'ATPL-0042'; engagementType = 'contract'; joinedOn = '2026-02-01' }   # 6
$jobs = (Send GET "/hrms/people/$id").employments
$ae   = ($jobs | Where-Object { $_.company.code -eq 'AE' }).publicId
Send PATCH "/hrms/employments/$ae" @{ designation = 'Senior Technician' }       # 9. change job
Send POST "/hrms/employments/$ae/exit" @{ exitOn = '2026-06-30'; exitReason = 'Moved to ATPL full time' }   # 10. exit: ATPL becomes primary
```
Try the same calls signed in as `+91 00000 00001` (Demo Supervisor) or `demo.engineer@example.com` (Demo Engineer)
to see `403 FORBIDDEN` where their role doesn't allow it.
To start again from a clean database: `pnpm db:reset` then `pnpm db:seed`.

---

## 9. Tests

`pnpm test` runs 215 tests in 32 files. Before they run, `src/test/global-setup.ts` empties `TEST_DATABASE_URL`
(name must end in `_test`), applies every migration and runs the seed; the app under test only ever uses that database.
API tests sign in as the seeded demo people with `signIn(app, DEMO.hr.login)` from `src/test/create-app.ts`.

| File | Covers |
| --- | --- |
| `hrms/reports/reports.api.spec.ts` | month lock: punches, corrections, leave and overtime refused (and by the database), unlock only by System Admin with a reason, recorded, then changes allowed; expense, work-hours and leave CSV equal the screen |
| `hrms/skills/skills.api.spec.ts` | skills list per company; add and verify; changed level needs verifying; matrix filters and own scope; self-verification refused; certificate file; expiry list; daily job marks expired |
| `hrms/people/organisation.api.spec.ts` | ATPL departments and designations; codes per prefix (imports counted, ATH vs ATHR); transfer keeps the code; joining person can't punch, apply or claim until activated; offer letter; position planned → open → filled; department head approves |
| `platform/csv.spec.ts`, `hrms/attendance/domain/months.spec.ts`, `hrms/people/domain/employee-codes.spec.ts`, `hrms/skills/domain/certificates.spec.ts` | CSV escaping and rupees; months in a range; next employee code; certificate expiry |
| `platform/http/openapi.api.spec.ts` | every route has `@Doc`; the OpenAPI document has request and answer shapes, security and path parameters; real answers match the documented shapes |
| `src/app.api.spec.ts` | health without a token; 400 `VALIDATION` format; 401 `AUTH_MISSING` |
| `core/auth/auth.api.spec.ts` | sign-in by phone (any format) and email; same answer for wrong password and unknown login; `me`; missing / broken / expired token; routes without an access rule are closed; password change and reset end older tokens; a person with no active job loses access; employee, supervisor, HR and admin limits; new login + role, ending a role; login phone/email taken; no self-grant |
| `core/auth/domain/login.spec.ts` | login parsing, widest scope, token vs password change |
| `core/policies/policies.api.spec.ts` | seeded default in force; built-in default before any version; new version from its date; company before group; newest version wins; resend; wrong value / unknown key / no permission refused; versions can't be changed |
| `core/policies/domain/in-force.spec.ts` | which version is in force on a date |
| `hrms/people/people.api.spec.ts` | create; shared phone allowed; duplicate active job and duplicate employee code refused (nothing saved); search by name and phone; view has contacts and jobs, no internal ids |
| `hrms/people/contacts.api.spec.ts` | shared number lists both people; new primary replaces old; ended contact stays in history, no primary until another is set; rename and status change |
| `hrms/people/employments.api.spec.ts` | job in another company; exiting one company keeps the other active and moves primary; last exit makes person inactive; make primary; manager/department/designation; exit date and state checks |
| `hrms/expenses/expenses.api.spec.ts` | categories; submit with receipt file saved under uploads; someone else's job refused; amount must be whole paise > 0; receipt required by category; only JPEG/PNG/PDF by content; resend stored once; approval list for managers; approve claimed or lower amount, never higher; nobody decides their own claim; supervisor only for their team, HR for anyone; rejection needs a reason and is final; pay only approved, only with pay permission; paid claim can't change; database rules checked directly with SQL; report totals by company and dates, HR only |
| `hrms/attendance/overtime.api.spec.ts` | extra time without approval is not overtime; approved overtime capped at the extra time, cancel takes it back; planned overtime (future date allowed, applied when the day is built); nobody decides their own or one they filed; locked day refused when asking and approving; work hours show worked, extra and approved separately |
| `hrms/attendance/corrections.api.spec.ts` | missed punch-out fixed, day recalculated, punch-in unblocked, `lastMissedPunchDate`; wrong time left out and replaced, originals still stored and marked corrected, exclusions append-only; locked day refused (asking and approving); nobody decides their own or one they filed; one open correction per date, cancel and reject; validation |
| `hrms/attendance/domain/corrections.spec.ts` | times on the IST date, punches to add, allowed steps |
| `core/approvals/domain/approver.spec.ts` | approver chain: manager, department head, HR, CEO; never the person or who filed it |
| `hrms/attendance/attendance.api.spec.ts` | automatic punch-out after 8 hours unblocks the next punch-in (second punch-in within 8 hours still refused, overtime punch-out kept); resend stored once (and someone else's id refused); order enforced across two companies, including a late punch; someone else's job and future time refused; minutes with a lunch break; missed punch-out; today running time; punches can't be updated or deleted; locked day frozen and skipped by rebuild; rebuild repairs a day; register (present / absent); work hours over a range |
| `hrms/attendance/domain/day-summary.spec.ts` | minutes, first in / last out, missed punch, running today, extra time, approved overtime capped, weekly off / holiday not absent, open punch past the max hours, leave and absent days for every leave / work combination |
| `hrms/calendar/calendar.api.spec.ts` | Sundays and 2nd / 4th Saturdays off (register shows `weekly_off`); person override wins and rebuilds a worked day; resend; overlap refused; a later rule ends the open one; holiday shows as `holiday` (register, history after rebuild, calendar); duplicate date; only HR changes; past holiday and holiday in an approved leave can't be removed; leave days skip weekly offs and holidays |
| `hrms/calendar/domain/work-calendar.spec.ts` | nth Saturday, 5th weekday, person rule in force, no rule, holiday over weekly off, optional holiday |
| `hrms/leave/leave.api.spec.ts` | types; overlap refused on one job, allowed in the other company; resend; own approval refused, supervisor only for their team; approve takes days and work days show `leave`, cancel gives them back and clears the days; started leave can't be cancelled; weekend and half days; dates with no working day refused; rejection needs a reason; cancel before approval; opening / adjustment rules; report for HR and supervisor; approver fallback (manager, HR, CEO; never yourself); balance-check policy per company and date; full day worked on full leave |
| `hrms/leave/domain/requests.spec.ts` | days per year across the year end, fitting the parts to the saved days, which half of a date, balance check, allowed steps |
| `hrms/leave/leave-days.spec.ts` | leave day count: single day, half days, holidays, weekends, year end, bad input |
| `hrms/expenses/domain/claims.spec.ts` | receipt type from bytes, next allowed step, approved amount |
| `hrms/people/domain/*.spec.ts` | pure rules: phone/email clean-up, first-of-kind primary, exit date, next primary job |
| `hrms/attendance/domain/work-day-calculator.spec.ts` | work-day minutes and status |

Tests need the `ageless` login to be allowed to create databases (`CREATEDB`, set by `local-pc.sql`) and `JWT_SECRET`
in `backend/.env`.

---

## 10. Adding a new endpoint

1. **Shape** — add the Zod request schema and the answer schema (`export const X = z.object(...)` plus
   `export type X = z.infer<typeof X>`) to `shared/src/<module>/<area>.ts`, exported from `shared/src/index.ts`.
2. **Permission** — new permission codes are added to `core.permissions` by a migration (`INSERT` at the end of a new
   migration); give them to roles in `scripts/db-seed.mjs` for development.
3. **Table change?** — edit the sub-module's `schema.ts`, run `pnpm db:generate -- --name <what_changed>`, then `pnpm db:migrate`.
4. **Pure rules** — in `domain/`, with a `.spec.ts` next to them (no NestJS or database imports).
5. **Repository** — queries in `infrastructure/`; writes to `core.*` go through `CoreFacade`, passing the transaction.
6. **Service** — the use case in `application/`: open `this.db.transaction(...)` when more than one table changes, check
   the scope against the record (or `requireAll(ctx, permission)` for tenant-wide actions), throw
   `AppError('HRMS_…', status, message)` for rule failures.
7. **Controller** — in `api/`: mark the route `@Permission('…')` (or `@SignedIn()` / `@Public()` — unmarked routes are
   refused), `@Body(new ZodValidationPipe(Schema))`, `@Ctx() ctx: RequestContext`, call one service method.
   Constructors use `@Inject(Class)`. Register new controllers in the sub-module's `<name>.module.ts`.
   Add `@Doc({ summary: '…', response: X })` above the route (`file`, `csv`, `multipart`, `resend` when they apply);
   it then appears at `/api/docs`.
8. **API test** — `<name>.api.spec.ts` using `createTestApp(AppModule)` and `signIn(app, DEMO.hr.login)` from `src/test/`;
   test at least one caller who is refused.
9. Run `pnpm typecheck`, `pnpm test`, `pnpm boundaries`, `pnpm build`.

---

## 11. Not built yet

- **Resent requests** — creating a person has no client-made `publicId`, so sending it twice creates two people.
- **Account lockout** after wrong passwords — not wanted for now. Deactivating a login (`is_active`) has no endpoint yet.
- **Branch and department scopes** for roles — only own / team / all until branches and departments exist.
- **Attendance: corrections** — the automatic punch-out is added only when the next punch-in arrives (no background job yet), so until then the day shows a missed punch with 0 minutes; HR cannot file a correction for someone outside their team (only the person or their manager can).
- **Attendance: night shifts** — work days follow the IST calendar date; a shift past midnight splits into two days.
- **Attendance: geofencing, shifts** — punches record `not_taken` / `not_configured`. Work on a weekly off or holiday counts like any day (its extra time needs an overtime request like any other).
- **Calendar** — no edit or end endpoint for a weekly-off rule (a new rule ends the open one); no holiday is seeded.
- **Leave** — no department heads are set yet in the seed (HR sets them with `PATCH /api/hrms/departments/:publicId`); no drafts (apply submits); no partial cancel of a leave already running; no yearly grant, lapse or carry-forward.
- **Skills** — no skills are seeded (waiting for the list); no notifications for expiring certificates yet.
- **Month lock** — calendar changes (holidays, weekly offs) are not refused in a locked month; they skip its locked days.
- **Expenses: receipt download** — receipts are saved and the path stored, but there is no endpoint yet to fetch the file.
- **Expenses: limits per category or grade** — not checked yet (would come from `CoreFacade.getPolicy`); no link to service tickets yet.
- **Policies** — values are checked one key at a time (nothing stops a half day longer than a full day); a new version does not rebuild work days already stored (use rebuild); `max_open_punch_hours` (16) only limits the running time shown today; with the automatic punch-out at 8 hours it has little effect.
- **Tenant isolation in the database** (row-level security) and audit log — in the reference SQL, not built.
- **First admin on a real server** — the seed is development-only; a real server needs a one-off way to create the
  first System admin.
- **Web app** — `web/` holds the plan only.

---

## 12. Troubleshooting

| Problem | Fix |
| --- | --- |
| API won't start: "JWT_SECRET is not set" | Add `JWT_SECRET=<long random text>` to `backend/.env` (or the environment for `node backend/dist/main.js`) |
| `{"code":"INTERNAL"}` on every call except health and login | The API can't reach the database: check `DATABASE_URL` in `backend/.env` and that PostgreSQL is running on that port |
| `401 AUTH_MISSING` | Sign in (`POST /api/auth/login`) and send `Authorization: Bearer <token>` |
| `401 AUTH_INVALID` / `AUTH_EXPIRED` | Sign in again (password changed, person left, or 12 hours passed) |
| `401 AUTH_FAILED` with the demo logins | The seed is missing or old: `pnpm db:migrate` then `pnpm db:seed`; the password is `demo-pass-1` |
| `403 FORBIDDEN` | Your role lacks the permission or the person is outside your scope; check `GET /api/auth/me` |
| `pnpm db:generate -- --name x` ignores the name in PowerShell | Quote the separator: `npm run db:generate '--' --name x` |
| Tests fail with "TEST_DATABASE_URL is not set" | Add it to `backend/.env` (see `backend/.env.example`) |
| Tests fail creating the test database | The `ageless` login needs `CREATEDB`: `ALTER ROLE ageless CREATEDB;` as `postgres` |
| `EADDRINUSE` on start | Port 3000 is taken: stop the other server or set another `PORT` in `backend/.env` |
| `password authentication failed for user "ageless"` | Wrong port or password in `DATABASE_URL` — check which PostgreSQL install listens on that port |
