# Ageless platform — security

Written for developers and whoever runs the servers. Describes how the backend protects access and data as of
2026-11-06, where in the code each rule lives, and the known gaps to close before going live. Endpoints are in
[api/README.md](api/README.md); tables, constraints and triggers in [database/schemas.md](database/schemas.md) and
[database/connections.md](database/connections.md).

## Contents
- [At a glance](#at-a-glance)
- [Sign-in and tokens](#sign-in-and-tokens)
- [Who may do what](#who-may-do-what)
- [Roles and permissions](#roles-and-permissions)
- [Separation of tenants and companies](#separation-of-tenants-and-companies)
- [Nobody approves their own request](#nobody-approves-their-own-request)
- [Records that cannot be changed](#records-that-cannot-be-changed)
- [Personal and sensitive data](#personal-and-sensitive-data)
- [Input, files and output](#input-files-and-output)
- [Errors and logs](#errors-and-logs)
- [Audit log](#audit-log)
- [Settings and secrets](#settings-and-secrets)
- [Development data](#development-data)
- [Known gaps](#known-gaps)

## At a glance

| Layer | Protection | Where |
| --- | --- | --- |
| Sign-in | phone or email + password (bcrypt), JWT with an expiry from policy; failed sign-ins limited per account and per IP with a brief lockout | `src/modules/core/auth` |
| Every request | global guard: no route is open unless it says so; the login, the person and today's roles are reloaded on every request | `core/auth/api/auth.guard.ts` |
| Permissions | permission codes held through roles, each with a scope (own / team / all), checked by the guard and again against the record by the service | `platform/http/request-context.ts`, each module's `domain/permissions.ts` |
| Data separation | every table has `tenant_id`; company-owned tables have `legal_entity_id` with composite foreign keys | services and repositories; database constraints |
| Business rules | nobody approves their own request; history is never edited or deleted | services, CHECK constraints, triggers |
| Sensitive data | Aadhaar, PAN and bank numbers masked; full view only for Management, audited; never logged | `hrms/people/application/private.service.ts` |
| Input | every body, query and path value validated with Zod schemas from `shared/` | `platform/http/zod-validation.pipe.ts` |
| Files | size limits, type read from the bytes, random file names, served only through checked endpoints | `platform/storage.ts` |
| Errors | one format; unexpected errors give no internals | `platform/http/error.filter.ts` |

## Sign-in and tokens

- **Sign-in:** `POST /api/auth/login` with `{ login, password }`. The login is a phone (stored without spaces, dashes,
  dots or brackets) or an email (stored lower-case). Unknown login, wrong password and a login that may no longer be
  used all give the same answer, `401 AUTH_FAILED`. When the login is unknown, the password is still compared against
  a dummy hash, so both cases take the same time.
- **Sign-in limits** (`core/auth/domain/throttle.ts`): failed sign-ins are counted **per account** (the login typed, in
  its stored form) and **per IP address**. 5 failures for one account, or 30 from one address, within 15 minutes lock
  that account or address for 15 minutes: every sign-in then answers `429 AUTH_LOCKED` with a `Retry-After` header and
  `details.retryAfterSeconds`, **even with the right password**.
  - An unknown login is counted and locked exactly like a real one, so the answers never tell whether an account
    exists.
  - A successful sign-in clears the account's count. The address count stays, so signing in to your own account
    between guesses does not reset it.
  - A login manager's password reset (`POST /api/core/users/:id/reset-password`) also lifts the account's lockout.
  - The counts live in `core.login_throttle`, keyed by an HMAC (with `JWT_SECRET`) of the login or address: the table
    never holds a phone number, email or IP address. Old counts are forgotten after a day.
  - The four numbers are settings (`LOGIN_MAX_FAILURES`, `LOGIN_MAX_FAILURES_PER_IP`, `LOGIN_WINDOW_MINUTES`,
    `LOGIN_LOCKOUT_MINUTES`). The per-address limit is higher because an office shares one address.
  - **Behind a reverse proxy, set `TRUST_PROXY`** (e.g. `1`), so the client's address is read from `X-Forwarded-For`.
    Without it every request seems to come from the proxy, and 30 failures from anyone would lock everyone.
- **Passwords:** bcrypt with 10 rounds (`BCRYPT_ROUNDS`). 8 to 72 characters (bcrypt reads only 72 bytes, so longer
  passwords are refused rather than silently cut). Passwords are never stored or returned in plain text.
- **Token:** a JWT signed with `JWT_SECRET` (HS256, the `@nestjs/jwt` default). It holds only the login's public id and
  the tenant id. It lasts for the policy `core.auth.session_hours` (default 12 hours). The app refuses to start without
  `JWT_SECRET`.
- **Every request** sends `Authorization: Bearer <token>`. The guard checks the signature and expiry, then reloads
  the login and person from the database. A token stops working at once when:
  - the login is deactivated or the person is no longer active (an inactive person has no active job);
  - the password is changed or reset: tokens issued before the change are refused (`issuedAfterPasswordChange`);
  - it expires (`401 AUTH_EXPIRED`).
- **Roles take effect immediately:** permissions are not stored in the token. They are read from today's role
  assignments on every request, so giving or ending a role applies to the very next call.
- **Changing your password** (`POST /api/auth/password`) needs the current password and answers with a fresh token.
  A login manager can reset another person's password (`POST /api/core/users/:id/reset-password`). There is no refresh
  token and no logout endpoint: signing out means the app forgets the token.

## Who may do what

1. **Every route declares who may call it**, or the guard refuses it with `403` (and logs the route as missing a rule):
   - `@Public()`: no sign-in (only sign-in itself, health checks, API docs);
   - `@SignedIn()`: anyone signed in (the service then checks the record, e.g. "your own");
   - `@Permission('code', ...)`: the caller must hold one of these permissions.
   A test (`platform/http/openapi.api.spec.ts`) fails when a route has no documentation, so every route is also listed in
   [api/README.md](api/README.md) with its rule.
2. **Scope is checked against the record** by the service. A permission is held with a scope:
   - `own`: yourself only;
   - `team`: yourself, plus the people you manage (or, for tickets, the departments you head and tickets you supervise);
   - `all`: the whole tenant.
   A person may hold the same permission through several roles; the widest scope counts. Tenant-wide actions call
   `requireAll(ctx, permission)` and refuse anything less than `all`.
3. **Things you may not see answer `404`**, not `403`, where telling them apart would reveal that the record exists
   (e.g. a ticket you are not on).
4. **Management** (the `hrms.management` permission with scope all) reads every HRMS and payroll record and may decide
   any pending request, never their own. It is recorded as `decided_as = management`.

## Roles and permissions

Permission codes are rows in `core.permissions`, added by migrations. Which role has which permission is data: the
development seed sets it as below, and a login manager (`core.users.manage`) gives people roles with a scope through
`POST /api/core/role-assignments`. **Nobody can give a role to themselves** (`CORE_SELF_GRANT`, and the database check
`role_assignments_not_self`). Ending a role keeps it as history.

Roles in the development seed (tenant 1). The scope comes from each person's role assignment, e.g. Employee = own,
Supervisor = team, HR = all.

| Permission | What it allows | employee | supervisor | payroll | payroll_approver | hr | admin_user | system_admin | ceo | management |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `core.policies.manage` | See company policies and add new versions |  |  |  |  | ✓ |  | ✓ |  |  |
| `core.users.manage` | Create logins, reset passwords, give and end roles |  |  |  |  |  |  | ✓ |  |  |
| `hrms.attendance.approve` | Approve or reject attendance corrections (team: corrections that name you as approver) |  | ✓ |  |  | ✓ |  |  | ✓ | ✓ |
| `hrms.attendance.punch` | Punch in and out on your own jobs; see your own today and history | ✓ | ✓ |  |  | ✓ |  |  | ✓ |  |
| `hrms.attendance.rebuild` | Recalculate work days from punches |  |  |  |  | ✓ |  | ✓ |  |  |
| `hrms.attendance.view` | Daily register and work hours (team: people you manage) |  | ✓ |  |  | ✓ |  |  |  | ✓ |
| `hrms.calendar.manage` | Add and remove holidays; set weekly offs for a company or a person |  |  |  |  | ✓ |  |  |  |  |
| `hrms.contacts.manage` | Add and end phone numbers and emails |  |  |  |  | ✓ |  |  |  |  |
| `hrms.contacts.review` | See everyone who shares a phone number or email |  |  |  |  | ✓ |  |  |  |  |
| `hrms.dashboard.view` | HRMS dashboard (team: people you manage; all: every company) |  | ✓ |  |  | ✓ |  |  |  | ✓ |
| `hrms.employments.manage` | Add jobs in other companies and exit jobs |  |  |  |  | ✓ |  |  |  |  |
| `hrms.employments.update` | Change manager, department, designation or primary job |  | ✓ |  |  | ✓ |  |  |  |  |
| `hrms.expenses.approve` | Approve or reject expense claims (team: claims on jobs you manage) |  | ✓ |  |  | ✓ |  |  |  | ✓ |
| `hrms.expenses.pay` | Mark approved expense claims as paid |  |  |  |  | ✓ |  |  |  |  |
| `hrms.expenses.report` | Expense report by company and dates |  |  |  |  | ✓ |  |  |  | ✓ |
| `hrms.expenses.submit` | Submit and see your own expense claims | ✓ | ✓ |  |  | ✓ |  |  | ✓ |  |
| `hrms.leave.apply` | Apply for leave on your own jobs; see and cancel your own requests and balances | ✓ | ✓ |  |  | ✓ |  |  | ✓ |  |
| `hrms.leave.approve` | Approve or reject leave (team: requests that name you as approver) |  | ✓ |  |  | ✓ |  |  | ✓ | ✓ |
| `hrms.leave.manage` | Post opening balances and adjustments; cancel anyone's approved leave |  |  |  |  | ✓ |  |  |  |  |
| `hrms.leave.report` | Leave report by company and dates (team: people you manage) |  | ✓ |  |  | ✓ |  |  | ✓ | ✓ |
| `hrms.management` | Management: read every HRMS record (and payroll) in the companies of the scope |  |  |  |  |  |  |  |  | ✓ |
| `hrms.month.lock` | Lock a company's month for payroll |  |  |  |  | ✓ |  |  |  |  |
| `hrms.month.unlock` | Unlock a locked month (with a reason) |  |  |  |  |  |  | ✓ |  |  |
| `hrms.people.create` | Create people with their first job |  |  |  |  | ✓ |  |  |  |  |
| `hrms.people.update` | Change a person's display name and status |  |  |  |  | ✓ |  |  |  |  |
| `hrms.people.view` | View people, their contacts and jobs | ✓ | ✓ |  |  | ✓ |  | ✓ | ✓ | ✓ |
| `hrms.positions.manage` | Plan, open and fill positions |  |  |  |  | ✓ |  |  |  |  |
| `hrms.private.manage` | Enter or change private details (Aadhaar, PAN) |  |  |  |  | ✓ |  |  |  |  |
| `hrms.private.reveal` | Reveal private details in full (each reveal is audited) |  |  |  |  |  |  |  |  | ✓ |
| `hrms.private.view` | See private details (Aadhaar, PAN, bank) masked |  |  |  |  | ✓ |  |  |  | ✓ |
| `hrms.skills.add` | Add skills and certificates (own: yours; team: people you manage) | ✓ | ✓ |  |  | ✓ |  |  |  |  |
| `hrms.skills.manage` | Keep the skills list; see expiring certificates and any certificate file |  |  |  |  | ✓ |  |  |  |  |
| `hrms.skills.verify` | Verify skills and certificates (team: people you manage); never your own |  | ✓ |  |  | ✓ |  |  |  |  |
| `hrms.skills.view` | Skills matrix (own: yourself; team: people you manage) | ✓ | ✓ |  |  | ✓ |  |  |  | ✓ |
| `payroll.approve` | Approve a payroll run prepared by someone else; see salaries and runs |  |  |  | ✓ |  |  |  |  |  |
| `payroll.payslip.own` | See and download your own payslips | ✓ | ✓ | ✓ | ✓ | ✓ |  |  | ✓ | ✓ |
| `payroll.prepare` | Salaries, bank details and payroll runs: prepare, adjust, mark paid; see them and their files |  |  | ✓ |  |  |  |  |  |  |
| `tickets.manage` | Create and run tickets: scope all (admin user, Management) every ticket; otherwise a department head for their departments |  | ✓ |  |  |  | ✓ |  |  | ✓ |
| `tickets.numbering.manage` | Set each company's ticket number prefix and next number |  |  |  |  | ✓ |  |  |  |  |
| `tickets.report` | Download the full report of a ticket as a PDF (photos included): a ticket you manage (Manager role, department head: you head its department, created or supervise it) or any ticket (Management). Each download is logged in the ticket's history |  |  |  |  |  |  |  |  | ✓ |
| `tickets.time.adjust` | Review ticket time: move a person's daily minutes between tickets with a reason (team: tickets of departments you head; all: every ticket). Never your own time |  | ✓ |  |  |  |  |  |  | ✓ |
| `tickets.types.manage` | Ticket types: scope all (admin user, Management) manages every type, standard ones too; otherwise a department head manages the non-standard types their department owns |  | ✓ |  |  |  | ✓ |  |  | ✓ |
| `tickets.types.view` | See ticket types (read only) | ✓ | ✓ |  |  | ✓ | ✓ |  | ✓ | ✓ |
| `tickets.view` | See tickets: own = where you are an assignee; team = also your departments and the tickets you supervise; all = every ticket | ✓ | ✓ |  |  | ✓ | ✓ |  |  | ✓ |
| `tickets.work` | Work on tickets you are assigned to: start, checklist, files, sign-off, daily updates, ask for reassignment; complete as primary | ✓ | ✓ |  |  |  |  |  |  |  |

Payroll is split across two roles on purpose: the person who prepares a run cannot approve it (see below).

## Separation of tenants and companies

- **Tenants.** Every table has `tenant_id`, and every query in the services and repositories filters by the caller's
  tenant (`ctx.tenantId`, taken from the login, never from the request). A record of another tenant is answered as
  not found. This is enforced **in the application**: the database has no row-level security yet (see
  [Known gaps](#known-gaps)).
- **Companies (AE, ATPL …).** Company-owned tables have `legal_entity_id` and **composite foreign keys**
  `(x_id, legal_entity_id)` to the job, ticket, department, type version or skill they point at. The database
  itself therefore refuses, for example, an AE ticket assigned to an ATPL job, or a payroll item for another company's
  job. The full list is in [database/connections.md](database/connections.md#company-safe-foreign-keys).
- **Records in APIs are public ids** (uuids). Internal ids never leave the server, so they cannot be guessed or walked
  through.

## Nobody approves their own request

Enforced by the services **and** by database CHECK constraints, so no code path can get round it:

| Rule | Database check |
| --- | --- |
| Leave, attendance corrections, overtime: the approver is never the requester, and nobody decides their own | `leave_requests_not_own_approver`, `leave_requests_not_own_decision`, `attendance_corrections_not_own_*`, `overtime_requests_not_own_*` |
| Expense claims: never approved or rejected by the claimant | `expense_claims_not_self_approved`, `expense_claims_not_self_rejected` |
| Payroll run: never approved by whoever prepared it last | `payroll_runs_not_own_approval` |
| Skills and certificates: never verified by their owner | `person_skills_not_self_verified`, `certificates_not_self_verified` |
| Roles: nobody gives themselves a role | `role_assignments_not_self` |
| A manager is never their own manager | `employments_manager_not_self` |
| Ticket reassignment: never decided by the person who asked | `reassign_requests_not_own_approver`, `reassign_requests_not_own_decision` |
| Ticket time: nobody adjusts their own (Management included) | `ticket_time_adjustments_not_own` |

The services add the rules that need more context: a head's ticket approval is refused if they are assigned to the
ticket; nobody but Management assigns themselves to a ticket or picks themselves when approving a reassignment. The
CEO's own leave, expense, correction and overtime requests need no approval (policy `hrms.approvals.auto_approve_roles`);
they are recorded as `decided_as = no_approval_required` with no decider.

## Records that cannot be changed

History is kept: records are ended, exited, deactivated or cancelled, never deleted. Where it matters, **database
triggers** refuse changes whatever code runs. Examples (the full list is in
[database/connections.md](database/connections.md#triggers)):

- punches (`hrms.attendance_events`), punch exclusions, the leave ledger, policies, salaries, bank accounts and the
  audit log are append-only;
- a paid expense claim, an approved payroll run, and a locked work day / month can no longer change;
- saved ticket type versions are never edited; ticket timelines, checklist answers, files, sign-offs, links, daily
  updates and time adjustments are append-only; a ticket timer is only closed, once; tickets, assignments and
  reassignment requests are never deleted;
- staff can never edit their own punches or ticket time: corrections go through a request approved by someone else,
  and ticket time only through a head's adjustment with a reason.

## Personal and sensitive data

- **Aadhaar, PAN, bank account numbers** (`hrms.person_private`, `payroll.bank_accounts`): HR and Management see them
  masked; only Management (`hrms.private.reveal`) can see them in full, and every reveal is written to the audit log
  (who, whose, when). The values themselves never go into the audit log or any other log. Account numbers appear in
  full only in the bank upload file of an approved payroll run.
- **Salaries and payroll** are visible only to the payroll roles and Management; everyone else sees only their own
  payslips.
- **Locations.** Punches may carry coordinates. They are stored with the punch (`core.places`), shown back only to the
  person in the punch confirmation, and never logged. When a geocoding provider is configured, the coordinates are sent
  to that provider (OpenStreetMap Nominatim or Google) to get an address; with `GEOCODING_PROVIDER=none` (the default)
  nothing leaves the server.
- **Phone numbers, bank and ID numbers and exact locations are never logged** (project rule 7). Background jobs print
  counts only.
- **Real staff data never goes into seeds or tests.** Test data uses made-up names, `+91 00000 …` phone numbers and
  `@example.com` emails.

## Input, files and output

- **Validation.** Every body, query string and path parameter goes through a Zod schema from `@ageless/shared` before
  any code runs. Anything that does not fit is refused with `400 VALIDATION`. Ids must be uuids; dates, amounts and
  lengths are bounded.
- **Database access** goes through Drizzle ORM with parameters; raw SQL fragments use Drizzle's `sql` template, which
  also passes values as parameters. No SQL is built from strings.
- **File uploads** (receipts, offer letters, certificates, ticket photos and files, sign-off sheets, daily-update files):
  - kept in memory with a size limit (5 MB for HRMS files, 10 MB for ticket files) and a fixed number of files;
  - the type is read from the first bytes (JPEG, PNG, PDF), never from the file name or the client's content type;
  - saved under the uploads folder (`UPLOAD_DIR`, outside the code and git-ignored) with a random name; the uploaded
    file name is never used; the database stores only the relative path;
  - removed again if the record cannot be saved;
  - downloaded only through endpoints that check the caller may see the record.
- **CSV exports** prefix any cell starting with `=`, `+`, `-` or `@` with `'`, so a spreadsheet does not run it as a
  formula.
- **Resends.** Records made on a device carry their own `publicId`; sending the same one again returns the stored
  record instead of creating a second (double clicks, retries on a bad connection). Another person's `publicId` is
  refused (`*_DUPLICATE_ID`).

## Errors and logs

- Every error leaves the API as `{ code, message, details? }`. Known errors carry a stable code.
- An unexpected error answers `500 { code: "INTERNAL", message: "Something went wrong" }`; the stack trace goes only to
  the server log.
- The guard logs a route that has no access rule (a programming mistake), without request data.

## Audit log

`core.audit_log` is append-only (trigger) and records who did what, to whose record, in which company, with a readable
summary. It is written in the same transaction as the change. Today it records, for example: decisions on leave,
expenses, attendance corrections and overtime; reveals and changes of private details; ticket type changes. Ticket
changes are recorded on each ticket's own append-only timeline (`tickets.ticket_events`).

## Settings and secrets

All settings come from `backend/.env` (see `backend/.env.example`), which is git-ignored; secrets are never committed
or written in code.

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` / `TEST_DATABASE_URL` | database connections; tests refuse a database whose name does not end in `_test` |
| `JWT_SECRET` | signs login tokens; long and random, different on every server |
| `PORT` | API port |
| `API_DOCS=off` | hides `/api/docs` and `/api/docs.json` (on by default) |
| `UPLOAD_DIR` | where uploaded files are kept (default `backend/uploads`) |
| `GEOCODING_PROVIDER`, `GEOCODING_URL`, `GEOCODING_API_KEY`, `GEOCODING_TIMEOUT_MS` | address lookup for punch locations |
| `LOGIN_MAX_FAILURES`, `LOGIN_MAX_FAILURES_PER_IP`, `LOGIN_WINDOW_MINUTES`, `LOGIN_LOCKOUT_MINUTES` | sign-in limits (defaults 5, 30, 15, 15) |
| `TRUST_PROXY` | set behind a reverse proxy (number of proxies, e.g. `1`), so the client's address is used for the sign-in limit |

Company rules that are not final (session length, shifts, leave, overtime, open-punch limit …) are versioned policies
in `core.policies`, changed only by adding a new version (`core.policies.manage`).

## Development data

- `pnpm db:seed` and `pnpm db:reset` refuse to run unless the database name starts with `dev_`, `ageless_dev`,
  `ageless_test` or `platform_test`, so they cannot touch a real database by mistake.
- The demo logins share the password `demo-pass-1`, for development only. They must never exist on a server with real
  data.

## Known gaps

Things to decide or close before the platform holds real data on a reachable server:

| Gap | Risk | Suggested fix |
| --- | --- | --- |
| No CORS configuration and no security headers | the web app must be served from the same origin as the API; no `helmet`-style headers | decide the web app's origin and configure CORS for it; add standard security headers (both mean adding a package or middleware, so they need agreeing first) |
| HTTPS is not handled by the app | tokens and data would travel in clear text without a proxy | run behind a reverse proxy (IIS / nginx) with TLS only |
| Tenant separation is in the application only | a missed `tenant_id` filter in new code would leak across tenants. `platform/db/db.module.ts` says each request sets `app.tenant_id`, but nothing does that yet | either add PostgreSQL row-level security per tenant, or correct that comment and keep reviewing queries |
| `hrms.expense_claims.ticket_id` and `hrms.overtime_requests.ticket_id` are single-column keys | a claim or overtime could name another company's ticket (rule 9 asks for company-safe keys) | a migration replacing them with `(ticket_id, legal_entity_id)` keys to `tickets.tickets` |
| Tokens cannot be revoked one at a time | a stolen token works until it expires (12 h by default) unless the password is changed or the login deactivated | shorter sessions, or a server-side token list if needed |
| No password strength rules beyond length 8–72 | weak passwords | add a check of common passwords, or require a passphrase |
| API docs are public by default | anyone can read the API's shape (not data) | set `API_DOCS=off` on public servers |
| Uploaded files are not scanned | a harmful PDF could be stored and downloaded by staff | scan uploads, or open PDFs only in a viewer |
| Coordinates go to the geocoding provider when one is set | location data shared with a third party | prefer a self-hosted Nominatim (`GEOCODING_URL`), or keep `none` |
