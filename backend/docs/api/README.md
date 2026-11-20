# Ageless platform — API reference

Written for developers of the web and mobile apps and of the backend. Generated on 2026-11-06 from the running app's own
route metadata and OpenAPI document (the same data as `/api/docs`), so every path, permission and schema below is what the
code does today. The narrative guides for the larger areas are [people.md](people.md) and [tickets.md](tickets.md);
security is in [../security.md](../security.md); the database in [../database/schemas.md](../database/schemas.md).

## Contents
- [Conventions](#conventions)
- [Endpoint index](#endpoint-index)
- [Sign-in (core / auth)](#sign-in-core--auth)
- [Core: logins, roles, policies](#core-logins-roles-policies)
- [HRMS](#hrms)
- [Payroll](#payroll)
- [Tickets](#tickets)
- [Schemas](#schemas)
- [Error codes](#error-codes)

## Conventions

| Topic | Rule |
| --- | --- |
| Base URL | `http://localhost:3000/api` in development (`PORT` in `backend/.env`). Every path below starts with `/api`. |
| Live docs | Swagger UI at `/api/docs`, raw OpenAPI 3 at `/api/docs.json` (turned off with `API_DOCS=off`). |
| Sign-in | `POST /api/auth/login` with `{ login, password }` (phone or email) answers `{ token, expiresAt }`. Send `Authorization: Bearer <token>` on every other call. |
| Who may call | Every route declares it: **public**, **any signed-in user**, or a **permission** (any one of those listed). The permission's scope (`own`, `team`, `all`) is then checked against the record by the service. See [security.md](../security.md). |
| Records | Identified by `publicId` (uuid) in paths, bodies and answers — never by internal ids. |
| Request bodies | JSON, validated by the Zod schemas in `shared/` (`@ageless/shared`). Unknown or wrong fields: `400 VALIDATION` with `details`. |
| File uploads | `multipart/form-data` where marked; the file field is named in the endpoint; type checked from the bytes (JPEG, PNG, PDF). |
| Resends | Create calls marked *resend* accept a client-made `publicId`: sending the same one again answers `200` with the stored record instead of creating a second. |
| CSV | Report endpoints marked *CSV* answer a CSV download with `format=csv` (UTF-8 with BOM, "about" lines, then the table and a TOTAL line). |
| Money | Integer **paise** with a `currency` (INR). |
| Time | Instants are UTC ISO strings (`2026-11-04T03:30:00.000Z`); dates are `YYYY-MM-DD`; work dates are Indian dates (Asia/Kolkata). |
| Errors | Always `{ code, message, details? }` with the HTTP status; see [Error codes](#error-codes). `401` = not signed in or token invalid / expired; `403` = no permission or a rule (e.g. self-approval); `404` = not found or not visible to you; `409` = conflicts with the stored state; `429 AUTH_LOCKED` = sign-in locked for a while; `500 INTERNAL` = unexpected (details only in the server log). |

## Endpoint index

159 endpoints.

| Method | Path | Who may call | Summary |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | public (no sign-in) | Sign in with a login phone or email and password |
| `POST` | `/api/auth/machine-token` | public | A machine credential (the Tally connector) signs in with its client id and secret; a 15-minute token that opens only that credential's own routes |
| `GET` | `/api/auth/me` | any signed-in user | Who am I: person, login, roles and permissions (widest scope per permission) |
| `POST` | `/api/auth/password` | any signed-in user | Change my password; older tokens stop working |
| `POST` | `/api/core/role-assignments` | `core.users.manage` | Give a person a role with a scope (own / team / all); never to yourself |
| `POST` | `/api/core/role-assignments/{publicId}/end` | `core.users.manage` | End a role (kept as history) |
| `POST` | `/api/core/users` | `core.users.manage` | Create a login for a person (phone, email or both) |
| `POST` | `/api/core/users/{publicId}/reset-password` | `core.users.manage` | Set a new password; the person's tokens stop working |
| `GET` | `/api/core/policies` | `core.policies.manage` | Stored policy versions, newest first |
| `POST` | `/api/core/policies` | `core.policies.manage` | Add a new version of a policy (versions are never changed) |
| `GET` | `/api/core/policies/in-force` | `core.policies.manage` | The value of a policy in force on a date (company first, then group, then default) |
| `GET` | `/api/hrms/approvals/mine` | any signed-in user | Everything waiting for my decision (leave, expenses, corrections, overtime), oldest first, with counts per type |
| `GET` | `/api/hrms/calendar` | `hrms.people.view` | One job's days: working, weekly off or holiday (at most 366 days) |
| `GET` | `/api/hrms/calendar/health` | public (no sign-in) |  |
| `GET` | `/api/hrms/certificates/expiring` | `hrms.skills.manage` or `hrms.management` | Certificates expiring within the next days (HR) |
| `GET` | `/api/hrms/certificates/{publicId}/file` | any signed-in user | Download a certificate file (the person, their manager or HR) |
| `POST` | `/api/hrms/certificates/{publicId}/verify` | `hrms.skills.verify` | Verify a certificate (never your own; not when expired) |
| `GET` | `/api/hrms/dashboard` | `hrms.dashboard.view` or `hrms.management` | HRMS dashboard for a month: your team (supervisor) or everyone (HR, Management); one company or all you may see |
| `GET` | `/api/hrms/departments` | any signed-in user | Departments of a company, with heads |
| `POST` | `/api/hrms/departments` | `hrms.employments.manage` | Add a department (name and employee-code prefix) |
| `PATCH` | `/api/hrms/departments/{publicId}` | `hrms.employments.manage` | Rename a department or set its head |
| `GET` | `/api/hrms/designations` | any signed-in user | Designations of a company |
| `GET` | `/api/hrms/holidays` | any signed-in user | Holidays of a year |
| `POST` | `/api/hrms/holidays` | `hrms.calendar.manage` | Add a holiday to a company's year (stored days are rebuilt) |
| `DELETE` | `/api/hrms/holidays/{publicId}` | `hrms.calendar.manage` | Remove a holiday still to come and not in an approved leave |
| `POST` | `/api/hrms/people/{publicId}/certificates` | `hrms.skills.add` | Add a certificate with an optional file (PDF, JPEG or PNG) |
| `POST` | `/api/hrms/people/{publicId}/skills` | `hrms.skills.add` | Add a person's skill or change its level (needs verifying again) |
| `POST` | `/api/hrms/person-skills/{publicId}/verify` | `hrms.skills.verify` | Verify a skill (never your own) |
| `GET` | `/api/hrms/positions` | `hrms.positions.manage` or `hrms.management` | Positions (planned, open, filled) |
| `POST` | `/api/hrms/positions` | `hrms.positions.manage` | Plan or open a position in a department |
| `POST` | `/api/hrms/positions/{publicId}/fill` | `hrms.positions.manage` | Fill a position with the hired person's employment |
| `POST` | `/api/hrms/positions/{publicId}/status` | `hrms.positions.manage` | Move a position between planned and open |
| `GET` | `/api/hrms/skills` | any signed-in user | Skills list of a company, by department |
| `POST` | `/api/hrms/skills` | `hrms.skills.manage` | Add a skill to the list |
| `GET` | `/api/hrms/skills/health` | public (no sign-in) |  |
| `GET` | `/api/hrms/skills/matrix` | `hrms.skills.view` | Skills matrix: people with skills and certificates (own, team or all) |
| `GET` | `/api/hrms/weekly-offs` | `hrms.calendar.manage` or `hrms.management` | Weekly-off rules: company defaults and person overrides |
| `POST` | `/api/hrms/weekly-offs` | `hrms.calendar.manage` | Set a company's or a person's weekly off from a date |
| `GET` | `/api/hrms/attendance/health` | public (no sign-in) |  |
| `GET` | `/api/hrms/attendance/history` | `hrms.attendance.punch` | My work days with their punches (at most 93 days); today is live |
| `POST` | `/api/hrms/attendance/punches` | `hrms.attendance.punch` | Punch in or out on one of your jobs |
| `POST` | `/api/hrms/attendance/rebuild` | `hrms.attendance.rebuild` | Recalculate stored work days from punches (locked days skipped) |
| `GET` | `/api/hrms/attendance/register` | `hrms.attendance.view` | Everyone's day on one date (team or all) |
| `GET` | `/api/hrms/attendance/today` | `hrms.attendance.punch` | Am I punched in, since when, minutes today, last missed-punch day |
| `GET` | `/api/hrms/attendance/work-hours` | `hrms.attendance.view` | Work hours per job over a period: days, leave, absence, worked / extra / approved overtime |
| `POST` | `/api/hrms/attendance/corrections` | `hrms.attendance.punch` | Ask to fix a day: missed or wrong punches (own, or a team member's) |
| `GET` | `/api/hrms/attendance/corrections/mine` | `hrms.attendance.punch` | Corrections about me or filed by me |
| `GET` | `/api/hrms/attendance/corrections/to-approve` | `hrms.attendance.approve` | Corrections waiting for my decision |
| `POST` | `/api/hrms/attendance/corrections/{publicId}/approve` | `hrms.attendance.approve` | Approve: adds punches, leaves out wrong ones, rebuilds the day (never your own) |
| `POST` | `/api/hrms/attendance/corrections/{publicId}/cancel` | `hrms.attendance.punch` | Cancel while waiting (the person or who filed it) |
| `POST` | `/api/hrms/attendance/corrections/{publicId}/reject` | `hrms.attendance.approve` | Reject with a reason |
| `POST` | `/api/hrms/attendance/overtime` | `hrms.attendance.punch` | Ask for overtime on a day (future dates allowed: planned overtime) |
| `GET` | `/api/hrms/attendance/overtime/mine` | `hrms.attendance.punch` | Overtime requests about me or filed by me |
| `GET` | `/api/hrms/attendance/overtime/to-approve` | `hrms.attendance.approve` | Overtime requests waiting for my decision |
| `POST` | `/api/hrms/attendance/overtime/{publicId}/approve` | `hrms.attendance.approve` | Approve: the day's approved overtime = approved minutes, at most its extra time |
| `POST` | `/api/hrms/attendance/overtime/{publicId}/cancel` | `hrms.attendance.punch` | Cancel (also after approval, unless the day is locked) |
| `POST` | `/api/hrms/attendance/overtime/{publicId}/reject` | `hrms.attendance.approve` | Reject with a reason |
| `GET` | `/api/hrms/contacts/shared` | `hrms.contacts.review` | Everyone currently using a phone or email (HR review; people are never merged) |
| `POST` | `/api/hrms/contacts/{id}/end` | `hrms.contacts.manage` | End a contact (kept as history) |
| `PATCH` | `/api/hrms/employments/{publicId}` | `hrms.employments.update` | Change manager, department (code stays), designation, or make primary |
| `POST` | `/api/hrms/employments/{publicId}/activate` | `hrms.employments.manage` | A joining employment becomes active |
| `POST` | `/api/hrms/employments/{publicId}/exit` | `hrms.employments.manage` | Exit a job; with no active job left the person becomes inactive |
| `GET` | `/api/hrms/employments/{publicId}/offer-letter` | any signed-in user | Download the offer letter (the person, or who may manage their jobs) |
| `POST` | `/api/hrms/employments/{publicId}/offer-letter` | `hrms.employments.manage` | Upload the offer letter (PDF, JPEG or PNG) |
| `POST` | `/api/hrms/expenses` | `hrms.expenses.submit` | Submit a claim on your own job, with an optional receipt file (JPEG, PNG or PDF) |
| `GET` | `/api/hrms/expenses/categories` | any signed-in user | Expense categories (and whether a receipt is required) |
| `GET` | `/api/hrms/expenses/health` | public (no sign-in) |  |
| `GET` | `/api/hrms/expenses/mine` | `hrms.expenses.submit` | My claims |
| `GET` | `/api/hrms/expenses/report` | `hrms.expenses.report` | Expense report: per person, category and status, with totals (paise; CSV in rupees) |
| `GET` | `/api/hrms/expenses/to-approve` | `hrms.expenses.approve` | Submitted claims on jobs I manage |
| `POST` | `/api/hrms/expenses/{publicId}/approve` | `hrms.expenses.approve` | Approve the claimed amount or a lower one (never your own) |
| `POST` | `/api/hrms/expenses/{publicId}/mark-paid` | `hrms.expenses.pay` | Mark an approved claim paid (it can never change after) |
| `POST` | `/api/hrms/expenses/{publicId}/reject` | `hrms.expenses.approve` | Reject with a reason |
| `GET` | `/api/hrms/leave/balances/mine` | `hrms.leave.apply` | My balance per company and leave type |
| `GET` | `/api/hrms/leave/health` | public (no sign-in) |  |
| `POST` | `/api/hrms/leave/ledger/adjustments` | `hrms.leave.manage` | HR: an opening balance or an adjustment, with a reason |
| `GET` | `/api/hrms/leave/report` | `hrms.leave.report` | Leave report: requests, and per person days taken in the period and current balance |
| `POST` | `/api/hrms/leave/requests` | `hrms.leave.apply` | Apply for leave on one of your jobs (days counted from the calendar) |
| `GET` | `/api/hrms/leave/requests/mine` | `hrms.leave.apply` | My leave requests |
| `GET` | `/api/hrms/leave/requests/to-approve` | `hrms.leave.approve` | Leave waiting for my decision |
| `POST` | `/api/hrms/leave/requests/{publicId}/approve` | `hrms.leave.approve` | Approve: takes the days from the balance and marks the work days (never your own) |
| `POST` | `/api/hrms/leave/requests/{publicId}/cancel` | `hrms.leave.apply` | Cancel (approved leave only before it starts; the days are given back) |
| `POST` | `/api/hrms/leave/requests/{publicId}/reject` | `hrms.leave.approve` | Reject with a reason |
| `GET` | `/api/hrms/leave/types` | any signed-in user | Leave types |
| `GET` | `/api/hrms/month-locks` | any signed-in user | Month locks, unlocked ones too (HR or System admin) |
| `POST` | `/api/hrms/month-locks` | `hrms.month.lock` | Lock an ended month of a company: nothing in it can change any more |
| `POST` | `/api/hrms/month-locks/{publicId}/unlock` | `hrms.month.unlock` | Unlock with a reason (System admin); who, when and why are kept |
| `GET` | `/api/hrms/people` | `hrms.people.view` | Search and list people (own, team or all) |
| `POST` | `/api/hrms/people` | `hrms.people.create` | Create a person with contacts and a first job (employee code generated from the department) |
| `GET` | `/api/hrms/people/health` | public (no sign-in) |  |
| `GET` | `/api/hrms/people/{publicId}` | `hrms.people.view` | One person: contacts and jobs |
| `PATCH` | `/api/hrms/people/{publicId}` | `hrms.people.update` | Change a person's display name or status |
| `POST` | `/api/hrms/people/{publicId}/contacts` | `hrms.contacts.manage` | Add a phone or email (it may be shared with other people) |
| `POST` | `/api/hrms/people/{publicId}/employments` | `hrms.employments.manage` | Add a job in another company |
| `PUT` | `/api/hrms/people/{publicId}/private` | `hrms.private.manage` | HR: set or clear Aadhaar / PAN (answers masked; audited without the values) |
| `POST` | `/api/hrms/people/{publicId}/private/reveal` | `hrms.private.reveal` | Management: Aadhaar, PAN and bank accounts in full; every reveal is written to the audit log |
| `GET` | `/api/hrms/reports/health` | public (no sign-in) |  |
| `DELETE` | `/api/payroll/adjustments/{publicId}` | `payroll.prepare` | Remove an adjustment (draft only) |
| `PATCH` | `/api/payroll/adjustments/{publicId}` | `payroll.prepare` | Change an adjustment (draft only) |
| `GET` | `/api/payroll/bank-accounts` | any signed-in user | Bank details (account numbers masked) |
| `POST` | `/api/payroll/bank-accounts` | `payroll.prepare` | Add where a job's salary is paid, from a date |
| `GET` | `/api/payroll/health` | public (no sign-in) |  |
| `POST` | `/api/payroll/items/{publicId}/adjustments` | `payroll.prepare` | Add an addition or deduction (PT, TDS, ESI, Advance, Bonus …) to a person's pay in a draft |
| `GET` | `/api/payroll/payslips/mine` | `payroll.payslip.own` | My payslips (approved or paid runs) |
| `GET` | `/api/payroll/payslips/{publicId}/pdf` | any signed-in user | A payslip PDF: your own, or any for the payroll roles |
| `GET` | `/api/payroll/runs` | any signed-in user | Payroll runs with totals |
| `POST` | `/api/payroll/runs` | `payroll.prepare` | Create the company's run for a month (attendance must be locked: HRMS_MONTH_NOT_LOCKED) |
| `GET` | `/api/payroll/runs/{publicId}` | any signed-in user | One run: every person's pay and adjustments (draft: also jobs without a salary) |
| `POST` | `/api/payroll/runs/{publicId}/approve` | `payroll.approve` | Approve a draft (never the one who prepared it last); it can no longer change |
| `GET` | `/api/payroll/runs/{publicId}/bank-file` | any signed-in user | Bank upload CSV of an approved or paid run (name, account, IFSC, amount) |
| `POST` | `/api/payroll/runs/{publicId}/mark-paid` | `payroll.prepare` | Record that an approved run was paid (date and bank reference) |
| `POST` | `/api/payroll/runs/{publicId}/recalculate` | `payroll.prepare` | Recalculate a draft from salaries and the locked attendance (adjustments are kept) |
| `GET` | `/api/payroll/runs/{publicId}/register` | any signed-in user | Salary register CSV of an approved or paid run (TOTAL line) |
| `GET` | `/api/payroll/salaries` | any signed-in user | Salaries: every row, newest first |
| `POST` | `/api/payroll/salaries` | `payroll.prepare` | Add a job's monthly salary from a date (a change is a new row) |
| `GET` | `/api/tickets` | `tickets.view` or `tickets.work` or `tickets.manage` | Tickets I may see, with filters |
| `POST` | `/api/tickets` | `tickets.manage` | Create a ticket (optionally with its assignees) |
| `GET` | `/api/tickets/daily-updates/missing` | `tickets.view` or `tickets.work` or `tickets.manage` | Who worked on a ticket without its daily update (default: yesterday) |
| `GET` | `/api/tickets/dashboard` | `tickets.view` or `tickets.work` or `tickets.manage` | Dashboard numbers: open tickets by type and priority, overdue, completed this month vs last |
| `GET` | `/api/tickets/mine` | `tickets.view` or `tickets.work` or `tickets.manage` | My tickets: the ones I am currently assigned to |
| `GET` | `/api/tickets/number-series` | `tickets.numbering.manage` | Each company's ticket number prefix and next number |
| `PUT` | `/api/tickets/number-series/{company}` | `tickets.numbering.manage` | Set a company's number prefix and next number (imported Froid tickets keep theirs) |
| `POST` | `/api/tickets/punch-in` | `tickets.work` | Ticket punch-in: start a timer on one or more of my tickets (one transaction) |
| `POST` | `/api/tickets/punch-out` | `tickets.work` | Ticket punch-out: stop my timers on some tickets, or all |
| `GET` | `/api/tickets/reassign-requests` | any signed-in user | Reassignment requests I decide (Management: all) |
| `POST` | `/api/tickets/reassign-requests/{publicId}/approve` | any signed-in user | Approve a reassignment and pick who takes over |
| `POST` | `/api/tickets/reassign-requests/{publicId}/reject` | any signed-in user | Reject a reassignment (reason required) |
| `GET` | `/api/tickets/reports/hours` | `tickets.view` or `tickets.work` or `tickets.manage` | Ticket hours by ticket, type, person, department or customer |
| `GET` | `/api/tickets/reports/missing-updates` | `tickets.view` or `tickets.work` or `tickets.manage` | Missing daily updates per person |
| `GET` | `/api/tickets/reports/on-hold` | `tickets.view` or `tickets.work` or `tickets.manage` | Tickets on hold, with reasons |
| `GET` | `/api/tickets/reports/overdue` | `tickets.view` or `tickets.work` or `tickets.manage` | Overdue tickets (as of today) |
| `GET` | `/api/tickets/reports/utilisation` | `tickets.view` or `tickets.work` or `tickets.manage` | Utilisation and unallocated time per person (ticket hours / attendance hours) |
| `GET` | `/api/tickets/reports/weekly` | `tickets.view` or `tickets.work` or `tickets.manage` | Tickets created vs completed per week, by type |
| `POST` | `/api/tickets/time/adjustments` | `tickets.time.adjust` | Adjust a person's daily ticket time between tickets (reason required; never your own) |
| `GET` | `/api/tickets/time/allocations` | `tickets.view` or `tickets.work` or `tickets.manage` | A person's ticket time on one day: calculated, adjusted, timelogs, attendance |
| `GET` | `/api/tickets/time/running` | `tickets.work` | My running ticket timers |
| `GET` | `/api/tickets/{publicId}` | `tickets.view` or `tickets.work` or `tickets.manage` | One ticket: details, assignees, checklist, attachments, sign-off, links, timeline |
| `PATCH` | `/api/tickets/{publicId}` | `tickets.manage` | Change details (not after completion or cancellation) |
| `PUT` | `/api/tickets/{publicId}/assignees` | `tickets.manage` | Set the assignees (whole list, exactly one primary) |
| `POST` | `/api/tickets/{publicId}/attachments` | `tickets.work` or `tickets.manage` | Upload a photo (JPEG, PNG) or file (also PDF), up to 10 MB |
| `GET` | `/api/tickets/{publicId}/attachments/{attachmentId}` | `tickets.view` or `tickets.work` or `tickets.manage` | Download an attachment |
| `POST` | `/api/tickets/{publicId}/cancel` | `tickets.manage` | Cancel (reason required) |
| `POST` | `/api/tickets/{publicId}/checklist` | `tickets.work` or `tickets.manage` | Answer a checklist item (pass, fail or na) |
| `POST` | `/api/tickets/{publicId}/complete` | `tickets.work` or `tickets.manage` | Complete (checks the type version's completion rules) |
| `POST` | `/api/tickets/{publicId}/head-approval` | `tickets.manage` | Head approval (department head, supervisor or Management; never an assignee) |
| `POST` | `/api/tickets/{publicId}/hold` | `tickets.manage` | Put on hold (reason required) |
| `POST` | `/api/tickets/{publicId}/links` | `tickets.manage` | Link to another ticket of the same company (follows: same project; or rework_of) |
| `POST` | `/api/tickets/{publicId}/reassign-requests` | `tickets.work` | Ask to be reassigned (assignees; reason required) |
| `POST` | `/api/tickets/{publicId}/reopen` | `tickets.manage` | Reopen a completed ticket (reason required) |
| `POST` | `/api/tickets/{publicId}/resume` | `tickets.manage` | Resume a ticket on hold |
| `POST` | `/api/tickets/{publicId}/signoffs` | `tickets.work` or `tickets.manage` | Record the customer's sign-off: signer and a photo of the signed sheet |
| `POST` | `/api/tickets/{publicId}/start` | `tickets.work` or `tickets.manage` | Start work: assigned → in progress (the first ticket punch-in does the same) |
| `GET` | `/api/tickets/{publicId}/updates` | `tickets.view` or `tickets.work` or `tickets.manage` | A ticket's daily updates, newest first |
| `POST` | `/api/tickets/{publicId}/updates` | `tickets.work` or `tickets.manage` | Add my daily update: note, percent complete, up to 5 photos or files (one per ticket per day) |
| `GET` | `/api/tickets/types` | `tickets.types.view` or `tickets.types.manage` | Ticket types (current versions); filter by active, department, company |
| `POST` | `/api/tickets/types` | `tickets.types.manage` | Create a ticket type |
| `GET` | `/api/tickets/types/{publicId}` | `tickets.types.view` or `tickets.types.manage` | One ticket type with every saved version, newest first |
| `PATCH` | `/api/tickets/types/{publicId}` | `tickets.types.manage` | Change a ticket type: saves a new version and keeps the old ones |
| `POST` | `/api/tickets/types/{publicId}/deactivate` | `tickets.types.manage` | Deactivate a ticket type (no new tickets; old tickets keep it) |
| `POST` | `/api/tickets/types/{publicId}/reactivate` | `tickets.types.manage` | Reactivate a ticket type |

## Sign-in (core / auth)

### /api/auth

#### `POST /api/auth/login`

Sign in with a login phone or email and password

**Who:** public (no sign-in) · **Success:** `200`

> Answers the same AUTH_FAILED for a wrong password and an unknown login. Too many failed sign-ins for one account (default 5) or from one IP address (default 30) within 15 minutes lock it for 15 minutes: 429 AUTH_LOCKED with a Retry-After header and details.retryAfterSeconds, even with the right password.

Body (application/json): [LoginRequest](#loginrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `login` | string | yes | min length 3; max length 100 |
| `password` | string | yes | min length 1; max length 72 |

Answer `200` (application/json): [LoginResponse](#loginresponse)

#### `GET /api/auth/me`

Who am I: person, login, roles and permissions (widest scope per permission)

**Who:** any signed-in user · **Success:** `200`

Answer `200` (application/json): [Me](#me)

#### `POST /api/auth/password`

Change my password; older tokens stop working

**Who:** any signed-in user · **Success:** `200`

Body (application/json): [ChangePasswordRequest](#changepasswordrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `currentPassword` | string | yes | min length 1; max length 72 |
| `newPassword` | string | yes | min length 8; max length 72 |

Answer `200` (application/json): [LoginResponse](#loginresponse)

## Core: logins, roles, policies

### /api/core

#### `POST /api/core/role-assignments`

Give a person a role with a scope (own / team / all); never to yourself

**Who:** `core.users.manage` · **Success:** `201`

Body (application/json): [AssignRoleRequest](#assignrolerequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `personPublicId` | string (uuid) | yes |  |
| `roleCode` | string | yes | min length 1; max length 40 |
| `scope` | `own` \| `team` \| `all` | yes |  |
| `validFrom` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `validTo` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |

Answer `201` (application/json): [CreatedId](#createdid)

#### `POST /api/core/role-assignments/{publicId}/end`

End a role (kept as history)

**Who:** `core.users.manage` · **Success:** `204`

Path: `publicId` (string (uuid))

Answer `204`: Done (no body)

#### `POST /api/core/users`

Create a login for a person (phone, email or both)

**Who:** `core.users.manage` · **Success:** `201`

Body (application/json): [CreateUserRequest](#createuserrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `personPublicId` | string (uuid) | yes |  |
| `loginPhone` | string | no | min length 6; max length 20 |
| `loginEmail` | string (email) | no | max length 100 |
| `password` | string | yes | min length 8; max length 72 |

Answer `201` (application/json): [CreatedId](#createdid)

#### `POST /api/core/users/{publicId}/reset-password`

Set a new password; the person's tokens stop working

**Who:** `core.users.manage` · **Success:** `204`

Path: `publicId` (string (uuid))

Body (application/json): [ResetPasswordRequest](#resetpasswordrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `newPassword` | string | yes | min length 8; max length 72 |

Answer `204`: Done (no body)

### /api/core/policies

#### `GET /api/core/policies`

Stored policy versions, newest first

**Who:** `core.policies.manage` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `key` | `core.auth.session_hours` \| `hrms.attendance.full_day_minutes` \| `hrms.attendance.half_day_minutes` \| `hrms.attendance.max_open_punch_hours` \| `hrms.attendance.auto_punch_out_hours` \| `hrms.leave.balance_check` \| `hrms.overtime.payable` \| `hrms.approvals.auto_approve_roles` \| `tickets.time.split` \| `payroll.lop_basis` | no |  |
| `company` | string | no | min length 1; max length 12 |

Answer `200` (application/json): [Policy](#policy)[]

#### `POST /api/core/policies`

Add a new version of a policy (versions are never changed)

**Who:** `core.policies.manage` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Body (application/json): [CreatePolicyRequest](#createpolicyrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `key` | `core.auth.session_hours` \| `hrms.attendance.full_day_minutes` \| `hrms.attendance.half_day_minutes` \| `hrms.attendance.max_open_punch_hours` \| `hrms.attendance.auto_punch_out_hours` \| `hrms.leave.balance_check` \| `hrms.overtime.payable` \| `hrms.approvals.auto_approve_roles` \| `tickets.time.split` \| `payroll.lop_basis` | yes |  |
| `company` | string | no | min length 1; max length 12 |
| `value` | any \| null | no |  |
| `effectiveFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

Answer `201` (application/json): [Policy](#policy)

#### `GET /api/core/policies/in-force`

The value of a policy in force on a date (company first, then group, then default)

**Who:** `core.policies.manage` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `key` | `core.auth.session_hours` \| `hrms.attendance.full_day_minutes` \| `hrms.attendance.half_day_minutes` \| `hrms.attendance.max_open_punch_hours` \| `hrms.attendance.auto_punch_out_hours` \| `hrms.leave.balance_check` \| `hrms.overtime.payable` \| `hrms.approvals.auto_approve_roles` \| `tickets.time.split` \| `payroll.lop_basis` | yes |  |
| `company` | string | no | min length 1; max length 12 |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

Answer `200` (application/json): [PolicyInForce](#policyinforce)

## HRMS

### /api/hrms

#### `GET /api/hrms/approvals/mine`

Everything waiting for my decision (leave, expenses, corrections, overtime), oldest first, with counts per type

**Who:** any signed-in user · **Success:** `200`

Answer `200` (application/json): [ApprovalsInbox](#approvalsinbox)

#### `GET /api/hrms/calendar`

One job's days: working, weekly off or holiday (at most 366 days)

**Who:** `hrms.people.view` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `employment` | string (uuid) | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

Answer `200` (application/json): [WorkCalendar](#workcalendar)

#### `GET /api/hrms/calendar/health`



**Who:** public (no sign-in) · **Success:** `200`

Answer `200`: Success

#### `GET /api/hrms/certificates/expiring`

Certificates expiring within the next days (HR)

**Who:** `hrms.skills.manage` or `hrms.management` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `days` | integer | no | min 1; max 365; default `30` |

Answer `200` (application/json): [ExpiringCertificates](#expiringcertificates)

#### `GET /api/hrms/certificates/{publicId}/file`

Download a certificate file (the person, their manager or HR)

**Who:** any signed-in user · **Success:** `200` · **Answers a file**

Path: `publicId` (string (uuid))

Answer `200` (application/pdf): string

#### `POST /api/hrms/certificates/{publicId}/verify`

Verify a certificate (never your own; not when expired)

**Who:** `hrms.skills.verify` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [Certificate](#certificate)

#### `GET /api/hrms/dashboard`

HRMS dashboard for a month: your team (supervisor) or everyone (HR, Management); one company or all you may see

**Who:** `hrms.dashboard.view` or `hrms.management` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 20; default `"all"` |
| `month` | string | no | pattern `^\d{4}-(0[1-9]\|1[0-2])$` |

Answer `200` (application/json): [Dashboard](#dashboard)

#### `GET /api/hrms/departments`

Departments of a company, with heads

**Who:** any signed-in user · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |

Answer `200` (application/json): [Department](#department)[]

#### `POST /api/hrms/departments`

Add a department (name and employee-code prefix)

**Who:** `hrms.employments.manage` · **Success:** `201`

Body (application/json): [CreateDepartmentRequest](#createdepartmentrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | yes | min length 1; max length 12 |
| `name` | string | yes | min length 2; max length 80 |
| `codePrefix` | string | yes | pattern `^[A-Z]{2,6}$` |

Answer `201` (application/json): [Department](#department)

#### `PATCH /api/hrms/departments/{publicId}`

Rename a department or set its head

**Who:** `hrms.employments.manage` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [UpdateDepartmentRequest](#updatedepartmentrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `name` | string | no | min length 2; max length 80 |
| `headPublicId` | string (uuid) \| null | no |  |

Answer `200` (application/json): [Department](#department)

#### `GET /api/hrms/designations`

Designations of a company

**Who:** any signed-in user · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |

Answer `200` (application/json): [Designation](#designation)[]

#### `GET /api/hrms/holidays`

Holidays of a year

**Who:** any signed-in user · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `year` | integer | yes | min 2000; max 2100 |

Answer `200` (application/json): [Holiday](#holiday)[]

#### `POST /api/hrms/holidays`

Add a holiday to a company's year (stored days are rebuilt)

**Who:** `hrms.calendar.manage` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Body (application/json): [CreateHolidayRequest](#createholidayrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `company` | string | yes | min length 1; max length 12 |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `name` | string | yes | min length 2; max length 100 |
| `isOptional` | boolean | no | default `false` |

Answer `201` (application/json): [Holiday](#holiday)

#### `DELETE /api/hrms/holidays/{publicId}`

Remove a holiday still to come and not in an approved leave

**Who:** `hrms.calendar.manage` · **Success:** `204`

Path: `publicId` (string (uuid))

Answer `204`: Done (no body)

#### `POST /api/hrms/people/{publicId}/certificates`

Add a certificate with an optional file (PDF, JPEG or PNG)

**Who:** `hrms.skills.add` · **Success:** `201` · **Multipart**, file field `file`

Path: `publicId` (string (uuid))

Body (multipart/form-data)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `name` | string | yes | min length 2; max length 120 |
| `issuer` | string | no | max length 120 |
| `number` | string | no | max length 60 |
| `issuedOn` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `expiresOn` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `file` | string | no |  |

Answer `201` (application/json): [Certificate](#certificate)

#### `POST /api/hrms/people/{publicId}/skills`

Add a person's skill or change its level (needs verifying again)

**Who:** `hrms.skills.add` · **Success:** `201`

Path: `publicId` (string (uuid))

Body (application/json): [AddPersonSkillRequest](#addpersonskillrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `skillPublicId` | string (uuid) | yes |  |
| `level` | `trainee` \| `skilled` \| `expert` | yes |  |

Answer `201` (application/json): [PersonSkill](#personskill)

#### `POST /api/hrms/person-skills/{publicId}/verify`

Verify a skill (never your own)

**Who:** `hrms.skills.verify` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [PersonSkill](#personskill)

#### `GET /api/hrms/positions`

Positions (planned, open, filled)

**Who:** `hrms.positions.manage` or `hrms.management` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `department` | string | no | pattern `^[A-Z]{2,6}$` |
| `status` | `planned` \| `open` \| `filled` | no |  |

Answer `200` (application/json): [Position](#position)[]

#### `POST /api/hrms/positions`

Plan or open a position in a department

**Who:** `hrms.positions.manage` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Body (application/json): [CreatePositionRequest](#createpositionrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `company` | string | yes | min length 1; max length 12 |
| `departmentCode` | string | yes | pattern `^[A-Z]{2,6}$` |
| `designation` | string | yes | min length 2; max length 80 |
| `status` | `planned` \| `open` | no | default `"planned"` |
| `notes` | string | no | max length 500 |

Answer `201` (application/json): [Position](#position)

#### `POST /api/hrms/positions/{publicId}/fill`

Fill a position with the hired person's employment

**Who:** `hrms.positions.manage` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [FillPositionRequest](#fillpositionrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `employmentPublicId` | string (uuid) | yes |  |

Answer `200` (application/json): [Position](#position)

#### `POST /api/hrms/positions/{publicId}/status`

Move a position between planned and open

**Who:** `hrms.positions.manage` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [PositionStatusRequest](#positionstatusrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `status` | `planned` \| `open` | yes |  |

Answer `200` (application/json): [Position](#position)

#### `GET /api/hrms/skills`

Skills list of a company, by department

**Who:** any signed-in user · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `department` | string | no | pattern `^[A-Z]{2,6}$` |

Answer `200` (application/json): [Skill](#skill)[]

#### `POST /api/hrms/skills`

Add a skill to the list

**Who:** `hrms.skills.manage` · **Success:** `201`

Body (application/json): [CreateSkillRequest](#createskillrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | yes | min length 1; max length 12 |
| `departmentCode` | string | no | pattern `^[A-Z]{2,6}$` |
| `code` | string | yes | pattern `^[a-z0-9][a-z0-9_-]{1,39}$` |
| `name` | string | yes | min length 2; max length 100 |

Answer `201` (application/json): [Skill](#skill)

#### `GET /api/hrms/skills/health`



**Who:** public (no sign-in) · **Success:** `200`

Answer `200`: Success

#### `GET /api/hrms/skills/matrix`

Skills matrix: people with skills and certificates (own, team or all)

**Who:** `hrms.skills.view` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `department` | string | no | pattern `^[A-Z]{2,6}$` |
| `skill` | string | no | pattern `^[a-z0-9][a-z0-9_-]{1,39}$` |

Answer `200` (application/json): [SkillsMatrix](#skillsmatrix)

#### `GET /api/hrms/weekly-offs`

Weekly-off rules: company defaults and person overrides

**Who:** `hrms.calendar.manage` or `hrms.management` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `employment` | string (uuid) | no |  |

Answer `200` (application/json): [WeeklyOff](#weeklyoff)[]

#### `POST /api/hrms/weekly-offs`

Set a company's or a person's weekly off from a date

**Who:** `hrms.calendar.manage` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Body (application/json): [CreateWeeklyOffRequest](#createweeklyoffrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `company` | string | no | min length 1; max length 12 |
| `employmentPublicId` | string (uuid) | no |  |
| `validFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `validTo` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `rule` | { weekdays?: integer[], nthWeekdays?: object[] } | yes |  |

Answer `201` (application/json): [WeeklyOff](#weeklyoff)

### /api/hrms/attendance

#### `GET /api/hrms/attendance/health`



**Who:** public (no sign-in) · **Success:** `200`

Answer `200`: Success

#### `GET /api/hrms/attendance/history`

My work days with their punches (at most 93 days); today is live

**Who:** `hrms.attendance.punch` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

Answer `200` (application/json): [HistoryRow](#historyrow)[]

#### `POST /api/hrms/attendance/punches`

Punch in or out on one of your jobs

**Who:** `hrms.attendance.punch` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

> In and out alternate per person across all jobs (HRMS_PUNCH_ORDER). A punch-in after a forgotten punch-out first closes it 8 hours after its punch-in (policy). Refused in a locked month (HRMS_MONTH_LOCKED).

Body (application/json): [PunchRequest](#punchrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `kind` | `in` \| `out` | yes |  |
| `occurredAt` | string (date-time) | yes |  |
| `latitude` | number | no | min -90; max 90 |
| `longitude` | number | no | min -180; max 180 |
| `accuracyM` | integer | no | min 0 |

Answer `201` (application/json): [Punch](#punch)

#### `POST /api/hrms/attendance/rebuild`

Recalculate stored work days from punches (locked days skipped)

**Who:** `hrms.attendance.rebuild` · **Success:** `200`

Body (application/json): [RebuildWorkDaysRequest](#rebuildworkdaysrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `employmentPublicId` | string (uuid) | no |  |
| `personPublicId` | string (uuid) | no |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

Answer `200` (application/json): [RebuildResult](#rebuildresult)

#### `GET /api/hrms/attendance/register`

Everyone's day on one date (team or all)

**Who:** `hrms.attendance.view` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `company` | string | no | max length 12 |

Answer `200` (application/json): [AttendanceRegister](#attendanceregister)

#### `GET /api/hrms/attendance/today`

Am I punched in, since when, minutes today, last missed-punch day

**Who:** `hrms.attendance.punch` · **Success:** `200`

Answer `200` (application/json): [TodayAttendance](#todayattendance)

#### `GET /api/hrms/attendance/work-hours`

Work hours per job over a period: days, leave, absence, worked / extra / approved overtime

**Who:** `hrms.attendance.view` · **Success:** `200` · **CSV:** `format=csv`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | max length 12 |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `format` | `json` \| `csv` | no | default `"json"` |

Answer `200` (application/json): [WorkHours](#workhours)

### /api/hrms/attendance/corrections

#### `POST /api/hrms/attendance/corrections`

Ask to fix a day: missed or wrong punches (own, or a team member's)

**Who:** `hrms.attendance.punch` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Body (application/json): [CreateCorrectionRequest](#createcorrectionrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `workDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `kind` | `missed_out` \| `missed_in` \| `wrong_time` \| `other` | yes |  |
| `requestedIn` | string (date-time) | no |  |
| `requestedOut` | string (date-time) | no |  |
| `punchIdsToExclude` | (string (uuid))[] | no | max items 20; default `[]` |
| `reason` | string | yes | min length 10; max length 500 |

Answer `201` (application/json): [Correction](#correction)

#### `GET /api/hrms/attendance/corrections/mine`

Corrections about me or filed by me

**Who:** `hrms.attendance.punch` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `status` | `submitted` \| `approved` \| `rejected` \| `cancelled` | no |  |

Answer `200` (application/json): [Correction](#correction)[]

#### `GET /api/hrms/attendance/corrections/to-approve`

Corrections waiting for my decision

**Who:** `hrms.attendance.approve` · **Success:** `200`

Answer `200` (application/json): [Correction](#correction)[]

#### `POST /api/hrms/attendance/corrections/{publicId}/approve`

Approve: adds punches, leaves out wrong ones, rebuilds the day (never your own)

**Who:** `hrms.attendance.approve` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [Correction](#correction)

#### `POST /api/hrms/attendance/corrections/{publicId}/cancel`

Cancel while waiting (the person or who filed it)

**Who:** `hrms.attendance.punch` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [Correction](#correction)

#### `POST /api/hrms/attendance/corrections/{publicId}/reject`

Reject with a reason

**Who:** `hrms.attendance.approve` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [RejectCorrectionRequest](#rejectcorrectionrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

Answer `200` (application/json): [Correction](#correction)

### /api/hrms/attendance/overtime

#### `POST /api/hrms/attendance/overtime`

Ask for overtime on a day (future dates allowed: planned overtime)

**Who:** `hrms.attendance.punch` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Body (application/json): [CreateOvertimeRequest](#createovertimerequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `workDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `minutes` | integer | yes | min 1; max 1440 |
| `reason` | string | yes | min length 3; max length 500 |
| `ticketPublicId` | string (uuid) | no |  |

Answer `201` (application/json): [OvertimeRequestView](#overtimerequestview)

#### `GET /api/hrms/attendance/overtime/mine`

Overtime requests about me or filed by me

**Who:** `hrms.attendance.punch` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `status` | `submitted` \| `approved` \| `rejected` \| `cancelled` | no |  |

Answer `200` (application/json): [OvertimeRequestView](#overtimerequestview)[]

#### `GET /api/hrms/attendance/overtime/to-approve`

Overtime requests waiting for my decision

**Who:** `hrms.attendance.approve` · **Success:** `200`

Answer `200` (application/json): [OvertimeRequestView](#overtimerequestview)[]

#### `POST /api/hrms/attendance/overtime/{publicId}/approve`

Approve: the day's approved overtime = approved minutes, at most its extra time

**Who:** `hrms.attendance.approve` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [OvertimeRequestView](#overtimerequestview)

#### `POST /api/hrms/attendance/overtime/{publicId}/cancel`

Cancel (also after approval, unless the day is locked)

**Who:** `hrms.attendance.punch` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [OvertimeRequestView](#overtimerequestview)

#### `POST /api/hrms/attendance/overtime/{publicId}/reject`

Reject with a reason

**Who:** `hrms.attendance.approve` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [RejectOvertimeRequest](#rejectovertimerequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

Answer `200` (application/json): [OvertimeRequestView](#overtimerequestview)

### /api/hrms/contacts

#### `GET /api/hrms/contacts/shared`

Everyone currently using a phone or email (HR review; people are never merged)

**Who:** `hrms.contacts.review` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `value` | string | yes | min length 3; max length 100 |

Answer `200` (application/json): [SharedContacts](#sharedcontacts)

#### `POST /api/hrms/contacts/{id}/end`

End a contact (kept as history)

**Who:** `hrms.contacts.manage` · **Success:** `204`

Path: `id` (string (uuid))

Answer `204`: Done (no body)

### /api/hrms/employments

#### `PATCH /api/hrms/employments/{publicId}`

Change manager, department (code stays), designation, or make primary

**Who:** `hrms.employments.update` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [UpdateEmploymentRequest](#updateemploymentrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `managerPublicId` | string (uuid) \| null | no |  |
| `departmentCode` | string \| null | no | min length 2; max length 6 |
| `designation` | string \| null | no | max length 80 |
| `isPrimary` | `True` | no |  |

Answer `200` (application/json): [PersonDetail](#persondetail)

#### `POST /api/hrms/employments/{publicId}/activate`

A joining employment becomes active

**Who:** `hrms.employments.manage` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [PersonDetail](#persondetail)

#### `POST /api/hrms/employments/{publicId}/exit`

Exit a job; with no active job left the person becomes inactive

**Who:** `hrms.employments.manage` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [ExitEmploymentRequest](#exitemploymentrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `exitOn` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `exitReason` | string | yes | min length 3; max length 200 |

Answer `200` (application/json): [PersonDetail](#persondetail)

#### `GET /api/hrms/employments/{publicId}/offer-letter`

Download the offer letter (the person, or who may manage their jobs)

**Who:** any signed-in user · **Success:** `200` · **Answers a file**

Path: `publicId` (string (uuid))

Answer `200` (application/pdf): string

#### `POST /api/hrms/employments/{publicId}/offer-letter`

Upload the offer letter (PDF, JPEG or PNG)

**Who:** `hrms.employments.manage` · **Success:** `200` · **Multipart**, file field `file`

Path: `publicId` (string (uuid))

Body (multipart/form-data)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `file` | string | yes |  |

Answer `200` (application/json): [PersonDetail](#persondetail)

### /api/hrms/expenses

#### `POST /api/hrms/expenses`

Submit a claim on your own job, with an optional receipt file (JPEG, PNG or PDF)

**Who:** `hrms.expenses.submit` · **Success:** `201` · **Resend:** same `publicId` again answers `200` · **Multipart**, file field `receipt`

Body (multipart/form-data)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `categoryCode` | string | yes | min length 1; max length 20 |
| `spentOn` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `amountPaise` | integer | yes | min 0; max 9007199254740991 |
| `description` | string | no | max length 500 |
| `receipt` | string | no |  |

Answer `201` (application/json): [ExpenseClaim](#expenseclaim)

#### `GET /api/hrms/expenses/categories`

Expense categories (and whether a receipt is required)

**Who:** any signed-in user · **Success:** `200`

Answer `200` (application/json): [ExpenseCategory](#expensecategory)[]

#### `GET /api/hrms/expenses/health`



**Who:** public (no sign-in) · **Success:** `200`

Answer `200`: Success

#### `GET /api/hrms/expenses/mine`

My claims

**Who:** `hrms.expenses.submit` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `status` | `submitted` \| `approved` \| `rejected` \| `paid` | no |  |
| `page` | integer | no | min 1; default `1` |
| `pageSize` | integer | no | min 1; max 100; default `20` |

Answer `200` (application/json): [ExpenseClaimList](#expenseclaimlist)

#### `GET /api/hrms/expenses/report`

Expense report: per person, category and status, with totals (paise; CSV in rupees)

**Who:** `hrms.expenses.report` · **Success:** `200` · **CSV:** `format=csv`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | max length 12 |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `format` | `json` \| `csv` | no | default `"json"` |

Answer `200` (application/json): [ExpenseReport](#expensereport)

#### `GET /api/hrms/expenses/to-approve`

Submitted claims on jobs I manage

**Who:** `hrms.expenses.approve` · **Success:** `200`

Answer `200` (application/json): [ExpenseClaim](#expenseclaim)[]

#### `POST /api/hrms/expenses/{publicId}/approve`

Approve the claimed amount or a lower one (never your own)

**Who:** `hrms.expenses.approve` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [ApproveExpenseRequest](#approveexpenserequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `approvedAmountPaise` | integer | no | min 0; max 9007199254740991 |

Answer `200` (application/json): [ExpenseClaim](#expenseclaim)

#### `POST /api/hrms/expenses/{publicId}/mark-paid`

Mark an approved claim paid (it can never change after)

**Who:** `hrms.expenses.pay` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [MarkExpensePaidRequest](#markexpensepaidrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `paymentRef` | string | yes | min length 1; max length 100 |
| `paidAt` | string (date-time) | no |  |

Answer `200` (application/json): [ExpenseClaim](#expenseclaim)

#### `POST /api/hrms/expenses/{publicId}/reject`

Reject with a reason

**Who:** `hrms.expenses.approve` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [RejectExpenseRequest](#rejectexpenserequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

Answer `200` (application/json): [ExpenseClaim](#expenseclaim)

### /api/hrms/leave

#### `GET /api/hrms/leave/balances/mine`

My balance per company and leave type

**Who:** `hrms.leave.apply` · **Success:** `200`

Answer `200` (application/json): [LeaveBalance](#leavebalance)[]

#### `GET /api/hrms/leave/health`



**Who:** public (no sign-in) · **Success:** `200`

Answer `200`: Success

#### `POST /api/hrms/leave/ledger/adjustments`

HR: an opening balance or an adjustment, with a reason

**Who:** `hrms.leave.manage` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Body (application/json): [LeaveAdjustmentRequest](#leaveadjustmentrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `leaveTypeCode` | string | yes | min length 1; max length 20 |
| `year` | integer | yes | min 2000; max 2100 |
| `entry` | `opening` \| `adjustment` | yes |  |
| `days` | number | yes |  |
| `reason` | string | yes | min length 3; max length 500 |

Answer `201` (application/json): [LeaveLedgerEntry](#leaveledgerentry)

#### `GET /api/hrms/leave/report`

Leave report: requests, and per person days taken in the period and current balance

**Who:** `hrms.leave.report` · **Success:** `200` · **CSV:** `format=csv`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | max length 12 |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `format` | `json` \| `csv` | no | default `"json"` |

Answer `200` (application/json): [LeaveReport](#leavereport)

#### `POST /api/hrms/leave/requests`

Apply for leave on one of your jobs (days counted from the calendar)

**Who:** `hrms.leave.apply` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Body (application/json): [ApplyLeaveRequest](#applyleaverequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `leaveTypeCode` | string | yes | min length 1; max length 20 |
| `fromDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `toDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `fromHalf` | `full` \| `second_half` | no | default `"full"` |
| `toHalf` | `full` \| `first_half` | no | default `"full"` |
| `reason` | string | no | min length 3; max length 500 |

Answer `201` (application/json): [LeaveRequestView](#leaverequestview)

#### `GET /api/hrms/leave/requests/mine`

My leave requests

**Who:** `hrms.leave.apply` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `status` | `draft` \| `submitted` \| `approved` \| `rejected` \| `cancelled` | no |  |

Answer `200` (application/json): [LeaveRequestView](#leaverequestview)[]

#### `GET /api/hrms/leave/requests/to-approve`

Leave waiting for my decision

**Who:** `hrms.leave.approve` · **Success:** `200`

Answer `200` (application/json): [LeaveRequestView](#leaverequestview)[]

#### `POST /api/hrms/leave/requests/{publicId}/approve`

Approve: takes the days from the balance and marks the work days (never your own)

**Who:** `hrms.leave.approve` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [LeaveRequestView](#leaverequestview)

#### `POST /api/hrms/leave/requests/{publicId}/cancel`

Cancel (approved leave only before it starts; the days are given back)

**Who:** `hrms.leave.apply` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [CancelLeaveRequest](#cancelleaverequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | no | min length 3; max length 500 |

Answer `200` (application/json): [LeaveRequestView](#leaverequestview)

#### `POST /api/hrms/leave/requests/{publicId}/reject`

Reject with a reason

**Who:** `hrms.leave.approve` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [RejectLeaveRequest](#rejectleaverequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

Answer `200` (application/json): [LeaveRequestView](#leaverequestview)

#### `GET /api/hrms/leave/types`

Leave types

**Who:** any signed-in user · **Success:** `200`

Answer `200` (application/json): [LeaveType](#leavetype)[]

### /api/hrms/month-locks

#### `GET /api/hrms/month-locks`

Month locks, unlocked ones too (HR or System admin)

**Who:** any signed-in user · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `year` | integer | no | min 2000; max 2100 |

Answer `200` (application/json): [MonthLock](#monthlock)[]

#### `POST /api/hrms/month-locks`

Lock an ended month of a company: nothing in it can change any more

**Who:** `hrms.month.lock` · **Success:** `201`

Body (application/json): [LockMonthRequest](#lockmonthrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | yes | min length 1; max length 12 |
| `year` | integer | yes | min 2000; max 2100 |
| `month` | integer | yes | min 1; max 12 |

Answer `201` (application/json): [MonthLock](#monthlock)

#### `POST /api/hrms/month-locks/{publicId}/unlock`

Unlock with a reason (System admin); who, when and why are kept

**Who:** `hrms.month.unlock` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [UnlockMonthRequest](#unlockmonthrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 5; max length 500 |

Answer `200` (application/json): [MonthLock](#monthlock)

### /api/hrms/people

#### `GET /api/hrms/people`

Search and list people (own, team or all)

**Who:** `hrms.people.view` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `search` | string | no | max length 100 |
| `company` | string | no | max length 12 |
| `status` | `joining` \| `active` \| `notice` \| `exited` | no |  |
| `page` | integer | no | min 1; default `1` |
| `pageSize` | integer | no | min 1; max 100; default `20` |

Answer `200` (application/json): [PersonList](#personlist)

#### `POST /api/hrms/people`

Create a person with contacts and a first job (employee code generated from the department)

**Who:** `hrms.people.create` · **Success:** `201`

Body (application/json): [CreatePersonRequest](#createpersonrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `displayName` | string | yes | min length 2; max length 100 |
| `contacts` | ({ kind: `phone` \| `email` \| `other`, value: string, label?: string, isPrimary?: boolean })[] | no | max items 10; default `[]` |
| `employment` | { legalEntityCode: string, employeeCode?: string, engagementType: `permanent` \| `probation` \| `contract` \| `intern` \| `external`, status?: `active` \| `joining`, recruitedOn?: string, joinedOn: string, departmentCode?: string, designation?: string, managerPublicId?: string (uuid), isPrimary?: `True` } | yes |  |

Answer `201` (application/json): [CreatedId](#createdid)

#### `GET /api/hrms/people/health`



**Who:** public (no sign-in) · **Success:** `200`

Answer `200`: Success

#### `GET /api/hrms/people/{publicId}`

One person: contacts and jobs

**Who:** `hrms.people.view` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [PersonDetail](#persondetail)

#### `PATCH /api/hrms/people/{publicId}`

Change a person's display name or status

**Who:** `hrms.people.update` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [UpdatePersonRequest](#updatepersonrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `displayName` | string | no | min length 2; max length 100 |
| `status` | `active` \| `inactive` \| `exited` | no |  |

Answer `200` (application/json): [PersonDetail](#persondetail)

#### `POST /api/hrms/people/{publicId}/contacts`

Add a phone or email (it may be shared with other people)

**Who:** `hrms.contacts.manage` · **Success:** `201`

Path: `publicId` (string (uuid))

Body (application/json): [ContactInput](#contactinput)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `kind` | `phone` \| `email` \| `other` | yes |  |
| `value` | string | yes | min length 3; max length 100 |
| `label` | string | no | max length 40 |
| `isPrimary` | boolean | no |  |

Answer `201` (application/json): [CreatedId](#createdid)

#### `POST /api/hrms/people/{publicId}/employments`

Add a job in another company

**Who:** `hrms.employments.manage` · **Success:** `201`

Path: `publicId` (string (uuid))

Body (application/json): [EmploymentInput](#employmentinput)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `legalEntityCode` | string | yes | min length 1; max length 12 |
| `employeeCode` | string | no | min length 1; max length 20 |
| `engagementType` | `permanent` \| `probation` \| `contract` \| `intern` \| `external` | yes |  |
| `status` | `active` \| `joining` | no | default `"active"` |
| `recruitedOn` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `joinedOn` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `departmentCode` | string | no | min length 2; max length 6 |
| `designation` | string | no | max length 80 |
| `managerPublicId` | string (uuid) | no |  |
| `isPrimary` | boolean | no |  |

Answer `201` (application/json): [CreatedId](#createdid)

#### `PUT /api/hrms/people/{publicId}/private`

HR: set or clear Aadhaar / PAN (answers masked; audited without the values)

**Who:** `hrms.private.manage` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [UpdatePrivateRequest](#updateprivaterequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `aadhaar` | string \| null | no | pattern `^[0-9]{12}$` |
| `pan` | string \| null | no | pattern `^[A-Z]{5}[0-9]{4}[A-Z]$` |

Answer `200` (application/json): [PrivateDetails](#privatedetails)

#### `POST /api/hrms/people/{publicId}/private/reveal`

Management: Aadhaar, PAN and bank accounts in full; every reveal is written to the audit log

**Who:** `hrms.private.reveal` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [PrivateDetails](#privatedetails)

### /api/hrms/reports

#### `GET /api/hrms/reports/health`



**Who:** public (no sign-in) · **Success:** `200`

Answer `200`: Success

## Payroll

### /api/payroll

#### `DELETE /api/payroll/adjustments/{publicId}`

Remove an adjustment (draft only)

**Who:** `payroll.prepare` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [PayrollRun](#payrollrun)

#### `PATCH /api/payroll/adjustments/{publicId}`

Change an adjustment (draft only)

**Who:** `payroll.prepare` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [UpdateAdjustmentRequest](#updateadjustmentrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `kind` | `addition` \| `deduction` | no |  |
| `label` | string | no | min length 2; max length 40 |
| `amountPaise` | integer | no | min 0; max 9007199254740991 |
| `note` | string \| null | no | max length 200 |

Answer `200` (application/json): [PayrollRun](#payrollrun)

#### `GET /api/payroll/bank-accounts`

Bank details (account numbers masked)

**Who:** any signed-in user · **Success:** `200`

> Payroll roles only (payroll.prepare or payroll.approve, scope all); others get 403.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |

Answer `200` (application/json): [BankAccount](#bankaccount)[]

#### `POST /api/payroll/bank-accounts`

Add where a job's salary is paid, from a date

**Who:** `payroll.prepare` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Body (application/json): [AddBankAccountRequest](#addbankaccountrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `accountHolder` | string | yes | min length 2; max length 100 |
| `accountNumber` | string | yes | pattern `^[0-9]{6,18}$` |
| `ifsc` | string | yes | pattern `^[A-Z]{4}0[A-Z0-9]{6}$` |
| `effectiveFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

Answer `201` (application/json): [BankAccount](#bankaccount)

#### `GET /api/payroll/health`



**Who:** public (no sign-in) · **Success:** `200`

Answer `200`: Success

#### `POST /api/payroll/items/{publicId}/adjustments`

Add an addition or deduction (PT, TDS, ESI, Advance, Bonus …) to a person's pay in a draft

**Who:** `payroll.prepare` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Path: `publicId` (string (uuid))

Body (application/json): [AddAdjustmentRequest](#addadjustmentrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `kind` | `addition` \| `deduction` | yes |  |
| `label` | string | yes | min length 2; max length 40 |
| `amountPaise` | integer | yes | min 0; max 9007199254740991 |
| `note` | string | no | max length 200 |

Answer `201` (application/json): [PayrollRun](#payrollrun)

#### `GET /api/payroll/payslips/mine`

My payslips (approved or paid runs)

**Who:** `payroll.payslip.own` · **Success:** `200`

Answer `200` (application/json): [Payslip](#payslip)[]

#### `GET /api/payroll/payslips/{publicId}/pdf`

A payslip PDF: your own, or any for the payroll roles

**Who:** any signed-in user · **Success:** `200` · **Answers a file**

Path: `publicId` (string (uuid))

Answer `200` (application/pdf): string

#### `GET /api/payroll/runs`

Payroll runs with totals

**Who:** any signed-in user · **Success:** `200`

> Payroll roles only (payroll.prepare or payroll.approve, scope all); others get 403.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `year` | integer | no | min 2000; max 2100 |

Answer `200` (application/json): [PayrollRunSummary](#payrollrunsummary)[]

#### `POST /api/payroll/runs`

Create the company's run for a month (attendance must be locked: HRMS_MONTH_NOT_LOCKED)

**Who:** `payroll.prepare` · **Success:** `201`

> Asking again for the same company and month answers the existing run with 200.

Body (application/json): [CreateRunRequest](#createrunrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | yes | min length 1; max length 12 |
| `year` | integer | yes | min 2000; max 2100 |
| `month` | integer | yes | min 1; max 12 |

Answer `201` (application/json): [PayrollRun](#payrollrun)

#### `GET /api/payroll/runs/{publicId}`

One run: every person's pay and adjustments (draft: also jobs without a salary)

**Who:** any signed-in user · **Success:** `200`

> Payroll roles only (payroll.prepare or payroll.approve, scope all); others get 403.

Path: `publicId` (string (uuid))

Answer `200` (application/json): [PayrollRun](#payrollrun)

#### `POST /api/payroll/runs/{publicId}/approve`

Approve a draft (never the one who prepared it last); it can no longer change

**Who:** `payroll.approve` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [PayrollRun](#payrollrun)

#### `GET /api/payroll/runs/{publicId}/bank-file`

Bank upload CSV of an approved or paid run (name, account, IFSC, amount)

**Who:** any signed-in user · **Success:** `200` · **CSV:** `format=csv`

> Payroll roles only (payroll.prepare or payroll.approve, scope all); others get 403.

Path: `publicId` (string (uuid))

Answer `200` (text/csv): string

#### `POST /api/payroll/runs/{publicId}/mark-paid`

Record that an approved run was paid (date and bank reference)

**Who:** `payroll.prepare` · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [MarkRunPaidRequest](#markrunpaidrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `paidAt` | string (date-time) | yes |  |
| `bankRef` | string | yes | min length 3; max length 60 |

Answer `200` (application/json): [PayrollRun](#payrollrun)

#### `POST /api/payroll/runs/{publicId}/recalculate`

Recalculate a draft from salaries and the locked attendance (adjustments are kept)

**Who:** `payroll.prepare` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [PayrollRun](#payrollrun)

#### `GET /api/payroll/runs/{publicId}/register`

Salary register CSV of an approved or paid run (TOTAL line)

**Who:** any signed-in user · **Success:** `200` · **CSV:** `format=csv`

> Payroll roles only (payroll.prepare or payroll.approve, scope all); others get 403.

Path: `publicId` (string (uuid))

Answer `200` (text/csv): string

#### `GET /api/payroll/salaries`

Salaries: every row, newest first

**Who:** any signed-in user · **Success:** `200`

> Payroll roles only (payroll.prepare or payroll.approve, scope all); others get 403.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `employment` | string (uuid) | no |  |

Answer `200` (application/json): [Salary](#salary)[]

#### `POST /api/payroll/salaries`

Add a job's monthly salary from a date (a change is a new row)

**Who:** `payroll.prepare` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

Body (application/json): [AddSalaryRequest](#addsalaryrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `monthlyAmountPaise` | integer | yes | min 0; max 9007199254740991 |
| `effectiveFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `note` | string | no | max length 200 |

Answer `201` (application/json): [Salary](#salary)

## Tickets

### /api/tickets

#### `GET /api/tickets`

Tickets I may see, with filters

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200`

> HR, admin user and Management: every ticket. Heads: their departments' and supervised tickets. Staff: tickets they are assigned to.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `type` | string (uuid) | no |  |
| `status` | `open` \| `assigned` \| `in_progress` \| `on_hold` \| `completed` \| `cancelled` | no |  |
| `department` | string (uuid) | no |  |
| `assignee` | string (uuid) | no |  |
| `customer` | string (uuid) | no |  |
| `priority` | integer | no | min 1; max 5 |
| `overdue` | `true` \| `false` | no |  |
| `from` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `limit` | integer | no | min 1; max 500 |
| `offset` | integer \| null | no | min 0 |

Answer `200` (application/json): [TicketSummary](#ticketsummary)[]

#### `POST /api/tickets`

Create a ticket (optionally with its assignees)

**Who:** `tickets.manage` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

> Admin user and Management: any ticket. A department head (or the ticket's supervisor): their tickets.

Body (application/json): [CreateTicketRequest](#createticketrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `company` | string | yes | min length 1; max length 12 |
| `typePublicId` | string (uuid) | yes |  |
| `title` | string | yes | min length 3; max length 150 |
| `description` | string | no | max length 1000 |
| `priority` | integer | no | min 1; max 5; default `3` |
| `customerId` | string (uuid) | no |  |
| `site` | string | no | min length 1; max length 200 |
| `departmentPublicId` | string (uuid) | yes |  |
| `supervisorPublicId` | string (uuid) | no |  |
| `requiredSkillPublicId` | string (uuid) | no |  |
| `scheduledAt` | string (date-time) | yes |  |
| `dueDate` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `details` | Record<string, any \| null> | no | default `{}` |
| `assignees` | ({ employmentPublicId: string (uuid), isPrimary?: boolean })[] | no | min items 1; max items 20 |

Answer `201` (application/json): [TicketDetail](#ticketdetail)

#### `GET /api/tickets/daily-updates/missing`

Who worked on a ticket without its daily update (default: yesterday)

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200`

> Heads: their departments. HR, admin user, Management: all. Others: themselves.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `date` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |

Answer `200` (application/json): [MissingUpdate](#missingupdate)[]

#### `GET /api/tickets/dashboard`

Dashboard numbers: open tickets by type and priority, overdue, completed this month vs last

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200`

> Department heads: their departments. HR, admin user and Management: all. Others: 403 TICKETS_FORBIDDEN. Time is allocated time, never raw timer time.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |

Answer `200` (application/json): [TicketDashboard](#ticketdashboard)

#### `GET /api/tickets/mine`

My tickets: the ones I am currently assigned to

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `status` | `open` \| `assigned` \| `in_progress` \| `on_hold` \| `completed` \| `cancelled` | no |  |

Answer `200` (application/json): [TicketSummary](#ticketsummary)[]

#### `GET /api/tickets/number-series`

Each company's ticket number prefix and next number

**Who:** `tickets.numbering.manage` · **Success:** `200`

Answer `200` (application/json): [NumberSeries](#numberseries)[]

#### `PUT /api/tickets/number-series/{company}`

Set a company's number prefix and next number (imported Froid tickets keep theirs)

**Who:** `tickets.numbering.manage` · **Success:** `200`

Path: `company` (string)

Body (application/json): [NumberSeriesRequest](#numberseriesrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `prefix` | string | yes | pattern `^[A-Z0-9]{1,10}$` |
| `nextNumber` | integer | yes | min 1; max 99999999 |

Answer `200` (application/json): [NumberSeries](#numberseries)

#### `POST /api/tickets/punch-in`

Ticket punch-in: start a timer on one or more of my tickets (one transaction)

**Who:** `tickets.work` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

> Only while punched in for the day (409 TICKETS_NOT_PUNCHED_IN). The first punch-in moves an assigned ticket to in progress.

Body (application/json): [TicketPunchInRequest](#ticketpunchinrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `occurredAt` | string (date-time) | no |  |
| `items` | ({ publicId: string (uuid), ticketPublicId: string (uuid) })[] | yes | min items 1; max items 20 |
| `latitude` | number | no | min -90; max 90 |
| `longitude` | number | no | min -180; max 180 |
| `accuracyM` | integer | no | min 0 |

Answer `201` (application/json): [TicketPunchResult](#ticketpunchresult)

#### `POST /api/tickets/punch-out`

Ticket punch-out: stop my timers on some tickets, or all

**Who:** `tickets.work` · **Success:** `200`

Body (application/json): [TicketPunchOutRequest](#ticketpunchoutrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `occurredAt` | string (date-time) | no |  |
| `tickets` | (string (uuid))[] | no | min items 1; max items 50 |
| `all` | `True` | no |  |

Answer `200` (application/json): [TicketPunchResult](#ticketpunchresult)

#### `GET /api/tickets/reassign-requests`

Reassignment requests I decide (Management: all)

**Who:** any signed-in user · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `status` | `pending` \| `approved` \| `rejected` | no |  |

Answer `200` (application/json): [ReassignmentRequest](#reassignmentrequest)[]

#### `POST /api/tickets/reassign-requests/{publicId}/approve`

Approve a reassignment and pick who takes over

**Who:** any signed-in user · **Success:** `200`

> The named approver or Management; never the person who asked. Nobody but Management picks themselves.

Path: `publicId` (string (uuid))

Body (application/json): [ApproveReassignRequest](#approvereassignrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `newEmploymentPublicId` | string (uuid) | yes |  |

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/reassign-requests/{publicId}/reject`

Reject a reassignment (reason required)

**Who:** any signed-in user · **Success:** `200`

Path: `publicId` (string (uuid))

Body (application/json): [ReasonRequest](#reasonrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `GET /api/tickets/reports/hours`

Ticket hours by ticket, type, person, department or customer

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200` · **CSV:** `format=csv`

> Department heads: their departments. HR, admin user and Management: all. Others: 403 TICKETS_FORBIDDEN. Time is allocated time, never raw timer time.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `company` | string | no | min length 1; max length 12 |
| `format` | `json` \| `csv` | no | default `"json"` |
| `by` | `ticket` \| `type` \| `person` \| `department` \| `customer` | no | default `"ticket"` |

Answer `200` (application/json): [HoursReport](#hoursreport)

#### `GET /api/tickets/reports/missing-updates`

Missing daily updates per person

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200` · **CSV:** `format=csv`

> Department heads: their departments. HR, admin user and Management: all. Others: 403 TICKETS_FORBIDDEN. Time is allocated time, never raw timer time.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `company` | string | no | min length 1; max length 12 |
| `format` | `json` \| `csv` | no | default `"json"` |

Answer `200` (application/json): [MissingUpdatesReport](#missingupdatesreport)

#### `GET /api/tickets/reports/on-hold`

Tickets on hold, with reasons

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200` · **CSV:** `format=csv`

> Department heads: their departments. HR, admin user and Management: all. Others: 403 TICKETS_FORBIDDEN. Time is allocated time, never raw timer time.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `format` | `json` \| `csv` | no | default `"json"` |

Answer `200` (application/json): [OnHoldReport](#onholdreport)

#### `GET /api/tickets/reports/overdue`

Overdue tickets (as of today)

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200` · **CSV:** `format=csv`

> Department heads: their departments. HR, admin user and Management: all. Others: 403 TICKETS_FORBIDDEN. Time is allocated time, never raw timer time.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | no | min length 1; max length 12 |
| `format` | `json` \| `csv` | no | default `"json"` |

Answer `200` (application/json): [OverdueReport](#overduereport)

#### `GET /api/tickets/reports/utilisation`

Utilisation and unallocated time per person (ticket hours / attendance hours)

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200` · **CSV:** `format=csv`

> Department heads: their departments. HR, admin user and Management: all. Others: 403 TICKETS_FORBIDDEN. Time is allocated time, never raw timer time. Heads see the people of their departments.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `company` | string | no | min length 1; max length 12 |
| `format` | `json` \| `csv` | no | default `"json"` |

Answer `200` (application/json): [UtilisationReport](#utilisationreport)

#### `GET /api/tickets/reports/weekly`

Tickets created vs completed per week, by type

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200` · **CSV:** `format=csv`

> Department heads: their departments. HR, admin user and Management: all. Others: 403 TICKETS_FORBIDDEN. Time is allocated time, never raw timer time.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `company` | string | no | min length 1; max length 12 |
| `format` | `json` \| `csv` | no | default `"json"` |

Answer `200` (application/json): [WeeklyReport](#weeklyreport)

#### `POST /api/tickets/time/adjustments`

Adjust a person's daily ticket time between tickets (reason required; never your own)

**Who:** `tickets.time.adjust` · **Success:** `201`

Body (application/json): [AdjustTimeRequest](#adjusttimerequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `personPublicId` | string (uuid) | yes |  |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `reason` | string | yes | min length 3; max length 500 |
| `changes` | ({ ticketPublicId: string (uuid), minutes: integer })[] | yes | min items 1; max items 20 |

Answer `201` (application/json): [DayAllocation](#dayallocation)

#### `GET /api/tickets/time/allocations`

A person's ticket time on one day: calculated, adjusted, timelogs, attendance

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200`

> The person themselves; heads and supervisors of their tickets that day; HR, admin user and Management.

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `person` | string (uuid) | yes |  |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

Answer `200` (application/json): [DayAllocation](#dayallocation)

#### `GET /api/tickets/time/running`

My running ticket timers

**Who:** `tickets.work` · **Success:** `200`

Answer `200` (application/json): [RunningTicket](#runningticket)[]

#### `GET /api/tickets/{publicId}`

One ticket: details, assignees, checklist, attachments, sign-off, links, timeline

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `PATCH /api/tickets/{publicId}`

Change details (not after completion or cancellation)

**Who:** `tickets.manage` · **Success:** `200`

> Admin user and Management: any ticket. A department head (or the ticket's supervisor): their tickets.

Path: `publicId` (string (uuid))

Body (application/json): [UpdateTicketRequest](#updateticketrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `title` | string | no | min length 3; max length 150 |
| `description` | string \| null | no | max length 1000 |
| `priority` | integer | no | min 1; max 5 |
| `customerId` | string (uuid) \| null | no |  |
| `site` | string \| null | no | min length 1; max length 200 |
| `supervisorPublicId` | string (uuid) | no |  |
| `requiredSkillPublicId` | string (uuid) \| null | no |  |
| `scheduledAt` | string (date-time) | no |  |
| `dueDate` | string \| null | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `details` | Record<string, any \| null> | no |  |

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `PUT /api/tickets/{publicId}/assignees`

Set the assignees (whole list, exactly one primary)

**Who:** `tickets.manage` · **Success:** `200`

> Admin user and Management: any ticket. A department head (or the ticket's supervisor): their tickets.

Path: `publicId` (string (uuid))

Body (application/json): [AssignTicketRequest](#assignticketrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `assignees` | ({ employmentPublicId: string (uuid), isPrimary?: boolean })[] | yes | min items 1; max items 20 |

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/attachments`

Upload a photo (JPEG, PNG) or file (also PDF), up to 10 MB

**Who:** `tickets.work` or `tickets.manage` · **Success:** `201` · **Multipart**, file field `file`

> Its assignees (tickets.work), the department head / supervisor, admin user and Management.

Path: `publicId` (string (uuid))

Body (multipart/form-data)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `kind` | `photo` \| `file` | yes |  |
| `file` | string | no |  |

Answer `201` (application/json): [TicketDetail](#ticketdetail)

#### `GET /api/tickets/{publicId}/attachments/{attachmentId}`

Download an attachment

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200` · **Answers a file**

Path: `attachmentId` (string (uuid)), `publicId` (string (uuid))

Answer `200` (application/pdf): string

#### `POST /api/tickets/{publicId}/cancel`

Cancel (reason required)

**Who:** `tickets.manage` · **Success:** `200`

> Admin user and Management: any ticket. A department head (or the ticket's supervisor): their tickets.

Path: `publicId` (string (uuid))

Body (application/json): [ReasonRequest](#reasonrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/checklist`

Answer a checklist item (pass, fail or na)

**Who:** `tickets.work` or `tickets.manage` · **Success:** `200`

> Its assignees (tickets.work), the department head / supervisor, admin user and Management.

Path: `publicId` (string (uuid))

Body (application/json): [ChecklistResultRequest](#checklistresultrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `item` | string | yes | min length 1; max length 120 |
| `result` | `pass` \| `fail` \| `na` | yes |  |
| `note` | string | no | max length 500 |

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/complete`

Complete (checks the type version's completion rules)

**Who:** `tickets.work` or `tickets.manage` · **Success:** `200`

> The primary assignee, the department head / supervisor, admin user or Management. Missing items: 409 TICKETS_COMPLETION_INCOMPLETE with details.missing.

Path: `publicId` (string (uuid))

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/head-approval`

Head approval (department head, supervisor or Management; never an assignee)

**Who:** `tickets.manage` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/hold`

Put on hold (reason required)

**Who:** `tickets.manage` · **Success:** `200`

> Admin user and Management: any ticket. A department head (or the ticket's supervisor): their tickets.

Path: `publicId` (string (uuid))

Body (application/json): [ReasonRequest](#reasonrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/links`

Link to another ticket of the same company (follows: same project; or rework_of)

**Who:** `tickets.manage` · **Success:** `201`

> Admin user and Management: any ticket. A department head (or the ticket's supervisor): their tickets.

Path: `publicId` (string (uuid))

Body (application/json): [LinkTicketRequest](#linkticketrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `toTicketPublicId` | string (uuid) | yes |  |
| `kind` | `follows` \| `rework_of` | no | default `"follows"` |

Answer `201` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/reassign-requests`

Ask to be reassigned (assignees; reason required)

**Who:** `tickets.work` · **Success:** `201`

Path: `publicId` (string (uuid))

Body (application/json): [ReasonRequest](#reasonrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

Answer `201` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/reopen`

Reopen a completed ticket (reason required)

**Who:** `tickets.manage` · **Success:** `200`

> Admin user and Management: any ticket. A department head (or the ticket's supervisor): their tickets.

Path: `publicId` (string (uuid))

Body (application/json): [ReasonRequest](#reasonrequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/resume`

Resume a ticket on hold

**Who:** `tickets.manage` · **Success:** `200`

> Admin user and Management: any ticket. A department head (or the ticket's supervisor): their tickets.

Path: `publicId` (string (uuid))

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/signoffs`

Record the customer's sign-off: signer and a photo of the signed sheet

**Who:** `tickets.work` or `tickets.manage` · **Success:** `201` · **Multipart**, file field `photo`

> Its assignees (tickets.work), the department head / supervisor, admin user and Management.

Path: `publicId` (string (uuid))

Body (multipart/form-data)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `signerName` | string | yes | min length 2; max length 100 |
| `signerRole` | string | no | min length 1; max length 100 |
| `signedAt` | string (date-time) | no |  |
| `photo` | string | no |  |

Answer `201` (application/json): [TicketDetail](#ticketdetail)

#### `POST /api/tickets/{publicId}/start`

Start work: assigned → in progress (the first ticket punch-in does the same)

**Who:** `tickets.work` or `tickets.manage` · **Success:** `200`

> Its assignees (tickets.work), the department head / supervisor, admin user and Management.

Path: `publicId` (string (uuid))

Answer `200` (application/json): [TicketDetail](#ticketdetail)

#### `GET /api/tickets/{publicId}/updates`

A ticket's daily updates, newest first

**Who:** `tickets.view` or `tickets.work` or `tickets.manage` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [DailyUpdate](#dailyupdate)[]

#### `POST /api/tickets/{publicId}/updates`

Add my daily update: note, percent complete, up to 5 photos or files (one per ticket per day)

**Who:** `tickets.work` or `tickets.manage` · **Success:** `201` · **Resend:** same `publicId` again answers `200` · **Multipart**, file field `files`

Path: `publicId` (string (uuid))

Body (multipart/form-data)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `note` | string | yes | min length 3; max length 1000 |
| `percentComplete` | integer \| null | yes | min 0; max 100 |
| `workDate` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `files` | string | no |  |

Answer `201` (application/json): [DailyUpdate](#dailyupdate)

### /api/tickets/types

#### `GET /api/tickets/types`

Ticket types (current versions); filter by active, department, company

**Who:** `tickets.types.view` or `tickets.types.manage` · **Success:** `200`

| Query | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `active` | `true` \| `false` | no |  |
| `department` | string (uuid) | no |  |
| `company` | string | no | min length 1; max length 12 |

Answer `200` (application/json): [TicketType](#tickettype)[]

#### `POST /api/tickets/types`

Create a ticket type

**Who:** `tickets.types.manage` · **Success:** `201` · **Resend:** same `publicId` again answers `200`

> Scope all (admin user, Management): any type, standard ones too. Otherwise the head of the owning department, for non-standard types only. A head creates only for a department they head. Name and code are unique per company (name ignoring case).

Body (application/json): [CreateTicketTypeRequest](#createtickettyperequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `company` | string | yes | min length 1; max length 12 |
| `code` | string | yes | pattern `^[a-z][a-z0-9_]{1,39}$` |
| `name` | string | yes | min length 2; max length 80 |
| `ownerDepartmentPublicId` | string (uuid) | no |  |
| `sortOrder` | integer | no | min 0; max 10000; default `100` |
| `fields` | ({ key: string, label: string, type: `text` \| `number` \| `date` \| `money` \| `file` \| `person` \| `customer`, required?: boolean })[] | no | max items 40; default `[]` |
| `completionRules` | { photo_required?: boolean, file_required?: boolean, checklist_required?: boolean, customer_signoff_required?: boolean, head_approval_required?: boolean, daily_update_required?: boolean } | no | default `{}` |
| `checklistItems` | string[] | no | max items 40; default `[]` |

Answer `201` (application/json): [TicketTypeDetail](#tickettypedetail)

#### `GET /api/tickets/types/{publicId}`

One ticket type with every saved version, newest first

**Who:** `tickets.types.view` or `tickets.types.manage` · **Success:** `200`

Path: `publicId` (string (uuid))

Answer `200` (application/json): [TicketTypeDetail](#tickettypedetail)

#### `PATCH /api/tickets/types/{publicId}`

Change a ticket type: saves a new version and keeps the old ones

**Who:** `tickets.types.manage` · **Success:** `200`

> Scope all (admin user, Management): any type, standard ones too. Otherwise the head of the owning department, for non-standard types only. Send only what changes; sending what is already stored saves nothing. The code never changes.

Path: `publicId` (string (uuid))

Body (application/json): [UpdateTicketTypeRequest](#updatetickettyperequest)

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `expectedVersion` | integer | no | min 1 |
| `name` | string | no | min length 2; max length 80 |
| `ownerDepartmentPublicId` | string (uuid) \| null | no |  |
| `sortOrder` | integer | no | min 0; max 10000 |
| `fields` | ({ key: string, label: string, type: `text` \| `number` \| `date` \| `money` \| `file` \| `person` \| `customer`, required?: boolean })[] | no | max items 40 |
| `completionRules` | { photo_required?: boolean, file_required?: boolean, checklist_required?: boolean, customer_signoff_required?: boolean, head_approval_required?: boolean, daily_update_required?: boolean } | no |  |
| `checklistItems` | string[] | no | max items 40 |

Answer `200` (application/json): [TicketTypeDetail](#tickettypedetail)

#### `POST /api/tickets/types/{publicId}/deactivate`

Deactivate a ticket type (no new tickets; old tickets keep it)

**Who:** `tickets.types.manage` · **Success:** `200`

> Scope all (admin user, Management): any type, standard ones too. Otherwise the head of the owning department, for non-standard types only.

Path: `publicId` (string (uuid))

Answer `200` (application/json): [TicketTypeDetail](#tickettypedetail)

#### `POST /api/tickets/types/{publicId}/reactivate`

Reactivate a ticket type

**Who:** `tickets.types.manage` · **Success:** `200`

> Scope all (admin user, Management): any type, standard ones too. Otherwise the head of the owning department, for non-standard types only.

Path: `publicId` (string (uuid))

Answer `200` (application/json): [TicketTypeDetail](#tickettypedetail)

## Schemas

Request and answer shapes, as defined once in `shared/src` (`@ageless/shared`).

### AddAdjustmentRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `kind` | `addition` \| `deduction` | yes |  |
| `label` | string | yes | min length 2; max length 40 |
| `amountPaise` | integer | yes | min 0; max 9007199254740991 |
| `note` | string | no | max length 200 |

### AddBankAccountRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `accountHolder` | string | yes | min length 2; max length 100 |
| `accountNumber` | string | yes | pattern `^[0-9]{6,18}$` |
| `ifsc` | string | yes | pattern `^[A-Z]{4}0[A-Z0-9]{6}$` |
| `effectiveFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

### AddPersonSkillRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `skillPublicId` | string (uuid) | yes |  |
| `level` | `trainee` \| `skilled` \| `expert` | yes |  |

### AddSalaryRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `monthlyAmountPaise` | integer | yes | min 0; max 9007199254740991 |
| `effectiveFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `note` | string | no | max length 200 |

### AdjustTimeRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `personPublicId` | string (uuid) | yes |  |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `reason` | string | yes | min length 3; max length 500 |
| `changes` | ({ ticketPublicId: string (uuid), minutes: integer })[] | yes | min items 1; max items 20 |

### ApplyLeaveRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `leaveTypeCode` | string | yes | min length 1; max length 20 |
| `fromDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `toDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `fromHalf` | `full` \| `second_half` | no | default `"full"` |
| `toHalf` | `full` \| `first_half` | no | default `"full"` |
| `reason` | string | no | min length 3; max length 500 |

### ApprovalsInbox

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `asOf` | string (date-time) | yes |  |
| `counts` | { leave: integer, expense: integer, correction: integer, overtime: integer, ticketReassignment: integer \| null, total: integer } | yes |  |
| `items` | ({ type: `leave` \| `expense` \| `correction` \| `overtime`, publicId: string (uuid), person: object, company: string, fromDate: string \| null, toDate: string \| null, amountPaise: integer \| null, currency: string \| null, summary: string, submittedAt: string (date-time), ageDays: integer })[] | yes |  |

### ApproveExpenseRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `approvedAmountPaise` | integer | no | min 0; max 9007199254740991 |

### ApproveReassignRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `newEmploymentPublicId` | string (uuid) | yes |  |

### AssignRoleRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `personPublicId` | string (uuid) | yes |  |
| `roleCode` | string | yes | min length 1; max length 40 |
| `scope` | `own` \| `team` \| `all` | yes |  |
| `validFrom` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `validTo` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |

### AssignTicketRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `assignees` | ({ employmentPublicId: string (uuid), isPrimary?: boolean })[] | yes | min items 1; max items 20 |

### AttendanceRegister

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `company` | string \| null | yes |  |
| `rows` | ({ employment: object, firstIn: string (date-time) \| null, lastOut: string (date-time) \| null, workedMinutes: integer, extraMinutes: integer, approvedOvertimeMinutes: integer, status: `present` \| `half_day` \| `absent` \| `leave` \| `holiday` \| `weekly_off` \| `missed_punch` \| `working`, locked: boolean, running: boolean, leaveDays: number, absentDays: number, workedOnLeave: boolean, person: object })[] | yes |  |
| `summary` | { present?: integer, half_day?: integer, absent?: integer, leave?: integer, holiday?: integer, weekly_off?: integer, missed_punch?: integer, working?: integer } | yes |  |
| `totals` | { leaveDays: number, absentDays: number } | yes |  |

### BankAccount

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `employment` | { publicId: string (uuid), company: string, employeeCode: string } | yes |  |
| `accountHolder` | string | yes |  |
| `accountNumberMasked` | string | yes |  |
| `ifsc` | string | yes |  |
| `effectiveFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `createdAt` | string (date-time) | yes |  |

### CancelLeaveRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | no | min length 3; max length 500 |

### Certificate

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `name` | string | yes |  |
| `issuer` | string \| null | yes |  |
| `number` | string \| null | yes |  |
| `issuedOn` | string \| null | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `expiresOn` | string \| null | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `status` | `review` \| `verified` \| `expired` | yes |  |
| `hasFile` | boolean | yes |  |
| `verifiedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `verifiedAt` | string (date-time) \| null | yes |  |
| `createdAt` | string (date-time) | yes |  |

### ChangePasswordRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `currentPassword` | string | yes | min length 1; max length 72 |
| `newPassword` | string | yes | min length 8; max length 72 |

### ChecklistResultRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `item` | string | yes | min length 1; max length 120 |
| `result` | `pass` \| `fail` \| `na` | yes |  |
| `note` | string | no | max length 500 |

### ContactInput

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `kind` | `phone` \| `email` \| `other` | yes |  |
| `value` | string | yes | min length 3; max length 100 |
| `label` | string | no | max length 40 |
| `isPrimary` | boolean | no |  |

### Correction

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `employment` | { publicId: string (uuid), company: string } | yes |  |
| `workDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `kind` | `missed_out` \| `missed_in` \| `wrong_time` \| `other` | yes |  |
| `requestedIn` | string (date-time) \| null | yes |  |
| `requestedOut` | string (date-time) \| null | yes |  |
| `punchIdsToExclude` | (string (uuid))[] | yes |  |
| `reason` | string | yes |  |
| `status` | `submitted` \| `approved` \| `rejected` \| `cancelled` | yes |  |
| `requestedBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `approver` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `decidedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `decidedAs` | `approver` \| `hr` \| `management` \| `no_approval_required` \| null | yes |  |
| `decidedAt` | string (date-time) \| null | yes |  |
| `decisionReason` | string \| null | yes |  |
| `cancelledAt` | string (date-time) \| null | yes |  |
| `createdAt` | string (date-time) | yes |  |

### CreateCorrectionRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `workDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `kind` | `missed_out` \| `missed_in` \| `wrong_time` \| `other` | yes |  |
| `requestedIn` | string (date-time) | no |  |
| `requestedOut` | string (date-time) | no |  |
| `punchIdsToExclude` | (string (uuid))[] | no | max items 20; default `[]` |
| `reason` | string | yes | min length 10; max length 500 |

### CreateDepartmentRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | yes | min length 1; max length 12 |
| `name` | string | yes | min length 2; max length 80 |
| `codePrefix` | string | yes | pattern `^[A-Z]{2,6}$` |

### CreatedId

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |

### CreateHolidayRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `company` | string | yes | min length 1; max length 12 |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `name` | string | yes | min length 2; max length 100 |
| `isOptional` | boolean | no | default `false` |

### CreateOvertimeRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `workDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `minutes` | integer | yes | min 1; max 1440 |
| `reason` | string | yes | min length 3; max length 500 |
| `ticketPublicId` | string (uuid) | no |  |

### CreatePersonRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `displayName` | string | yes | min length 2; max length 100 |
| `contacts` | ({ kind: `phone` \| `email` \| `other`, value: string, label?: string, isPrimary?: boolean })[] | no | max items 10; default `[]` |
| `employment` | { legalEntityCode: string, employeeCode?: string, engagementType: `permanent` \| `probation` \| `contract` \| `intern` \| `external`, status?: `active` \| `joining`, recruitedOn?: string, joinedOn: string, departmentCode?: string, designation?: string, managerPublicId?: string (uuid), isPrimary?: `True` } | yes |  |

### CreatePolicyRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `key` | `core.auth.session_hours` \| `hrms.attendance.full_day_minutes` \| `hrms.attendance.half_day_minutes` \| `hrms.attendance.max_open_punch_hours` \| `hrms.attendance.auto_punch_out_hours` \| `hrms.leave.balance_check` \| `hrms.overtime.payable` \| `hrms.approvals.auto_approve_roles` \| `tickets.time.split` \| `payroll.lop_basis` | yes |  |
| `company` | string | no | min length 1; max length 12 |
| `value` | any \| null | no |  |
| `effectiveFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

### CreatePositionRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `company` | string | yes | min length 1; max length 12 |
| `departmentCode` | string | yes | pattern `^[A-Z]{2,6}$` |
| `designation` | string | yes | min length 2; max length 80 |
| `status` | `planned` \| `open` | no | default `"planned"` |
| `notes` | string | no | max length 500 |

### CreateRunRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | yes | min length 1; max length 12 |
| `year` | integer | yes | min 2000; max 2100 |
| `month` | integer | yes | min 1; max 12 |

### CreateSkillRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | yes | min length 1; max length 12 |
| `departmentCode` | string | no | pattern `^[A-Z]{2,6}$` |
| `code` | string | yes | pattern `^[a-z0-9][a-z0-9_-]{1,39}$` |
| `name` | string | yes | min length 2; max length 100 |

### CreateTicketRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `company` | string | yes | min length 1; max length 12 |
| `typePublicId` | string (uuid) | yes |  |
| `title` | string | yes | min length 3; max length 150 |
| `description` | string | no | max length 1000 |
| `priority` | integer | no | min 1; max 5; default `3` |
| `customerId` | string (uuid) | no |  |
| `site` | string | no | min length 1; max length 200 |
| `departmentPublicId` | string (uuid) | yes |  |
| `supervisorPublicId` | string (uuid) | no |  |
| `requiredSkillPublicId` | string (uuid) | no |  |
| `scheduledAt` | string (date-time) | yes |  |
| `dueDate` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `details` | Record<string, any \| null> | no | default `{}` |
| `assignees` | ({ employmentPublicId: string (uuid), isPrimary?: boolean })[] | no | min items 1; max items 20 |

### CreateTicketTypeRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `company` | string | yes | min length 1; max length 12 |
| `code` | string | yes | pattern `^[a-z][a-z0-9_]{1,39}$` |
| `name` | string | yes | min length 2; max length 80 |
| `ownerDepartmentPublicId` | string (uuid) | no |  |
| `sortOrder` | integer | no | min 0; max 10000; default `100` |
| `fields` | ({ key: string, label: string, type: `text` \| `number` \| `date` \| `money` \| `file` \| `person` \| `customer`, required?: boolean })[] | no | max items 40; default `[]` |
| `completionRules` | { photo_required?: boolean, file_required?: boolean, checklist_required?: boolean, customer_signoff_required?: boolean, head_approval_required?: boolean, daily_update_required?: boolean } | no | default `{}` |
| `checklistItems` | string[] | no | max items 40; default `[]` |

### CreateUserRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `personPublicId` | string (uuid) | yes |  |
| `loginPhone` | string | no | min length 6; max length 20 |
| `loginEmail` | string (email) | no | max length 100 |
| `password` | string | yes | min length 8; max length 72 |

### CreateWeeklyOffRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `company` | string | no | min length 1; max length 12 |
| `employmentPublicId` | string (uuid) | no |  |
| `validFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `validTo` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `rule` | { weekdays?: integer[], nthWeekdays?: object[] } | yes |  |

### DailyUpdate

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `workDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `note` | string | yes |  |
| `percentComplete` | integer | yes |  |
| `attachments` | ({ publicId: string (uuid), kind: string, fileType: string })[] | yes |  |
| `createdAt` | string (date-time) | yes |  |

### Dashboard

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `asOf` | string (date-time) | yes |  |
| `month` | string | yes |  |
| `scope` | { visibility: `team` \| `all`, company: string, companies: string[] } | yes |  |
| `totals` | { employees: integer, active: integer, joinersThisMonth: integer, onProbation: integer, onLeaveToday: integer, openPositions: integer \| null, certificatesExpiringIn30Days: integer, pendingExpenses: object[], openTickets: integer \| null, documentsExpiring: integer \| null } | yes |  |
| `attendance` | { from: string, to: string, split: { present: integer, halfDay: integer, missedPunch: integer, absent: integer, leave: integer, holiday: integer, weeklyOff: integer }, daily: object[] } | yes |  |
| `leave` | { submitted: integer, approved: integer, leaveDays: number, byType: object[] } | yes |  |
| `departments` | ({ company: string, code: string \| null, name: string, headcount: integer, attendancePercent: number \| null })[] | yes |  |
| `myApprovals` | { leave: integer, expense: integer, correction: integer, overtime: integer, ticketReassignment: integer \| null, total: integer } | yes |  |
| `recentActivity` | ({ at: string (date-time), action: string, summary: string, actor: object \| null, company: string \| null })[] | yes |  |
| `comparison` | { thisMonth: { month: string, from: string, to: string, employees: integer, presentDays: number, absentDays: number, leaveDays: number, attendancePercent: number \| null, workedMinutes: integer, approvedOvertimeMinutes: integer }, lastMonth: { month: string, from: string, to: string, employees: integer, presentDays: number, absentDays: number, leaveDays: number, attendancePercent: number \| null, workedMinutes: integer, approvedOvertimeMinutes: integer } } | yes |  |

### DayAllocation

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `attendanceMinutes` | integer | yes |  |
| `totalMinutes` | integer | yes |  |
| `rows` | ({ ticket: object, calculatedMinutes: integer, adjustedMinutes: integer, minutes: integer })[] | yes |  |
| `adjustments` | ({ batchId: string (uuid), ticket: object, minutes: integer, reason: string, adjustedBy: object, adjustedAs: `head` \| `management`, at: string (date-time) })[] | yes |  |
| `timelogs` | ({ publicId: string (uuid), ticket: object, startedAt: string (date-time), endedAt: string (date-time) \| null, endReason: `manual` \| `day_punch_out` \| `unfinished` \| null })[] | yes |  |

### Department

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `company` | string | yes |  |
| `name` | string | yes |  |
| `codePrefix` | string | yes |  |
| `head` | { publicId: string (uuid), displayName: string } \| null | yes |  |

### Designation

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `company` | string | yes |  |
| `name` | string | yes |  |

### EmploymentInput

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `legalEntityCode` | string | yes | min length 1; max length 12 |
| `employeeCode` | string | no | min length 1; max length 20 |
| `engagementType` | `permanent` \| `probation` \| `contract` \| `intern` \| `external` | yes |  |
| `status` | `active` \| `joining` | no | default `"active"` |
| `recruitedOn` | string | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `joinedOn` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `departmentCode` | string | no | min length 2; max length 6 |
| `designation` | string | no | max length 80 |
| `managerPublicId` | string (uuid) | no |  |
| `isPrimary` | boolean | no |  |

### ErrorResponse

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `code` | string | yes |  |
| `message` | string | yes |  |
| `details` | any \| null | no |  |

### ExitEmploymentRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `exitOn` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `exitReason` | string | yes | min length 3; max length 200 |

### ExpenseCategory

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `code` | string | yes |  |
| `name` | string | yes |  |
| `receiptRequired` | boolean | yes |  |

### ExpenseClaim

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `employment` | { publicId: string (uuid), company: string, employeeCode: string } | yes |  |
| `category` | { code: string, name: string } | yes |  |
| `spentOn` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `amountPaise` | integer | yes |  |
| `currency` | string | yes |  |
| `description` | string \| null | yes |  |
| `receiptPath` | string \| null | yes |  |
| `status` | `submitted` \| `approved` \| `rejected` \| `paid` | yes |  |
| `approvedAmountPaise` | integer \| null | yes |  |
| `approvedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `approvedAt` | string (date-time) \| null | yes |  |
| `decidedAs` | `approver` \| `hr` \| `management` \| `no_approval_required` \| null | yes |  |
| `rejectedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `rejectedAt` | string (date-time) \| null | yes |  |
| `rejectionReason` | string \| null | yes |  |
| `paidAt` | string (date-time) \| null | yes |  |
| `paymentRef` | string \| null | yes |  |
| `createdAt` | string (date-time) | yes |  |

### ExpenseClaimList

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `items` | ({ publicId: string (uuid), person: object, employment: object, category: object, spentOn: string, amountPaise: integer, currency: string, description: string \| null, receiptPath: string \| null, status: `submitted` \| `approved` \| `rejected` \| `paid`, approvedAmountPaise: integer \| null, approvedBy: object \| null, approvedAt: string (date-time) \| null, decidedAs: `approver` \| `hr` \| `management` \| `no_approval_required` \| null, rejectedBy: object \| null, rejectedAt: string (date-time) \| null, rejectionReason: string \| null, paidAt: string (date-time) \| null, paymentRef: string \| null, createdAt: string (date-time) })[] | yes |  |
| `page` | integer | yes |  |
| `pageSize` | integer | yes |  |
| `total` | integer | yes |  |

### ExpenseReport

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string \| null | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `producedAt` | string (date-time) | yes |  |
| `rows` | ({ count: integer, amountPaise: integer, approvedPaise: integer, paidPaise: integer, person: object, employment: object, category: object, status: `submitted` \| `approved` \| `rejected` \| `paid`, currency: string })[] | yes |  |
| `byStatus` | ({ status: `submitted` \| `approved` \| `rejected` \| `paid`, count: integer, amountPaise: integer })[] | yes |  |
| `byCategory` | ({ count: integer, amountPaise: integer, approvedPaise: integer, paidPaise: integer, code: string, name: string })[] | yes |  |
| `total` | { count: integer, amountPaise: integer, approvedPaise: integer, paidPaise: integer } | yes |  |

### ExpiringCertificates

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `today` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `until` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `certificates` | ({ publicId: string (uuid), person: object, name: string, issuer: string \| null, number: string \| null, issuedOn: string \| null, expiresOn: string \| null, status: `review` \| `verified` \| `expired`, hasFile: boolean, verifiedBy: object \| null, verifiedAt: string (date-time) \| null, createdAt: string (date-time), daysLeft: integer })[] | yes |  |

### FillPositionRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `employmentPublicId` | string (uuid) | yes |  |

### HistoryRow

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `employment` | { publicId: string (uuid), company: string, employeeCode: string } | yes |  |
| `firstIn` | string (date-time) \| null | yes |  |
| `lastOut` | string (date-time) \| null | yes |  |
| `workedMinutes` | integer | yes |  |
| `extraMinutes` | integer | yes |  |
| `approvedOvertimeMinutes` | integer | yes |  |
| `status` | `present` \| `half_day` \| `absent` \| `leave` \| `holiday` \| `weekly_off` \| `missed_punch` \| `working` | yes |  |
| `locked` | boolean | yes |  |
| `running` | boolean | yes |  |
| `leaveDays` | number | yes |  |
| `absentDays` | number | yes |  |
| `workedOnLeave` | boolean | yes |  |
| `punches` | ({ publicId: string (uuid), kind: `in` \| `out`, occurredAt: string (date-time), source: string, corrected: boolean })[] | yes |  |

### Holiday

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `company` | string | yes |  |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `name` | string | yes |  |
| `isOptional` | boolean | yes |  |

### HoursReport

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `report` | string | yes |  |
| `company` | string \| null | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `producedAt` | string (date-time) | yes |  |
| `by` | `ticket` \| `type` \| `person` \| `department` \| `customer` | yes |  |
| `rows` | ({ key: string (uuid) \| null, label: string, minutes: integer, hours: number })[] | yes |  |
| `totals` | { minutes: integer, hours: number } | yes |  |

### LeaveAdjustmentRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | no |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `leaveTypeCode` | string | yes | min length 1; max length 20 |
| `year` | integer | yes | min 2000; max 2100 |
| `entry` | `opening` \| `adjustment` | yes |  |
| `days` | number | yes |  |
| `reason` | string | yes | min length 3; max length 500 |

### LeaveBalance

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `employment` | { publicId: string (uuid), company: string } | yes |  |
| `leaveType` | { code: string, name: string } | yes |  |
| `balance` | number | yes |  |

### LeaveLedgerEntry

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `employment` | { publicId: string (uuid), company: string } | yes |  |
| `leaveType` | { code: string, name: string } | yes |  |
| `year` | integer | yes |  |
| `entry` | `opening` \| `grant` \| `taken` \| `taken_reversal` \| `adjustment` | yes |  |
| `days` | number | yes |  |
| `reason` | string \| null | yes |  |
| `postedAt` | string (date-time) | yes |  |

### LeaveReport

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string \| null | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `producedAt` | string (date-time) | yes |  |
| `rows` | ({ publicId: string (uuid), person: object, employment: object, leaveType: object, fromDate: string, toDate: string, fromHalf: `full` \| `second_half`, toHalf: `full` \| `first_half`, days: number, reason: string \| null, status: `draft` \| `submitted` \| `approved` \| `rejected` \| `cancelled`, approver: object \| null, decidedBy: object \| null, decidedAs: `approver` \| `hr` \| `management` \| `no_approval_required` \| null, decidedAt: string (date-time) \| null, decisionReason: string \| null, cancelledAt: string (date-time) \| null, createdAt: string (date-time) })[] | yes |  |
| `people` | ({ person: object, employment: object, takenByType: Record<string, number>, balanceByType: Record<string, number>, totalTaken: number })[] | yes |  |
| `approvedDaysByType` | ({ code: string, days: number })[] | yes |  |

### LeaveRequestView

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `employment` | { publicId: string (uuid), company: string, employeeCode: string } | yes |  |
| `leaveType` | { code: string, name: string } | yes |  |
| `fromDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `toDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `fromHalf` | `full` \| `second_half` | yes |  |
| `toHalf` | `full` \| `first_half` | yes |  |
| `days` | number | yes |  |
| `reason` | string \| null | yes |  |
| `status` | `draft` \| `submitted` \| `approved` \| `rejected` \| `cancelled` | yes |  |
| `approver` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `decidedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `decidedAs` | `approver` \| `hr` \| `management` \| `no_approval_required` \| null | yes |  |
| `decidedAt` | string (date-time) \| null | yes |  |
| `decisionReason` | string \| null | yes |  |
| `cancelledAt` | string (date-time) \| null | yes |  |
| `createdAt` | string (date-time) | yes |  |

### LeaveType

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `code` | string | yes |  |
| `name` | string | yes |  |
| `isPaid` | boolean | yes |  |

### LinkTicketRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `toTicketPublicId` | string (uuid) | yes |  |
| `kind` | `follows` \| `rework_of` | no | default `"follows"` |

### LockMonthRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | yes | min length 1; max length 12 |
| `year` | integer | yes | min 2000; max 2100 |
| `month` | integer | yes | min 1; max 12 |

### LoginRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `login` | string | yes | min length 3; max length 100 |
| `password` | string | yes | min length 1; max length 72 |

### LoginResponse

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `token` | string | yes |  |
| `expiresAt` | string (date-time) | yes |  |

### MarkExpensePaidRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `paymentRef` | string | yes | min length 1; max length 100 |
| `paidAt` | string (date-time) | no |  |

### MarkRunPaidRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `paidAt` | string (date-time) | yes |  |
| `bankRef` | string | yes | min length 3; max length 60 |

### Me

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `user` | { publicId: string (uuid), loginPhone: string \| null, loginEmail: string \| null } | yes |  |
| `roles` | ({ publicId: string (uuid), code: string, name: string, scope: `own` \| `team` \| `all` })[] | yes |  |
| `permissions` | Record<string, `own` \| `team` \| `all`> | yes |  |

### MissingUpdate

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `ticket` | { publicId: string (uuid), number: string, title: string } | yes |  |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `department` | { publicId: string (uuid), name: string } | yes |  |
| `minutes` | integer | yes |  |

### MissingUpdatesReport

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `report` | string | yes |  |
| `company` | string \| null | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `producedAt` | string (date-time) | yes |  |
| `rows` | ({ person: object, missingUpdates: integer, tickets: integer, minutes: integer })[] | yes |  |
| `totals` | { missingUpdates: integer, minutes: integer } | yes |  |

### MonthLock

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `company` | string | yes |  |
| `year` | integer | yes |  |
| `month` | integer | yes |  |
| `lockedBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `lockedAt` | string (date-time) | yes |  |
| `unlockedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `unlockedAt` | string (date-time) \| null | yes |  |
| `unlockReason` | string \| null | yes |  |

### NumberSeries

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string | yes |  |
| `prefix` | string | yes |  |
| `nextNumber` | integer | yes |  |
| `example` | string | yes |  |

### NumberSeriesRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `prefix` | string | yes | pattern `^[A-Z0-9]{1,10}$` |
| `nextNumber` | integer | yes | min 1; max 99999999 |

### OnHoldReport

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `report` | string | yes |  |
| `company` | string \| null | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `producedAt` | string (date-time) | yes |  |
| `rows` | ({ ticket: object, company: string, type: object, status: `open` \| `assigned` \| `in_progress` \| `on_hold` \| `completed` \| `cancelled`, priority: integer, department: object, supervisor: object, primaryAssignee: object \| null, dueDate: string \| null, holdReason: string, heldSince: string (date-time) \| null })[] | yes |  |
| `totals` | { tickets: integer } | yes |  |

### OverdueReport

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `report` | string | yes |  |
| `company` | string \| null | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `producedAt` | string (date-time) | yes |  |
| `rows` | ({ ticket: object, company: string, type: object, status: `open` \| `assigned` \| `in_progress` \| `on_hold` \| `completed` \| `cancelled`, priority: integer, department: object, supervisor: object, primaryAssignee: object \| null, dueDate: string \| null, daysOverdue: integer })[] | yes |  |
| `totals` | { tickets: integer } | yes |  |

### OvertimeRequestView

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `employment` | { publicId: string (uuid), company: string } | yes |  |
| `workDate` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `minutes` | integer | yes |  |
| `reason` | string | yes |  |
| `ticket` | { publicId: string (uuid), number: string } \| null | yes |  |
| `status` | `submitted` \| `approved` \| `rejected` \| `cancelled` | yes |  |
| `requestedBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `approver` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `decidedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `decidedAs` | `approver` \| `hr` \| `management` \| `no_approval_required` \| null | yes |  |
| `decidedAt` | string (date-time) \| null | yes |  |
| `decisionReason` | string \| null | yes |  |
| `cancelledAt` | string (date-time) \| null | yes |  |
| `createdAt` | string (date-time) | yes |  |

### PayrollRun

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `company` | string | yes |  |
| `year` | integer | yes |  |
| `month` | integer | yes |  |
| `status` | `draft` \| `approved` \| `paid` | yes |  |
| `currency` | string | yes |  |
| `preparedBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `preparedAt` | string (date-time) | yes |  |
| `approvedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `approvedAt` | string (date-time) \| null | yes |  |
| `paidAt` | string (date-time) \| null | yes |  |
| `bankRef` | string \| null | yes |  |
| `totals` | { people: integer, salaryForMonthPaise: integer, additionsPaise: integer, deductionsPaise: integer, netPaise: integer } | yes |  |
| `items` | ({ publicId: string (uuid), person: object, employment: object, currency: string, monthlySalaryPaise: integer, daysInMonth: integer, employedDays: integer, absentDays: number, lopAmountPaise: integer, salaryForMonthPaise: integer, additionsTotalPaise: integer, deductionsTotalPaise: integer, netPayPaise: integer, adjustments: object[] })[] | yes |  |
| `withoutSalary` | ({ person: object, employment: object })[] | yes |  |

### PayrollRunSummary

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `company` | string | yes |  |
| `year` | integer | yes |  |
| `month` | integer | yes |  |
| `status` | `draft` \| `approved` \| `paid` | yes |  |
| `currency` | string | yes |  |
| `preparedBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `preparedAt` | string (date-time) | yes |  |
| `approvedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `approvedAt` | string (date-time) \| null | yes |  |
| `paidAt` | string (date-time) \| null | yes |  |
| `bankRef` | string \| null | yes |  |
| `totals` | { people: integer, salaryForMonthPaise: integer, additionsPaise: integer, deductionsPaise: integer, netPaise: integer } | yes |  |

### Payslip

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `run` | { publicId: string (uuid), company: string, companyName: string, year: integer, month: integer, status: `draft` \| `approved` \| `paid` } | yes |  |
| `item` | { publicId: string (uuid), person: { publicId: string (uuid), displayName: string }, employment: { publicId: string (uuid), company: string, employeeCode: string }, currency: string, monthlySalaryPaise: integer, daysInMonth: integer, employedDays: integer, absentDays: number, lopAmountPaise: integer, salaryForMonthPaise: integer, additionsTotalPaise: integer, deductionsTotalPaise: integer, netPayPaise: integer, adjustments: object[] } | yes |  |

### PersonDetail

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `displayName` | string | yes |  |
| `status` | string | yes |  |
| `contacts` | ({ publicId: string (uuid), kind: string, value: string, label: string \| null, isPrimary: boolean, endedAt: string (date-time) \| null })[] | yes |  |
| `employments` | ({ publicId: string (uuid), company: object, employeeCode: string, engagementType: string, status: string, isPrimary: boolean, recruitedOn: string \| null, joinedOn: string, exitOn: string \| null, exitReason: string \| null, department: object \| null, designation: string \| null, manager: object \| null, hasOfferLetter: boolean })[] | yes |  |
| `private` | { masked: boolean, aadhaar: string \| null, pan: string \| null, bankAccounts: object[] } \| null | yes |  |

### PersonList

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `items` | ({ publicId: string (uuid), displayName: string, status: string, primaryEmployment: object \| null })[] | yes |  |
| `page` | integer | yes |  |
| `pageSize` | integer | yes |  |
| `total` | integer | yes |  |

### PersonSkill

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `skill` | { publicId: string (uuid), code: string, name: string } | yes |  |
| `level` | `trainee` \| `skilled` \| `expert` | yes |  |
| `verifiedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `verifiedAt` | string (date-time) \| null | yes |  |

### Policy

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `key` | string | yes |  |
| `company` | string \| null | yes |  |
| `value` | any \| null | no |  |
| `version` | integer | yes |  |
| `effectiveFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `approvedBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `createdAt` | string (date-time) | yes |  |

### PolicyInForce

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `key` | string | yes |  |
| `company` | string \| null | yes |  |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `value` | any \| null | no |  |
| `source` | { publicId: string (uuid), key: string, company: string \| null, value?: any \| null, version: integer, effectiveFrom: string, approvedBy: { publicId: string (uuid), displayName: string }, createdAt: string (date-time) } \| null | yes |  |

### Position

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `company` | string | yes |  |
| `department` | { code: string, name: string } | yes |  |
| `designation` | string | yes |  |
| `status` | `planned` \| `open` \| `filled` | yes |  |
| `notes` | string \| null | yes |  |
| `filledBy` | { employmentPublicId: string (uuid), employeeCode: string, person: { publicId: string (uuid), displayName: string } } \| null | yes |  |
| `filledAt` | string (date-time) \| null | yes |  |
| `createdAt` | string (date-time) | yes |  |

### PositionStatusRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `status` | `planned` \| `open` | yes |  |

### PrivateDetails

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `masked` | boolean | yes |  |
| `aadhaar` | string \| null | yes |  |
| `pan` | string \| null | yes |  |
| `bankAccounts` | ({ publicId: string (uuid), company: string, employeeCode: string, accountHolder: string, accountNumber: string, ifsc: string, effectiveFrom: string })[] | yes |  |

### Punch

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `kind` | `in` \| `out` | yes |  |
| `occurredAt` | string (date-time) | yes |  |
| `receivedAt` | string (date-time) | yes |  |
| `employment` | { publicId: string (uuid), company: string } | yes |  |
| `locationStatus` | string \| null | yes |  |
| `notices` | ({ code: string, message: string, items: object[] })[] | no |  |
| `confirmation` | { message: string, at: string (date-time), address: string \| null, latitude: number \| null, longitude: number \| null } | yes |  |

### PunchRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `employmentPublicId` | string (uuid) | yes |  |
| `kind` | `in` \| `out` | yes |  |
| `occurredAt` | string (date-time) | yes |  |
| `latitude` | number | no | min -90; max 90 |
| `longitude` | number | no | min -180; max 180 |
| `accuracyM` | integer | no | min 0 |

### ReasonRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

### ReassignmentRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `ticketPublicId` | string (uuid) | yes |  |
| `ticketNumber` | string | yes |  |
| `requestedBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `reason` | string | yes |  |
| `status` | `pending` \| `approved` \| `rejected` | yes |  |
| `approver` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `newAssignee` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `decidedBy` | { publicId: string (uuid), displayName: string } \| null | yes |  |
| `decidedAs` | `approver` \| `hr` \| `management` \| `no_approval_required` \| null | yes |  |
| `decidedAt` | string (date-time) \| null | yes |  |
| `decisionReason` | string \| null | yes |  |
| `createdAt` | string (date-time) | yes |  |

### RebuildResult

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `rebuilt` | integer | yes |  |
| `skippedLocked` | integer | yes |  |

### RebuildWorkDaysRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `employmentPublicId` | string (uuid) | no |  |
| `personPublicId` | string (uuid) | no |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

### RejectCorrectionRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

### RejectExpenseRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

### RejectLeaveRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

### RejectOvertimeRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 3; max length 500 |

### ResetPasswordRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `newPassword` | string | yes | min length 8; max length 72 |

### RunningTicket

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `timelogPublicId` | string (uuid) | yes |  |
| `ticket` | { publicId: string (uuid), number: string, title: string, status: `open` \| `assigned` \| `in_progress` \| `on_hold` \| `completed` \| `cancelled` } | yes |  |
| `startedAt` | string (date-time) | yes |  |

### Salary

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `person` | { publicId: string (uuid), displayName: string } | yes |  |
| `employment` | { publicId: string (uuid), company: string, employeeCode: string } | yes |  |
| `monthlyAmountPaise` | integer | yes |  |
| `currency` | string | yes |  |
| `effectiveFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `note` | string \| null | yes |  |
| `createdBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `createdAt` | string (date-time) | yes |  |

### SharedContacts

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `value` | string | yes |  |
| `people` | ({ publicId: string (uuid), displayName: string, status: string, contact: object })[] | yes |  |

### Skill

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `company` | string | yes |  |
| `department` | { code: string, name: string } \| null | yes |  |
| `code` | string | yes |  |
| `name` | string | yes |  |

### SkillsMatrix

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `rows` | ({ person: object, employment: object, skills: object[], certificates: object[] })[] | yes |  |

### TicketDashboard

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string \| null | yes |  |
| `producedAt` | string (date-time) | yes |  |
| `month` | string | yes |  |
| `lastMonth` | string | yes |  |
| `open` | integer | yes |  |
| `openByType` | ({ type: object, count: integer })[] | yes |  |
| `openByPriority` | ({ priority: integer, count: integer })[] | yes |  |
| `openByTypeAndPriority` | ({ type: object, priority: integer, count: integer })[] | yes |  |
| `overdue` | integer | yes |  |
| `completedThisMonth` | integer | yes |  |
| `completedLastMonth` | integer | yes |  |

### TicketDetail

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `number` | string | yes |  |
| `company` | string | yes |  |
| `type` | { publicId: string (uuid), version: integer, code: string, name: string } | yes |  |
| `title` | string | yes |  |
| `priority` | integer | yes |  |
| `status` | `open` \| `assigned` \| `in_progress` \| `on_hold` \| `completed` \| `cancelled` | yes |  |
| `department` | { publicId: string (uuid), name: string } | yes |  |
| `supervisor` | { publicId: string (uuid), displayName: string } | yes |  |
| `primaryAssignee` | { employmentPublicId: string (uuid), employeeCode: string, person: { publicId: string (uuid), displayName: string }, isPrimary: boolean, assignedAt: string (date-time), assignedBy: { publicId: string (uuid), displayName: string } } \| null | yes |  |
| `customerId` | string (uuid) \| null | yes |  |
| `site` | string \| null | yes |  |
| `scheduledAt` | string (date-time) | yes |  |
| `dueDate` | string \| null | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `overdue` | boolean | yes |  |
| `completedAt` | string (date-time) \| null | yes |  |
| `createdAt` | string (date-time) | yes |  |
| `description` | string \| null | yes |  |
| `details` | Record<string, any \| null> | yes |  |
| `projectId` | any \| null | yes |  |
| `holdReason` | string \| null | yes |  |
| `cancelReason` | string \| null | yes |  |
| `requiredSkill` | { publicId: string (uuid), name: string } \| null | yes |  |
| `headApproval` | { by: { publicId: string (uuid), displayName: string }, at: string (date-time) } \| null | yes |  |
| `createdBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `typeRules` | { fields: object[], completionRules: { photo_required?: boolean, file_required?: boolean, checklist_required?: boolean, customer_signoff_required?: boolean, head_approval_required?: boolean, daily_update_required?: boolean }, checklistItems: string[] } | yes |  |
| `assignees` | ({ employmentPublicId: string (uuid), employeeCode: string, person: object, isPrimary: boolean, assignedAt: string (date-time), assignedBy: object })[] | yes |  |
| `checklist` | ({ item: string, result: `pass` \| `fail` \| `na` \| null, note: string \| null, checkedBy: object \| null, checkedAt: string (date-time) \| null })[] | yes |  |
| `attachments` | ({ publicId: string (uuid), kind: `photo` \| `file` \| `signoff`, fileType: string, uploadedBy: object, uploadedAt: string (date-time) })[] | yes |  |
| `signoffs` | ({ publicId: string (uuid), signerName: string, signerRole: string \| null, signedAt: string (date-time), photoPublicId: string (uuid), recordedBy: object })[] | yes |  |
| `links` | ({ direction: `to` \| `from`, kind: `follows` \| `rework_of`, ticket: object })[] | yes |  |
| `timeline` | ({ action: string, actor: object \| null, at: string (date-time), details: Record<string, any \| null> \| null })[] | yes |  |
| `reassignRequests` | ({ publicId: string (uuid), ticketPublicId: string (uuid), ticketNumber: string, requestedBy: object, reason: string, status: `pending` \| `approved` \| `rejected`, approver: object \| null, newAssignee: object \| null, decidedBy: object \| null, decidedAs: `approver` \| `hr` \| `management` \| `no_approval_required` \| null, decidedAt: string (date-time) \| null, decisionReason: string \| null, createdAt: string (date-time) })[] | yes |  |
| `missingForCompletion` | string[] | yes |  |
| `warnings` | ({ code: string, message: string, employmentPublicId?: string (uuid) })[] | yes |  |

### TicketPunchInRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `occurredAt` | string (date-time) | no |  |
| `items` | ({ publicId: string (uuid), ticketPublicId: string (uuid) })[] | yes | min items 1; max items 20 |
| `latitude` | number | no | min -90; max 90 |
| `longitude` | number | no | min -180; max 180 |
| `accuracyM` | integer | no | min 0 |

### TicketPunchOutRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `occurredAt` | string (date-time) | no |  |
| `tickets` | (string (uuid))[] | no | min items 1; max items 50 |
| `all` | `True` | no |  |

### TicketPunchResult

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `started` | integer | yes |  |
| `stopped` | integer | yes |  |
| `running` | ({ timelogPublicId: string (uuid), ticket: object, startedAt: string (date-time) })[] | yes |  |
| `confirmation` | { message: string, at: string (date-time), address: string \| null, latitude: number \| null, longitude: number \| null, tickets: object[] } | no |  |

### TicketSummary

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `number` | string | yes |  |
| `company` | string | yes |  |
| `type` | { publicId: string (uuid), version: integer, code: string, name: string } | yes |  |
| `title` | string | yes |  |
| `priority` | integer | yes |  |
| `status` | `open` \| `assigned` \| `in_progress` \| `on_hold` \| `completed` \| `cancelled` | yes |  |
| `department` | { publicId: string (uuid), name: string } | yes |  |
| `supervisor` | { publicId: string (uuid), displayName: string } | yes |  |
| `primaryAssignee` | { employmentPublicId: string (uuid), employeeCode: string, person: { publicId: string (uuid), displayName: string }, isPrimary: boolean, assignedAt: string (date-time), assignedBy: { publicId: string (uuid), displayName: string } } \| null | yes |  |
| `customerId` | string (uuid) \| null | yes |  |
| `site` | string \| null | yes |  |
| `scheduledAt` | string (date-time) | yes |  |
| `dueDate` | string \| null | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `overdue` | boolean | yes |  |
| `completedAt` | string (date-time) \| null | yes |  |
| `createdAt` | string (date-time) | yes |  |

### TicketType

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `version` | integer | yes |  |
| `company` | string | yes |  |
| `code` | string | yes |  |
| `isStandard` | boolean | yes |  |
| `active` | boolean | yes |  |
| `name` | string | yes |  |
| `ownerDepartment` | { publicId: string (uuid), name: string } \| null | yes |  |
| `sortOrder` | integer | yes |  |
| `fields` | ({ key: string, label: string, type: `text` \| `number` \| `date` \| `money` \| `file` \| `person` \| `customer`, required?: boolean })[] | yes |  |
| `completionRules` | { photo_required?: boolean, file_required?: boolean, checklist_required?: boolean, customer_signoff_required?: boolean, head_approval_required?: boolean, daily_update_required?: boolean } | yes |  |
| `checklistItems` | string[] | yes |  |
| `createdBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `createdAt` | string (date-time) | yes |  |

### TicketTypeDetail

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `version` | integer | yes |  |
| `company` | string | yes |  |
| `code` | string | yes |  |
| `isStandard` | boolean | yes |  |
| `active` | boolean | yes |  |
| `name` | string | yes |  |
| `ownerDepartment` | { publicId: string (uuid), name: string } \| null | yes |  |
| `sortOrder` | integer | yes |  |
| `fields` | ({ key: string, label: string, type: `text` \| `number` \| `date` \| `money` \| `file` \| `person` \| `customer`, required?: boolean })[] | yes |  |
| `completionRules` | { photo_required?: boolean, file_required?: boolean, checklist_required?: boolean, customer_signoff_required?: boolean, head_approval_required?: boolean, daily_update_required?: boolean } | yes |  |
| `checklistItems` | string[] | yes |  |
| `createdBy` | { publicId: string (uuid), displayName: string } | yes |  |
| `createdAt` | string (date-time) | yes |  |
| `versions` | ({ version: integer, isCurrent: boolean, name: string, ownerDepartment: object \| null, sortOrder: integer, fields: object[], completionRules: object, checklistItems: string[], createdBy: object, createdAt: string (date-time) })[] | yes |  |

### TodayAttendance

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `date` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `punchedIn` | boolean | yes |  |
| `since` | string (date-time) \| null | yes |  |
| `employment` | { publicId: string (uuid), company: string } \| null | yes |  |
| `workedMinutes` | integer | yes |  |
| `lastMissedPunchDate` | string \| null | yes | pattern `^\d{4}-\d{2}-\d{2}$` |

### UnlockMonthRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `reason` | string | yes | min length 5; max length 500 |

### UpdateAdjustmentRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `kind` | `addition` \| `deduction` | no |  |
| `label` | string | no | min length 2; max length 40 |
| `amountPaise` | integer | no | min 0; max 9007199254740991 |
| `note` | string \| null | no | max length 200 |

### UpdateDepartmentRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `name` | string | no | min length 2; max length 80 |
| `headPublicId` | string (uuid) \| null | no |  |

### UpdateEmploymentRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `managerPublicId` | string (uuid) \| null | no |  |
| `departmentCode` | string \| null | no | min length 2; max length 6 |
| `designation` | string \| null | no | max length 80 |
| `isPrimary` | `True` | no |  |

### UpdatePersonRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `displayName` | string | no | min length 2; max length 100 |
| `status` | `active` \| `inactive` \| `exited` | no |  |

### UpdatePrivateRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `aadhaar` | string \| null | no | pattern `^[0-9]{12}$` |
| `pan` | string \| null | no | pattern `^[A-Z]{5}[0-9]{4}[A-Z]$` |

### UpdateTicketRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `title` | string | no | min length 3; max length 150 |
| `description` | string \| null | no | max length 1000 |
| `priority` | integer | no | min 1; max 5 |
| `customerId` | string (uuid) \| null | no |  |
| `site` | string \| null | no | min length 1; max length 200 |
| `supervisorPublicId` | string (uuid) | no |  |
| `requiredSkillPublicId` | string (uuid) \| null | no |  |
| `scheduledAt` | string (date-time) | no |  |
| `dueDate` | string \| null | no | pattern `^\d{4}-\d{2}-\d{2}$` |
| `details` | Record<string, any \| null> | no |  |

### UpdateTicketTypeRequest

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `expectedVersion` | integer | no | min 1 |
| `name` | string | no | min length 2; max length 80 |
| `ownerDepartmentPublicId` | string (uuid) \| null | no |  |
| `sortOrder` | integer | no | min 0; max 10000 |
| `fields` | ({ key: string, label: string, type: `text` \| `number` \| `date` \| `money` \| `file` \| `person` \| `customer`, required?: boolean })[] | no | max items 40 |
| `completionRules` | { photo_required?: boolean, file_required?: boolean, checklist_required?: boolean, customer_signoff_required?: boolean, head_approval_required?: boolean, daily_update_required?: boolean } | no |  |
| `checklistItems` | string[] | no | max items 40 |

### UtilisationReport

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `report` | string | yes |  |
| `company` | string \| null | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `producedAt` | string (date-time) | yes |  |
| `rows` | ({ person: object, attendanceMinutes: integer, ticketMinutes: integer, unallocatedMinutes: integer, utilisationPercent: number \| null })[] | yes |  |
| `totals` | { attendanceMinutes: integer, ticketMinutes: integer, unallocatedMinutes: integer, utilisationPercent: number \| null } | yes |  |

### WeeklyOff

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `publicId` | string (uuid) | yes |  |
| `company` | string | yes |  |
| `employment` | { publicId: string (uuid), employeeCode: string, person: { publicId: string (uuid), displayName: string } } \| null | yes |  |
| `validFrom` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `validTo` | string \| null | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `rule` | { weekdays?: integer[], nthWeekdays?: object[] } | yes |  |

### WeeklyReport

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `report` | string | yes |  |
| `company` | string \| null | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `producedAt` | string (date-time) | yes |  |
| `rows` | ({ weekStart: string, type: object, created: integer, completed: integer })[] | yes |  |
| `totals` | { created: integer, completed: integer } | yes |  |

### WorkCalendar

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `employment` | { publicId: string (uuid), company: string } | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `days` | ({ date: string, kind: `working` \| `weekly_off` \| `holiday`, holiday: string \| null, optionalHoliday: string \| null })[] | yes |  |

### WorkHours

| Field | Type | Required | Rules / notes |
| --- | --- | --- | --- |
| `company` | string \| null | yes |  |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |
| `producedAt` | string (date-time) | yes |  |
| `rows` | ({ person: object, employment: object, days: object, leaveDays: number, absentDays: number, workedMinutes: integer, extraMinutes: integer, approvedOvertimeMinutes: integer, overtimePayable: boolean })[] | yes |  |

## Error codes

Every error answer is `{ code, message, details? }`. General codes:

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION` | the body, query or path does not fit its schema; `details` lists the problems |
| 401 | `AUTH_MISSING` | no `Authorization: Bearer` header |
| 401 | `AUTH_INVALID` | bad token, login or person no longer active, or the password changed after the token was issued |
| 401 | `AUTH_EXPIRED` | the token's time is over (policy `core.auth.session_hours`) |
| 401 | `AUTH_FAILED` | sign-in: wrong login or password (same answer for an unknown login) |
| 403 | `FORBIDDEN` | the caller lacks the route's permission or scope |
| 413 | `TOO_LARGE` | an upload over its size limit |
| 429 | `AUTH_LOCKED` | sign-in: too many failed sign-ins for this account or from this IP address; locked briefly (header `Retry-After`, `details.retryAfterSeconds`) |
| 500 | `INTERNAL` | unexpected error (logged on the server; no details in the answer) |

Codes raised by the modules (from the code; a code may be used in more than one place):

| Code | Status | Example message | Where |
| --- | --- | --- | --- |
| `AUTH_WRONG_PASSWORD` | 400 | The current password is not correct | core/auth |
| `CORE_DUPLICATE_ID` | 409 | This publicId is already used | core/policies |
| `CORE_LOGIN_TAKEN` | 409 | Another login already uses this phone or email | core/auth |
| `CORE_PERSON_NOT_FOUND` | 404 | Person not found | core/auth |
| `CORE_ROLE_ALREADY_ENDED` | 409 | This role has already ended | core/auth |
| `CORE_ROLE_ASSIGNMENT_NOT_FOUND` | 404 | Role assignment not found | core/auth |
| `CORE_SELF_GRANT` | 403 | Nobody can give a role to themselves | core/auth |
| `CORE_UNKNOWN_COMPANY` | 400 | Unknown company … | core/policies |
| `CORE_UNKNOWN_ROLE` | 400 | Unknown role … | core/auth |
| `CORE_USER_EXISTS` | 409 | This person already has a login | core/auth |
| `CORE_USER_NOT_FOUND` | 404 | Login not found | core/auth |
| `HRMS_APPROVED_TOO_HIGH` | 400 | The approved amount is more than the claimed amount | hrms/expenses |
| `HRMS_CERTIFICATE_EXPIRED` | 409 | This certificate has expired | hrms/skills |
| `HRMS_CERTIFICATE_NOT_FOUND` | 404 | Certificate not found | hrms/skills |
| `HRMS_CLAIM_NOT_FOUND` | 404 | Expense claim not found | hrms/expenses |
| `HRMS_CONTACT_ALREADY_ENDED` | 409 | This contact has already ended | hrms/people |
| `HRMS_CONTACT_NOT_FOUND` | 404 | Contact not found | hrms/people |
| `HRMS_CORRECTION_FUTURE` | 400 | A day still to come cannot be corrected | hrms/attendance |
| `HRMS_CORRECTION_NOT_FOUND` | 404 | Correction not found | hrms/attendance |
| `HRMS_CORRECTION_OPEN` | 409 | This day already has a correction waiting for a decision | hrms/attendance |
| `HRMS_CORRECTION_OUTSIDE_DAY` | 400 | The times must be on … (IST) | hrms/attendance |
| `HRMS_CORRECTION_STALE` | 409 | A punch named here was already left out by another correction | hrms/attendance |
| `HRMS_CORRECTION_UNKNOWN_PUNCH` | 400 | Punches to leave out must be this job's punches on that day, not already left out | hrms/attendance |
| `HRMS_DAY_LOCKED` | 409 | This day is locked for payroll | hrms/attendance |
| `HRMS_DEPARTMENT_NOT_FOUND` | 404 | Department not found | hrms/people |
| `HRMS_DUPLICATE_DEPARTMENT` | 409 | This company already has a department with that name or code prefix | hrms/people |
| `HRMS_DUPLICATE_EMPLOYEE_CODE` | 409 | Employee code … is already used in this company | hrms/people |
| `HRMS_DUPLICATE_EMPLOYMENT` | 409 | This person already has an active employment in this company | hrms/people |
| `HRMS_DUPLICATE_ID` | 409 | This publicId is already used | hrms/attendance, hrms/calendar, hrms/expenses, hrms/leave, hrms/people |
| `HRMS_DUPLICATE_SKILL` | 409 | … already has the skill … | hrms/skills |
| `HRMS_EMPLOYEE_CODE_REQUIRED` | 400 | Give an employee code, or a department to generate one | hrms/people |
| `HRMS_EMPLOYMENT_NOT_ACTIVE` | 409 | Only an active employment can be primary | hrms/attendance, hrms/expenses, hrms/leave, hrms/people |
| `HRMS_EMPLOYMENT_NOT_FOUND` | 404 | Employment not found | hrms/attendance, hrms/calendar, hrms/expenses, hrms/leave, hrms/people, payroll/application |
| `HRMS_EMPLOYMENT_NOT_JOINING` | 409 | Only a joining employment can be activated | hrms/people |
| `HRMS_EXIT_BEFORE_JOIN` | 400 | Exit date is before the joining date | hrms/people |
| `HRMS_FILE_TYPE` | 400 | The certificate file must be a PDF, JPEG or PNG file | hrms/people, hrms/skills |
| `HRMS_HOLIDAY_EXISTS` | 409 | … already has a holiday on … | hrms/calendar |
| `HRMS_HOLIDAY_IN_USE` | 409 | An approved leave covers this holiday | hrms/calendar |
| `HRMS_HOLIDAY_NOT_FOUND` | 404 | Holiday not found | hrms/calendar |
| `HRMS_HOLIDAY_PAST` | 409 | Only a holiday still to come can be removed | hrms/calendar |
| `HRMS_LEAVE_BALANCE` | 409 | Not enough leave balance | hrms/leave |
| `HRMS_LEAVE_NOT_FOUND` | 404 | Leave request not found | hrms/leave |
| `HRMS_LEAVE_NO_WORKING_DAYS` | 400 | These dates are all holidays or weekly offs | hrms/leave |
| `HRMS_LEAVE_OVERLAP` | 409 | You already have leave on this job for some of these dates | hrms/leave |
| `HRMS_LEAVE_STARTED` | 409 | This leave has already started and cannot be cancelled | hrms/leave |
| `HRMS_MANAGER_NOT_FOUND` | 400 | Manager not found | hrms/people |
| `HRMS_MONTH_ALREADY_LOCKED` | 409 | This month is already locked | hrms/attendance |
| `HRMS_MONTH_LOCKED` | 409 | …-… is locked for payroll | hrms/attendance |
| `HRMS_MONTH_LOCK_NOT_FOUND` | 404 | Month lock not found | hrms/attendance |
| `HRMS_MONTH_NOT_ENDED` | 400 | A month can be locked once it has ended | hrms/attendance |
| `HRMS_MONTH_NOT_LOCKED` | 409 | Lock … attendance for the company first | hrms/attendance, payroll/application |
| `HRMS_NOT_YOUR_EMPLOYMENT` | 403 | You can only apply for leave on your own job | hrms/attendance, hrms/expenses, hrms/leave |
| `HRMS_NO_FILE` | 404 | No file stored for this certificate | hrms/skills |
| `HRMS_NO_OFFER_LETTER` | 404 | No offer letter stored for this employment | hrms/people |
| `HRMS_OPENING_EXISTS` | 409 | This job already has an opening balance for … | hrms/leave |
| `HRMS_OTHER_COMPANY` | 400 | The employment is in another company | hrms/people |
| `HRMS_OVERTIME_NOT_FOUND` | 404 | Overtime request not found | hrms/attendance |
| `HRMS_PERSON_NOT_FOUND` | 404 | Department head not found | hrms/people, hrms/skills |
| `HRMS_POSITION_FILLED` | 409 | This position is already filled | hrms/people |
| `HRMS_POSITION_NOT_FOUND` | 404 | Position not found | hrms/people |
| `HRMS_PUNCH_IN_FUTURE` | 400 | The punch time is in the future | hrms/attendance |
| `HRMS_RECEIPT_REQUIRED` | 400 | A receipt is required for … expenses | hrms/expenses |
| `HRMS_RECEIPT_TYPE` | 400 | The receipt must be a JPEG, PNG or PDF file | hrms/expenses |
| `HRMS_SELF_APPROVAL` | 403 | Nobody can approve or reject their own claim | hrms/attendance, hrms/expenses, hrms/leave |
| `HRMS_SELF_MANAGER` | 400 | A person cannot be their own manager | hrms/people |
| `HRMS_SELF_VERIFICATION` | 403 | Nobody can verify their own skill or certificate | hrms/skills |
| `HRMS_SKILL_NOT_FOUND` | 404 | Skill not found | hrms/skills |
| `HRMS_UNKNOWN_CATEGORY` | 400 | Unknown expense category … | hrms/expenses |
| `HRMS_UNKNOWN_COMPANY` | 400 | Unknown company … | hrms/attendance, hrms/calendar, hrms/people, hrms/reports, hrms/skills |
| `HRMS_UNKNOWN_DEPARTMENT` | 400 | Unknown department … in this company | hrms/people, hrms/skills |
| `HRMS_UNKNOWN_DESIGNATION` | 400 | Unknown designation … in … | hrms/people |
| `HRMS_UNKNOWN_LEAVE_TYPE` | 400 | Unknown leave type … | hrms/leave |
| `HRMS_UNKNOWN_TICKET` | 400 | Ticket not found | hrms/attendance |
| `HRMS_WEEKLY_OFF_OVERLAP` | 409 | Another weekly-off rule already covers some of these dates | hrms/calendar |
| `PAYROLL_ADJUSTMENT_NOT_FOUND` | 404 | Adjustment not found | payroll/application |
| `PAYROLL_BANK_EXISTS` | 409 | This job already has bank details from that date | payroll/application |
| `PAYROLL_DUPLICATE_ID` | 409 | This publicId is already used | payroll/application |
| `PAYROLL_ITEM_NOT_FOUND` | 404 | Payroll line not found | payroll/application |
| `PAYROLL_NET_NEGATIVE` | 409 | Deductions are more than the pay of … | payroll/application |
| `PAYROLL_RUN_EMPTY` | 409 | Nobody is paid in this run | payroll/application |
| `PAYROLL_RUN_NOT_APPROVED` | 409 | Files are ready once the run is approved | payroll/application |
| `PAYROLL_RUN_NOT_DRAFT` | 409 | The run is …: nothing in it can change | payroll/application |
| `PAYROLL_RUN_NOT_FOUND` | 404 | Payroll run not found | payroll/application |
| `PAYROLL_SALARY_EXISTS` | 409 | This job already has a salary from that date | payroll/application |
| `PAYROLL_SELF_APPROVAL` | 403 | Nobody approves a payroll run they prepared | payroll/application |
| `PAYROLL_UNKNOWN_COMPANY` | 400 | Unknown company … | payroll/application |
| `TICKETS_ADJUST_NEGATIVE` | 400 | … would have less than 0 minutes | tickets/application |
| `TICKETS_ADJUST_OVER_ATTENDANCE` | 400 | Ticket time would be … minutes; the day has … attended minutes | tickets/application |
| `TICKETS_ALREADY_ASSIGNED` | 409 | That person is already on this ticket | tickets/application |
| `TICKETS_ALREADY_RUNNING` | 409 | … is already running | tickets/application |
| `TICKETS_ASSIGNEE_NOT_ACTIVE` | 409 | Assignees must be active employees | tickets/application |
| `TICKETS_ASSIGNEE_ON_LEAVE` | 409 | That person is on approved leave on … | tickets/application |
| `TICKETS_ASSIGNEE_OTHER_COMPANY` | 400 | Assignees must work for the ticket's company | tickets/application |
| `TICKETS_ATTACHMENT_NOT_FOUND` | 404 | Unknown attachment | tickets/application |
| `TICKETS_CHECKLIST_EMPTY` | 400 | checklist_required needs at least one checklist item | tickets/application |
| `TICKETS_COMPLETION_INCOMPLETE` | 409 | Not ready to complete: … | tickets/application |
| `TICKETS_DATE_IN_FUTURE` | 400 | An update is for today or an earlier day | tickets/application |
| `TICKETS_DUPLICATE_CODE` | 409 | This company already has a ticket type with that code | tickets/application |
| `TICKETS_DUPLICATE_ID` | 409 | This publicId is already used | tickets/application |
| `TICKETS_DUPLICATE_LINK` | 409 | These tickets are already linked that way | tickets/application |
| `TICKETS_DUPLICATE_NAME` | 409 | This company already has a ticket type with that name | tickets/application |
| `TICKETS_FILE_REQUIRED` | 400 | Attach the file (field file) | tickets/application |
| `TICKETS_FILE_TYPE` | 400 | Only … files are accepted here | tickets/application |
| `TICKETS_FINISHED` | 409 | Ticket … is … | tickets/application |
| `TICKETS_FORBIDDEN` | 403 | … is not a ticket of a department you head | tickets/application |
| `TICKETS_INVALID_DETAILS` | 400 | Type details do not fit the ticket type: … | tickets/application |
| `TICKETS_LINK_OTHER_COMPANY` | 400 | Linked tickets must belong to the same company | tickets/application |
| `TICKETS_LINK_OTHER_PROJECT` | 400 | A ticket follows only a ticket of the same project | tickets/application |
| `TICKETS_LINK_SELF` | 400 | A ticket cannot be linked to itself | tickets/application |
| `TICKETS_NOT_ASSIGNEE` | 403 | Only an assignee of this ticket can ask to be reassigned | tickets/application |
| `TICKETS_NOT_FOUND` | 404 | Unknown ticket | tickets/application |
| `TICKETS_NOT_ON_TICKET` | 400 | That person has never been assigned to … | tickets/application |
| `TICKETS_NOT_PUNCHED_IN` | 409 | Punch in for the day first | tickets/application |
| `TICKETS_NOT_RUNNING` | 409 | No timer of yours runs on that ticket | tickets/application |
| `TICKETS_NO_SUPERVISOR` | 400 | The department has no head: name a supervisor | tickets/application |
| `TICKETS_PHOTO_REQUIRED` | 400 | Attach a photo of the signed sheet (field photo) | tickets/application |
| `TICKETS_PUNCH_OUT_BEFORE_START` | 400 | … was started at … | tickets/application |
| `TICKETS_REASSIGN_DECIDED` | 409 | This request is already … | tickets/application |
| `TICKETS_REASSIGN_NOT_FOUND` | 404 | Unknown reassignment request | tickets/application |
| `TICKETS_REASSIGN_PENDING` | 409 | You already asked to be reassigned on this ticket | tickets/application |
| `TICKETS_SELF_ADJUST` | 403 | Nobody adjusts their own time | tickets/application |
| `TICKETS_SELF_APPROVAL` | 403 | Nobody decides their own request | tickets/application |
| `TICKETS_SELF_ASSIGN` | 403 | You cannot assign yourself; Management can | tickets/application |
| `TICKETS_SELF_REASSIGN` | 403 | You cannot reassign a ticket to yourself; ask Management | tickets/application |
| `TICKETS_STANDARD_TYPE_LOCKED` | 403 | Standard types can be changed only by admin or Management | tickets/application |
| `TICKETS_SUPERVISOR_OTHER_COMPANY` | 400 | The supervisor must have an active job in the ticket's company | tickets/application |
| `TICKETS_TIME_IN_FUTURE` | 400 | The time is in the future | tickets/application |
| `TICKETS_TOO_MANY_FILES` | 400 | At most … files | tickets/application |
| `TICKETS_TYPE_FORBIDDEN` | 403 | Only admin and Management can move a type to another department | tickets/application |
| `TICKETS_TYPE_INACTIVE` | 409 | The ticket type "…" is deactivated and takes no new tickets | tickets/application |
| `TICKETS_TYPE_NOT_FOUND` | 404 | Unknown ticket type | tickets/application |
| `TICKETS_TYPE_OTHER_COMPANY` | 400 | That ticket type belongs to another company than … | tickets/application |
| `TICKETS_TYPE_VERSION_CONFLICT` | 409 | Someone saved this type at the same moment; reload and try again | tickets/application |
| `TICKETS_UNKNOWN_CHECKLIST_ITEM` | 400 | "…" is not on this ticket's checklist | tickets/application |
| `TICKETS_UNKNOWN_COMPANY` | 400, 404 | Unknown company … | tickets/application |
| `TICKETS_UNKNOWN_DEPARTMENT` | 400 | That department does not belong to … | tickets/application |
| `TICKETS_UNKNOWN_EMPLOYMENT` | 400 | Unknown job … | tickets/application |
| `TICKETS_UNKNOWN_PERSON` | 404 | Unknown person | tickets/application |
| `TICKETS_UNKNOWN_SKILL` | 400 | That skill is not in the ticket's company skills list | tickets/application |
| `TICKETS_UNKNOWN_SUPERVISOR` | 400 | Unknown supervisor | tickets/application |
| `TICKETS_UPDATE_EXISTS` | 409 | You already gave the update for … | tickets/application |
| `TICKETS_WRONG_STATUS` | 409 | Ticket … is … | tickets/application |
