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
| Employments | Add a job in another company; change manager, department, designation; make a job primary; exit a job |
| Attendance | Punch in / out per job (resend-safe, order enforced across companies), today, my history, daily register, work hours, rebuild work days |
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
| `0007_hrms_attendance` | punches and work days get the job link; work day first in / last out; one work day per job and date; triggers: punches append-only, punch order per person, locked days frozen; 3 attendance permissions |
| `0006_hrms_expenses` | claims: job link, receipt path, approval / rejection / payment columns, rules below, paid claims frozen (trigger); category code unique; 4 expense permissions |

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
| `core.role_assignments` | a person holds a role with a scope, from / to dates | scope own/team/all; nobody grants a role to themselves; ended with `ended_at`, never deleted |
| `hrms.attendance_events` | punches: job, in/out, device time, received time, position | **never updated or deleted**; `public_id` unique (resend stored once); in/out alternate per person across jobs, out closes the same job's in (`HRMS_PUNCH_ORDER`) |
| `hrms.work_days` | one row per job per IST date, calculated from punches | one per job and date; status list; minutes 0–1440, overtime ≤ worked; **a locked day can't change** |
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

`…0001` means `00000000-0000-4000-8000-000000000001`. Tenant `1`, companies `AE` (Ageless Entertainments) and
`ATPL` (Ageless Technologies). Expense categories: `fuel`, `travel`, `materials`, `other` need a receipt; `food` does not.
Demo jobs: `…0101` Supervisor, `…0102` Technician, `…0103` Engineer, `…0104` HR, `…0105` Admin.

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
| 0 | `GET /api/hrms/{people,attendance,leave,expenses,skills,reports}/health` | Is the API up? | anyone, no token | 200 |
| A1 | `POST /api/auth/login` | Sign in | anyone, no token | 200 `{ token, expiresAt }` |
| A2 | `GET /api/auth/me` | Who am I, my roles and permissions | anyone signed in | 200 |
| A3 | `POST /api/auth/password` | Change my password | anyone signed in | 200 `{ token, expiresAt }` |
| U1 | `POST /api/core/users` | Create a login for a person | `core.users.manage` (all) | 201 `{ publicId }` |
| U2 | `POST /api/core/users/:publicId/reset-password` | Set a new password | `core.users.manage` (all) | 204 |
| U3 | `POST /api/core/role-assignments` | Give a person a role | `core.users.manage` (all) | 201 `{ publicId }` |
| U4 | `POST /api/core/role-assignments/:publicId/end` | End a role | `core.users.manage` (all) | 204 |
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
`shared/src/core/auth.ts`, `shared/src/hrms/people.ts` and `shared/src/hrms/expenses.ts`.

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
    "legalEntityCode": "AE",
    "employeeCode": "AE-0101",
    "engagementType": "permanent",
    "joinedOn": "2026-01-05",
    "department": "Service",
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
| `employment.employeeCode` | 1–20 characters, unique within that company |
| `employment.engagementType` | `permanent` / `probation` / `contract` / `intern` / `external` |
| `employment.joinedOn` | `YYYY-MM-DD` |
| `employment.department`, `designation` | optional, up to 80 |
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
      "primaryEmployment": { "company": "AE", "employeeCode": "AE-0101", "department": "Service",
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
      "department": "Service", "designation": "Technician",
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
| `department`, `designation` | new text, or `null` to clear |
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
Errors: `HRMS_PUNCH_ORDER` (409), `HRMS_NOT_YOUR_EMPLOYMENT`, `HRMS_EMPLOYMENT_NOT_ACTIVE`, `HRMS_PUNCH_IN_FUTURE`
(more than 5 minutes ahead), `HRMS_DUPLICATE_ID`, `VALIDATION`.

### T2. Today — `GET /api/hrms/attendance/today`
`{ "date": "2026-11-03", "punchedIn": true, "since": "2026-11-03T03:32:00.000Z", "employment": { "publicId": "…", "company": "AE" }, "workedMinutes": 95 }`
— `workedMinutes` counts today on all jobs, with the open punch-in counted up to now.

### T3. My history — `GET /api/hrms/attendance/history?from=2026-11-01&to=2026-11-30`
One row per day and company, newest first (at most 93 days). Today is calculated live: while punched in it shows
`"status": "working", "running": true` with the minutes so far.
```json
[ { "date": "2026-10-07", "employment": { "publicId": "…", "company": "AE", "employeeCode": "AE-0101" },
    "firstIn": "2026-10-07T03:30:00.000Z", "lastOut": "2026-10-07T13:00:00.000Z",
    "workedMinutes": 510, "overtimeMinutes": 30, "status": "present", "locked": false, "running": false } ]
```
Statuses: `present` (≥ 8 h), `half_day` (≥ 4 h), `absent` (less), `missed_punch` (an `in` without `out` that day),
`working` (today, still in). Full / half day and overtime thresholds are policy `hrms.attendance.day_rules`
(defaults 480 / 240 / 480 minutes).

### T4. Daily register — `GET /api/hrms/attendance/register?date=2026-11-03&company=AE`
Everyone with an active job (in that company, or all) and their day; no work day means `absent`; today is live.
Supervisors see themselves and the people they manage; HR sees everyone. Answer `{ date, company, rows, summary }`
where each row is a history row plus `person` and `summary` counts rows per status.

### T5. Work hours — `GET /api/hrms/attendance/work-hours?company=AE&from=2026-11-01&to=2026-11-30`
Per person and job over the range: `days: { present, halfDay, missedPunch, absent }`, `workedMinutes`, `overtimeMinutes`
(from stored work days). Same visibility as the register.

### T6. Rebuild work days — `POST /api/hrms/attendance/rebuild`
Body: `{ "personPublicId": "…", "from": "2026-11-01", "to": "2026-11-30" }` (or `employmentPublicId` for one job).
Recalculates every stored day in the range from its punches; locked days are skipped. HR and System admin (scope all).
Answer `{ "rebuilt": 12, "skippedLocked": 0 }`.
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
By the date spent (`from`, `to` inclusive, required); `company` optional (all companies). HR (scope all).
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

`pnpm test` runs 115 tests in 14 files. Before they run, `src/test/global-setup.ts` empties `TEST_DATABASE_URL`
(name must end in `_test`), applies every migration and runs the seed; the app under test only ever uses that database.
API tests sign in as the seeded demo people with `signIn(app, DEMO.hr.login)` from `src/test/create-app.ts`.

| File | Covers |
| --- | --- |
| `src/app.api.spec.ts` | health without a token; 400 `VALIDATION` format; 401 `AUTH_MISSING` |
| `core/auth/auth.api.spec.ts` | sign-in by phone (any format) and email; same answer for wrong password and unknown login; `me`; missing / broken / expired token; routes without an access rule are closed; password change and reset end older tokens; a person with no active job loses access; employee, supervisor, HR and admin limits; new login + role, ending a role; login phone/email taken; no self-grant |
| `core/auth/domain/login.spec.ts` | login parsing, widest scope, token vs password change |
| `hrms/people/people.api.spec.ts` | create; shared phone allowed; duplicate active job and duplicate employee code refused (nothing saved); search by name and phone; view has contacts and jobs, no internal ids |
| `hrms/people/contacts.api.spec.ts` | shared number lists both people; new primary replaces old; ended contact stays in history, no primary until another is set; rename and status change |
| `hrms/people/employments.api.spec.ts` | job in another company; exiting one company keeps the other active and moves primary; last exit makes person inactive; make primary; manager/department/designation; exit date and state checks |
| `hrms/expenses/expenses.api.spec.ts` | categories; submit with receipt file saved under uploads; someone else's job refused; amount must be whole paise > 0; receipt required by category; only JPEG/PNG/PDF by content; resend stored once; approval list for managers; approve claimed or lower amount, never higher; nobody decides their own claim; supervisor only for their team, HR for anyone; rejection needs a reason and is final; pay only approved, only with pay permission; paid claim can't change; database rules checked directly with SQL; report totals by company and dates, HR only |
| `hrms/attendance/attendance.api.spec.ts` | resend stored once (and someone else's id refused); order enforced across two companies, including a late punch; someone else's job and future time refused; minutes with a lunch break; missed punch-out; today running time; punches can't be updated or deleted; locked day frozen and skipped by rebuild; rebuild repairs a day; register (present / absent); work hours over a range |
| `hrms/attendance/domain/day-summary.spec.ts` | minutes, first in / last out, missed punch, running today, overtime |
| `hrms/leave/leave-days.spec.ts` | leave day count: single day, half days, holidays, weekends, year end, bad input |
| `hrms/expenses/domain/claims.spec.ts` | receipt type from bytes, next allowed step, approved amount |
| `hrms/people/domain/*.spec.ts` | pure rules: phone/email clean-up, first-of-kind primary, exit date, next primary job |
| `hrms/attendance/domain/work-day-calculator.spec.ts` | work-day minutes and status |

Tests need the `ageless` login to be allowed to create databases (`CREATEDB`, set by `local-pc.sql`) and `JWT_SECRET`
in `backend/.env`.

---

## 10. Adding a new endpoint

1. **Shape** — add the Zod request schema and response type to `shared/src/<module>/<area>.ts` (export it from `shared/src/index.ts`).
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
8. **API test** — `<name>.api.spec.ts` using `createTestApp(AppModule)` and `signIn(app, DEMO.hr.login)` from `src/test/`;
   test at least one caller who is refused.
9. Run `pnpm typecheck`, `pnpm test`, `pnpm boundaries`, `pnpm build`.

---

## 11. Not built yet

- **Resent requests** — creating a person has no client-made `publicId`, so sending it twice creates two people.
- **Account lockout** after wrong passwords — not wanted for now. Deactivating a login (`is_active`) has no endpoint yet.
- **Branch and department scopes** for roles — only own / team / all until branches and departments exist.
- **Attendance: corrections** — a forgotten punch-out blocks the next punch-in (order rule) until corrections exist (`source = 'correction'` is already let through by the trigger).
- **Attendance: night shifts** — work days follow the IST calendar date; a shift past midnight splits into two days.
- **Attendance: geofencing, shifts, holidays, leave** — punches record `not_taken` / `not_configured`; the register shows `absent` for holidays, weekly offs and leave until those exist.
- **Leave, skills, reports** — tables exist (from `0000_initial`), only health endpoints so far.
- **Expenses: receipt download** — receipts are saved and the path stored, but there is no endpoint yet to fetch the file.
- **Expenses: limits per category or grade** — not checked yet (would come from `CoreFacade.getPolicy`); no link to service tickets yet.
- **Policies** — `CoreFacade.getPolicy` returns the default value (e.g. 12-hour sign-in); no `core.policies` table yet.
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
