# Tickets API

## Ticket types

A ticket type says what a kind of work asks for (its **fields**) and what it needs before it can be completed
(**completion rules** and a **checklist**). Types belong to a company. Base URL `http://localhost:3000/api`; every call
needs `Authorization: Bearer <token>`. Request and answer shapes are defined once in `shared/src/tickets.ts`.

**Versions.** Editing a type saves a new version; old versions are kept and can be read. `publicId` is the type's id and
is the same on every version. Types are **deactivated, never deleted** (the database refuses deletes and edits of a saved
version). A deactivated type keeps its old tickets but takes no new ones.

**Standard types.** Every company has 13 standard types (`isStandard: true`), added by `pnpm db:seed`:
`sales_visit`, `survey`, `design`, `budgeting`, `purchase`, `production`, `workshop`, `qc`, `packing_transport`,
`site_work`, `installation`, `training_handover`, `service`. They are company-wide (no owner department).
Packing and transportation has no completion rule of its own: every required field is always checked.
Service has `file_required` (the service report); a type has one set of rules, so "report or daily update" is not expressed.

| Who | May |
| --- | --- |
| Staff, HR, anyone with `tickets.types.view` | read |
| Department head (role Supervisor; `tickets.types.manage`, scope team) | create types for a department they head; change, deactivate and reactivate the non-standard types that department owns. Cannot touch standard or company-wide types, and cannot move a type to another department |
| Admin user, Management (`tickets.types.manage`, scope **all**) | everything, standard and company-wide types included |

A "head" is the person set as `headPublicId` of the department (`PATCH /hrms/departments/:id`).

### Shapes

**Field** — `{ "key": "site_address", "label": "Site address", "type": "text", "required": true }`.
`key`: lower-case letters, digits, `_`, starting with a letter, up to 40, unique within the type. `type`: `text`, `number`,
`date`, `money` (integer paise), `file`, `person`, `customer`. `required` defaults to false. Up to 40 fields.

**Completion rules** — all booleans, default false: `photo_required`, `file_required`, `checklist_required`,
`customer_signoff_required`, `head_approval_required`, `daily_update_required`. `checklist_required` needs at least one checklist item.

**Checklist items** — list of labels, up to 40.

**Type** (answer of the list and of every write):
```json
{
  "publicId": "uuid", "version": 2, "company": "ATPL", "code": "qc", "name": "QC",
  "isStandard": true, "active": true, "sortOrder": 80,
  "ownerDepartment": { "publicId": "uuid", "name": "Workshop" },
  "fields": [{ "key": "checked_item", "label": "Checked item", "type": "text", "required": true }],
  "completionRules": { "photo_required": false, "file_required": false, "checklist_required": true,
    "customer_signoff_required": false, "head_approval_required": false, "daily_update_required": false },
  "checklistItems": ["Dimensions as per drawing", "Finish quality"],
  "createdBy": { "publicId": "uuid", "displayName": "Demo Admin" }, "createdAt": "2026-11-06T04:30:00.000Z"
}
```
`ownerDepartment` is `null` for a company-wide type. `createdBy` / `createdAt` describe this version (who saved it).
The **detail** (`GET /:id` and every write) adds `versions`: every saved version, newest first, each
`{ version, isCurrent, name, ownerDepartment, sortOrder, fields, completionRules, checklistItems, createdBy, createdAt }`.

### List — `GET /tickets/types`
Permission `tickets.types.view` (or `manage`). Current versions of every type in the tenant, ordered by company, `sortOrder`, name.

| Query | Meaning |
| --- | --- |
| `active` | `true` / `false` |
| `department` | owner department's `publicId` (an unknown department gives an empty list) |
| `company` | `AE`, `ATPL` |

Answer `200`: `Type[]`.

### One type — `GET /tickets/types/:id`
Permission `tickets.types.view` (or `manage`). Answer `200`: the detail with all versions. `404 TICKETS_TYPE_NOT_FOUND`.

### Create — `POST /tickets/types`
Permission `tickets.types.manage`. Always creates a non-standard type, at version 1, active. Saved with an audit entry, in one transaction.
```json
{
  "publicId": "optional uuid (sending it twice stores one type)",
  "company": "ATPL", "code": "fabrication_check", "name": "Fabrication check",
  "ownerDepartmentPublicId": "uuid, omit for company-wide (scope all only)",
  "sortOrder": 100,
  "fields": [{ "key": "site", "label": "Site", "type": "text", "required": true }],
  "completionRules": { "checklist_required": true },
  "checklistItems": ["Welds clean"]
}
```
| Field | Rule |
| --- | --- |
| `code` | lower-case letters, digits, `_`, 2 to 40, starting with a letter; unique per company; never changes |
| `name` | 2 to 80 characters; unique per company, **ignoring letter case** |
| `ownerDepartmentPublicId` | must belong to `company`; a head must head it |
| `sortOrder` | whole number 0 to 10000, default 100 |
| `fields`, `completionRules`, `checklistItems` | default empty / all false |

Answer `201`: the detail (version 1). The same `publicId` again answers `200` with the stored type.

### Change — `PATCH /tickets/types/:id`
Permission `tickets.types.manage`. Send only what changes. A real change saves **version + 1** and keeps the old one;
sending values equal to the stored ones saves nothing and answers `200` with the current detail. The code never changes.
```json
{ "expectedVersion": 1, "name": "Fabrication check 2", "ownerDepartmentPublicId": null, "sortOrder": 90,
  "fields": [], "completionRules": {}, "checklistItems": [] }
```
`expectedVersion` is optional: the version you were looking at. `ownerDepartmentPublicId` (a department of the same company, or
`null` for company-wide) is for scope all only. At least one field besides `expectedVersion` is required.
Answer `200`: the detail.

### Deactivate / reactivate — `POST /tickets/types/:id/deactivate`, `POST /tickets/types/:id/reactivate`
Permission `tickets.types.manage`; no body. Neither makes a new version. Doing it when the type is already in that state
changes nothing and is not audited. Answer `200`: the detail.

### Used by ticket creation
`POST /tickets` takes the type's current version through `TicketTypesService.activeVersion`, which refuses with
`404 TICKETS_TYPE_NOT_FOUND` / `409 TICKETS_TYPE_INACTIVE`. A ticket keeps the version it was created with.

### Audit
Every create, change, deactivate and reactivate writes `core.audit_log` in the same transaction: action
`tickets.type.created`, `tickets.type.updated` (details: `changed` lists what changed), `tickets.type.deactivated`,
`tickets.type.reactivated`; entity `ticket_type`; the type's `publicId` and company.

### Errors
Every error is `{ code, message, details? }`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION` | the body or query does not fit the shapes (`details` lists the fields): bad key, duplicate field keys, unknown field type, `checklist_required` on create without checklist items, empty PATCH … |
| 400 | `TICKETS_CHECKLIST_EMPTY` | a PATCH would leave `checklist_required` on with no checklist items |
| 400 | `TICKETS_UNKNOWN_COMPANY` | `company` is not a company of the tenant |
| 400 | `TICKETS_UNKNOWN_DEPARTMENT` | the department does not exist or belongs to another company than the type |
| 401 | `AUTH_MISSING`, `AUTH_INVALID`, `AUTH_EXPIRED` | not signed in |
| 403 | `FORBIDDEN` | the caller lacks `tickets.types.manage` (staff, HR) |
| 403 | `TICKETS_TYPE_FORBIDDEN` | a head acting outside a department they head, creating a company-wide type, or moving a type to another department |
| 403 | `TICKETS_STANDARD_TYPE_LOCKED` | a head changing or deactivating a standard type |
| 404 | `TICKETS_TYPE_NOT_FOUND` | unknown type id |
| 409 | `TICKETS_DUPLICATE_NAME` | the company already has a type with that name (any letter case) |
| 409 | `TICKETS_DUPLICATE_CODE` | the company already has a type with that code |
| 409 | `TICKETS_DUPLICATE_ID` | the `publicId` is already used by another tenant |
| 409 | `TICKETS_TYPE_VERSION_CONFLICT` | `expectedVersion` is not the current version (`details.version` is), or two saves collided |
| 409 | `TICKETS_TYPE_INACTIVE` | a new ticket was started on a deactivated type |

## Tickets

A ticket is one piece of work of a ticket type. Shapes: `shared/src/ticket-records.ts`. Records are identified by
`publicId`. **Nothing is deleted**: tickets are cancelled, assignees are taken off (kept with `ended_at`), and the
timeline, checklist answers, files, sign-offs and links are append-only (the database refuses changes). **Every change
writes a timeline event** in the same transaction.

| Who | May |
| --- | --- |
| Management (CEO; role Management) | everything, every company; picks themselves when reassigning |
| Admin user (`tickets.manage`, scope all) | create, edit details, assign, hold, resume, complete, cancel, reopen, link, every ticket |
| Department head (role Supervisor, `tickets.manage` team) | the same for tickets of a department they head, or tickets they supervise |
| Staff (`tickets.work`, own) | see and work on tickets they are a current assignee of: start, checklist, files, sign-off, daily updates, ask for reassignment; complete only as primary |
| HR (`tickets.view`, all) | view every ticket; set the number series (`tickets.numbering.manage`) |

A ticket the caller may not see answers `404 TICKETS_NOT_FOUND` (it is not revealed); one they see but may not change
answers `403 TICKETS_FORBIDDEN`. Nobody but Management adds themselves as an assignee (`403 TICKETS_SELF_ASSIGN`).

### Numbers
Each company has its own series `<PREFIX>-0001`. The default prefix is the company code (`AE-0001`). Creating a ticket
takes the next free number (numbers already taken, such as imported Froid tickets, are skipped).

- `GET /tickets/number-series` — `tickets.numbering.manage` (all). Answer: `[{ company, prefix, nextNumber, example }]`.
- `PUT /tickets/number-series/:company` — body `{ "prefix": "AGE", "nextNumber": 559 }` (prefix: capitals and digits, up to 10).
  Answer: `{ company, prefix, nextNumber, example: "AGE-0559" }`. Unknown company: `404 TICKETS_UNKNOWN_COMPANY`.

### Lifecycle
```
open ──assign──▶ assigned ──start / first ticket punch-in──▶ in_progress ◀──resume── on_hold
                                                             │  └──hold (reason)──▶┘
                                                             └──complete──▶ completed ──reopen (reason)──▶ in_progress
open, assigned, in_progress, on_hold ──cancel (reason)──▶ cancelled
```
A move from the wrong status: `409 TICKETS_WRONG_STATUS` (`details.status`). Completed and cancelled tickets do not
change details or assignees (`409 TICKETS_FINISHED` / `TICKETS_WRONG_STATUS`). Reopening keeps the checklist, files,
sign-offs and head approval.

### Type details
`details` holds a value per field of the ticket's type version, by key. Unknown keys and wrong values are refused with
`400 TICKETS_INVALID_DETAILS` and `details.errors`, e.g. `["vendor: required", "amount: must be whole paise, 0 or more"]`.

| Field type | Value |
| --- | --- |
| `text` | text, up to 1000 characters (trimmed) |
| `customer` | text up to 200 characters, until the customer register exists |
| `number` | a number |
| `money` | whole paise, 0 or more |
| `date` | `YYYY-MM-DD` |
| `person` | a person's `publicId` (must exist) |
| `file` | the `publicId` of an attachment **of this ticket** — upload first, then set it with PATCH |

Required fields must be filled on create and edit, except `file` fields; **every** required field is checked at completion.

### Create — `POST /tickets`
`tickets.manage`: admin user / Management, or the head of `departmentPublicId`.
```json
{
  "publicId": "optional uuid (sending it twice stores one ticket; the second answers 200)",
  "company": "AE", "typePublicId": "uuid (an active type of that company)", "title": "Buy M8 bolts",
  "description": "optional, up to 1000", "priority": 3, "customerId": "optional uuid", "site": "optional",
  "departmentPublicId": "uuid (of the same company)", "supervisorPublicId": "optional; default: the department's head",
  "requiredSkillPublicId": "optional skill of the company", "scheduledAt": "2026-12-10T04:30:00Z", "dueDate": "2026-12-12",
  "details": { "vendor": "Acme", "items": "M8 bolts", "amount": 150000 },
  "assignees": [{ "employmentPublicId": "uuid", "isPrimary": true }]
}
```
The supervisor must have an active job in the company (`400 TICKETS_SUPERVISOR_OTHER_COMPANY`; no head and none named:
`400 TICKETS_NO_SUPERVISOR`). `customerId` is stored as given until the customer register exists; `projectId` is always
`null` until projects exist. Answer `201`: the detail (`warnings` as for assign).

### List — `GET /tickets`, my tickets — `GET /tickets/mine`
Any of `tickets.view` / `work` / `manage`. HR, admin user and Management see every ticket; a head sees their
departments' and supervised tickets plus their own assignments; staff see the tickets they are currently assigned to.
`/mine` is always only the caller's current assignments (`?status=`).

| Query | Meaning |
| --- | --- |
| `company` | `AE`, `ATPL` |
| `type` | ticket type `publicId` |
| `status` | `open`, `assigned`, `in_progress`, `on_hold`, `completed`, `cancelled` |
| `department` | department `publicId` |
| `assignee` | a current assignee: employment **or** person `publicId` |
| `customer` | customer id |
| `priority` | 1 to 5 |
| `overdue` | `true`: due date before today (IST) and not completed or cancelled |
| `from`, `to` | scheduled date range, IST dates, both included |
| `limit`, `offset` | default 100, at most 500 |

Answer: summaries ordered by scheduled time —
`{ publicId, number, company, type: { publicId, version, code, name }, title, priority, status, department, supervisor,
primaryAssignee, customerId, site, scheduledAt, dueDate, overdue, completedAt, createdAt }`.

### View — `GET /tickets/:id`
The summary plus `description`, `details`, `projectId`, `holdReason`, `cancelReason`, `requiredSkill`, `headApproval`
(`{ by, at }` or null), `createdBy`, `typeRules` (the version's fields, completion rules, checklist items), `assignees`
(current; primary first), `checklist` (every item with its newest answer or null), `attachments`, `signoffs`, `links`
(`{ direction: "to" | "from", kind, ticket }`), `timeline` (oldest first: `{ action, actor, at, details }`; actor null =
the system), `reassignRequests`, `missingForCompletion` (what completion still needs; empty when ready) and `warnings`.

### Update details — `PATCH /tickets/:id`
`tickets.manage` for this ticket. Any of `title`, `description`, `priority`, `customerId`, `site`, `supervisorPublicId`,
`requiredSkillPublicId`, `scheduledAt`, `dueDate` (null clears optional ones) and `details` (the whole set; checked against
the ticket's own type version). Not after completion or cancellation. Writes `details_updated` with the changed fields;
sending what is stored changes nothing. Changing `scheduledAt` does not re-check the assignees' leave.

### Assign — `PUT /tickets/:id/assignees`
`tickets.manage`. Body `{ "assignees": [{ "employmentPublicId": "uuid", "isPrimary": true }, { "employmentPublicId": "uuid" }] }`
— the **whole list**: people left out are taken off. One person is primary by default; with more, exactly one must be
marked (else `400 VALIDATION`). The database also keeps exactly one current primary. Each newly added person must have:
- a job in the ticket's company (`400 TICKETS_ASSIGNEE_OTHER_COMPANY`), and an active one (`409 TICKETS_ASSIGNEE_NOT_ACTIVE`);
- no approved leave on the scheduled date, IST (`409 TICKETS_ASSIGNEE_ON_LEAVE`, `details: { employmentPublicId, date }`).

Without the ticket's required skill they are still assigned, with a warning in the answer:
`warnings: [{ code: "TICKETS_ASSIGNEE_MISSING_SKILL", message, employmentPublicId }]`. The first assignment moves the
ticket from `open` to `assigned`. Event: `assignees_changed` (`added`, `removed`, `primary`).

### Status moves — all `POST`, answer `200` with the detail
| Path | Who | Body | Event |
| --- | --- | --- | --- |
| `/tickets/:id/start` | assignees, managers | — | `started` |
| `/tickets/:id/hold` | managers | `{ "reason": "Waiting for parts" }` (3–500 characters) | `held` |
| `/tickets/:id/resume` | managers | — | `resumed` |
| `/tickets/:id/complete` | primary assignee, managers | — | `completed` |
| `/tickets/:id/cancel` | managers | `{ "reason": "..." }` | `cancelled` |
| `/tickets/:id/reopen` | managers | `{ "reason": "..." }` | `reopened` |

"Managers": the department head / supervisor, admin user, Management. A missing reason is `400 VALIDATION`.
Status events carry `{ from, to }` and the reason.

**Completion** checks the type version's rules and refuses with `409 TICKETS_COMPLETION_INCOMPLETE`,
`details.missing` listing codes: `field:<key>` (a required field is empty), `photo`, `file`, `checklist:<item>` (not
answered), `customer_signoff`, `head_approval`, `daily_update` (at least one daily update).

**QC rework.** When a ticket of type `qc` is completed with any checklist item answered `fail`, a production ticket is
created in the same transaction: type `production` (the company's active version), title `Rework: <title>`, details
copied from the production ticket the QC ticket `follows` (or `item` = the QC `checked_item`), linked `rework_of` that
production ticket (or of the QC ticket when there is none), same department and supervisor, assigned to that production
ticket's primary assignee (else the QC ticket's supervisor, when they have an active job in the company; else left
`open`). The automatic assignment does not check leave. Both tickets get a `rework_created` event. Without an active
production type nothing is created and the QC ticket gets `rework_skipped`.

### Work on the ticket
Assignees (`tickets.work`) and managers, while the ticket is not completed or cancelled:

- `POST /tickets/:id/checklist` — `{ "item": "Finish quality", "result": "pass" | "fail" | "na", "note": "optional" }`.
  The item must be on the type version's checklist (`400 TICKETS_UNKNOWN_CHECKLIST_ITEM`). Answering again adds a newer
  answer; the newest counts. Event `checklist_answered`.
- `POST /tickets/:id/attachments` — multipart: `kind` = `photo` (JPEG, PNG) or `file` (JPEG, PNG, PDF), file field
  `file`, up to 10 MB. The type is read from the bytes (`400 TICKETS_FILE_TYPE`; none: `400 TICKETS_FILE_REQUIRED`).
  Answer `201`. Event `attachment_added`.
- `GET /tickets/:id/attachments/:attachmentId` — the file, for anyone who sees the ticket.
- `POST /tickets/:id/signoffs` — multipart: `signerName`, optional `signerRole`, optional `signedAt`, file field `photo`
  (the signed handover sheet, JPEG or PNG; missing: `400 TICKETS_PHOTO_REQUIRED`). Stored as a `signoff` attachment plus
  the sign-off, together. Answer `201`. Event `signoff_added`.
- Daily updates (note, percent complete, photos or files): see **Ticket time → Daily updates** below.

`POST /tickets/:id/head-approval` — the department head, the supervisor or Management, **never an assignee** of the
ticket (`403 TICKETS_SELF_APPROVAL`). Approving again changes nothing. Event `head_approved`.

### Links — `POST /tickets/:id/links`
Managers. `{ "toTicketPublicId": "uuid", "kind": "follows" | "rework_of" }` (default `follows`). Both tickets must be of
the same company (`400 TICKETS_LINK_OTHER_COMPANY`; the database refuses it too); `follows` needs the same project
(`400 TICKETS_LINK_OTHER_PROJECT`; both without a project counts as the same until projects exist). Not to itself
(`400 TICKETS_LINK_SELF`); twice: `409 TICKETS_DUPLICATE_LINK`. Answer `201`. Event `linked` on both tickets.

### Reassignment
- `POST /tickets/:id/reassign-requests` — a current assignee (`tickets.work`), `{ "reason": "..." }`. Answer `201`. The
  approver is the ticket's supervisor; when the supervisor is the one asking, the usual approver chain (their manager,
  department head, HR, CEO — never themselves). One pending request per person per ticket (`409 TICKETS_REASSIGN_PENDING`).
  Not an assignee: `403 TICKETS_NOT_ASSIGNEE`. Event `reassign_requested`.
- `GET /tickets/reassign-requests?status=pending` — requests I decide (Management: all).
- `POST /tickets/reassign-requests/:requestId/approve` — `{ "newEmploymentPublicId": "uuid" }`. The named approver or
  Management (`decidedAs`: `approver` / `management`); never the person who asked (`403 TICKETS_SELF_APPROVAL`). The new
  person passes the assignment checks (company, active, leave; skill is a warning) and takes the asker's place (primary
  if the asker was). An approver picking themselves: `403 TICKETS_SELF_REASSIGN` (only Management may). Already on the
  ticket: `409 TICKETS_ALREADY_ASSIGNED`. Answer `200`: the ticket. Event `reassign_approved`.
- `POST /tickets/reassign-requests/:requestId/reject` — `{ "reason": "..." }`. Event `reassign_rejected`.
- Decided already: `409 TICKETS_REASSIGN_DECIDED`; unknown: `404 TICKETS_REASSIGN_NOT_FOUND`.

Admin user and Management can also change assignees directly with `PUT /tickets/:id/assignees`, without a request.

### Timeline actions
`created`, `details_updated`, `assignees_changed`, `started`, `held`, `resumed`, `completed`, `cancelled`, `reopened`,
`checklist_answered`, `attachment_added`, `signoff_added`, `daily_update`, `head_approved`, `linked`, `rework_created`,
`rework_skipped`, `reassign_requested`, `reassign_approved`, `reassign_rejected`, `time_started`, `time_stopped`
(`details.reason`: `manual`, `day_punch_out`, `unfinished`; actor null when the system stopped it), `time_adjusted`.

### Ticket errors (besides those above)
| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION` | body or query does not fit (missing reason, two primaries, bad uuid …) |
| 400 | `TICKETS_INVALID_DETAILS` | type details do not fit the type version (`details.errors`) |
| 400 | `TICKETS_TYPE_OTHER_COMPANY` | the type belongs to another company |
| 400 | `TICKETS_UNKNOWN_DEPARTMENT`, `TICKETS_UNKNOWN_SKILL`, `TICKETS_UNKNOWN_EMPLOYMENT`, `TICKETS_UNKNOWN_SUPERVISOR` | not found in the tenant / company |
| 400 | `TICKETS_NO_SUPERVISOR`, `TICKETS_SUPERVISOR_OTHER_COMPANY` | see Create |
| 403 | `FORBIDDEN` | the caller lacks the route's permission (e.g. HR changing a ticket) |
| 403 | `TICKETS_FORBIDDEN` | visible, but not the caller's to change |
| 404 | `TICKETS_NOT_FOUND` | unknown, or not visible to the caller |
| 409 | `TICKETS_DUPLICATE_ID` | the `publicId` is used by another tenant |

## Ticket time

As in Froid: while punched in for the day, a person runs **timers** on the tickets they are assigned to — several at
once. Shapes: `shared/src/ticket-time.ts`. **Nobody edits a punch, a timer or their own ticket time**: there are no
endpoints for it and the database refuses it (a timelog is only closed once; adjustments are append-only).

### Timers (`tickets.ticket_timelogs`)
One row per timer: ticket, the person's job on it (employment), `started_at`, `ended_at`, `end_reason`, `public_id`
(made on the device: a resend is stored once). How a timer ends:

| `end_reason` | When | Ends at |
| --- | --- | --- |
| `manual` | ticket punch-out | the punch-out time |
| `day_punch_out` | the daily punch-out (`POST /hrms/attendance/punches`, kind `out`) stops **every** running timer | the daily punch-out time |
| `unfinished` | the daily punch-in became a missed punch: an automatic punch-out (added when the next punch-in arrives), or open longer than `hrms.attendance.max_open_punch_hours` (16 h; closed by `tickets:daily`) | its own start: the last complete punch it had, so it **counts no time** |

There is no automatic ticket punch-out: an automatic daily punch-out never counts as one.

### Punch in — `POST /tickets/punch-in`
`tickets.work`. Starts a timer on each ticket, **in one transaction** (all or none).
```json
{ "occurredAt": "2026-10-05T03:30:00Z", "latitude": 15.4909, "longitude": 73.8278, "accuracyM": 12,
  "items": [{ "publicId": "uuid made on the device", "ticketPublicId": "uuid" }] }
```
- `occurredAt` is optional (default now), never in the future (`400 TICKETS_TIME_IN_FUTURE`).
- `latitude` / `longitude` (together) and `accuracyM` are optional: one place for all the tickets; its address goes in
  the confirmation (see **Punch confirmations and addresses**).
- Only while punched in for the day at that time: the person's latest punch is a real punch-in at or before it, open for
  no longer than the open-punch limit (`409 TICKETS_NOT_PUNCHED_IN`).
- Only on tickets the caller is currently assigned to (`403 TICKETS_NOT_ASSIGNEE`; a ticket they cannot see: `404`),
  status `assigned` or `in_progress` (`409 TICKETS_WRONG_STATUS`). The first punch-in moves an `assigned` ticket to
  `in_progress` (event `started`, `details.by = ticket_punch`).
- One running timer per person and ticket (`409 TICKETS_ALREADY_RUNNING`).
- Items whose `publicId` is already stored are not stored again; if all are, the answer is `200` (else `201`). A
  `publicId` of someone else: `409 TICKETS_DUPLICATE_ID`.

Answer:
```json
{ "started": 2, "stopped": 0,
  "running": [{ "timelogPublicId": "uuid", "ticket": { "publicId", "number", "title", "status" }, "startedAt": "..." }],
  "confirmation": {
    "message": "Ticket punch-in (2 tickets) at 09:30 IST on 25 Oct 2026, Test Road 1, Test Town, Goa",
    "at": "2026-10-25T04:00:00.000Z", "address": "Test Road 1, Test Town, Goa", "latitude": 15.4909, "longitude": 73.8278,
    "tickets": [{ "publicId": "uuid", "number": "AE-0012", "customer": "Wonder Park", "description": "Demo of the new ride" }] } }
```
`confirmation.tickets` lists the tickets of this request: `customer` is the value of the type's `customer` field (null
when the type has none), `description` the ticket's. A resend answers the same confirmation. Event `time_started` on
each ticket.

### Punch out — `POST /tickets/punch-out`
`tickets.work`. `{ "tickets": ["uuid", ...] }` (one or several) **or** `{ "all": true }`, optional `occurredAt`.
A ticket without a running timer of the caller: `409 TICKETS_NOT_RUNNING`; a time before the timer's start:
`400 TICKETS_PUNCH_OUT_BEFORE_START`. Answer `200` like punch-in. Event `time_stopped` (reason `manual`).

### My running timers — `GET /tickets/time/running`
`tickets.work`. `[{ timelogPublicId, ticket, startedAt }]`.

### Shared time per work day (`tickets.ticket_time_allocations`)
Policy `tickets.time.split` (`equal`, the only rule so far): timers are cut to the attended periods (complete daily
in/out pairs of that IST date, all jobs); for each stretch where **n** tickets run together, each ticket gets **1/n** of
it. Example: three tickets for 3 h, then two of them for 5 h → 1 h / 3.5 h / 3.5 h. Stored in whole minutes per ticket,
person and work day; the total **never exceeds the day's attended minutes** (ceiling). Recalculated whenever the day
changes: ticket punch-out, daily punches, corrections, leave and calendar changes, rebuilds. Running timers count once
they stop.

### A person's day — `GET /tickets/time/allocations?person=<personPublicId>&date=YYYY-MM-DD`
The person themselves; the head or supervisor of one of their tickets that day; HR, admin user, Management (else
`403 TICKETS_FORBIDDEN`; unknown person `404 TICKETS_UNKNOWN_PERSON`).
```json
{
  "person": { "publicId": "uuid", "displayName": "..." }, "date": "2026-10-05", "attendanceMinutes": 480, "totalMinutes": 480,
  "rows": [{ "ticket": { "publicId", "number", "title" }, "calculatedMinutes": 60, "adjustedMinutes": 30, "minutes": 90 }],
  "adjustments": [{ "batchId", "ticket", "minutes": 30, "reason": "...", "adjustedBy", "adjustedAs": "head", "at" }],
  "timelogs": [{ "publicId", "ticket", "startedAt", "endedAt", "endReason" }]
}
```

### Head adjustment — `POST /tickets/time/adjustments`
`tickets.time.adjust` (Supervisor: team; Management: all). Moves a person's minutes between tickets on one day:
```json
{ "personPublicId": "uuid", "date": "2026-10-05", "reason": "Most of the morning was on the first site",
  "changes": [{ "ticketPublicId": "uuid", "minutes": 30 }, { "ticketPublicId": "uuid", "minutes": -30 }] }
```
- Stored as separate adjustment rows (one `batchId`); timelogs and the calculated allocation never change. The day's
  time is allocation + adjustments.
- Reason required (`400 VALIDATION`). Nobody adjusts their own time, Management included (`403 TICKETS_SELF_ADJUST`).
- A head only for tickets of departments they head or tickets they supervise (`403 TICKETS_FORBIDDEN`); Management for
  any ticket and their adjustments apply directly (`adjustedAs`: `head` or `management`).
- The person must have been assigned to each ticket (`400 TICKETS_NOT_ON_TICKET`). No ticket below 0
  (`400 TICKETS_ADJUST_NEGATIVE`), and the day's total within the attended minutes (`400 TICKETS_ADJUST_OVER_ATTENDANCE`,
  `details: { totalMinutes, attendanceMinutes }`).
- Answer `201`: the person's day. Event `time_adjusted` on each ticket.

### Daily updates
- `POST /tickets/:id/updates` — assignees and managers, JSON or multipart: `note` (3–1000), `percentComplete` (0–100),
  optional `workDate` (IST, default today, not in the future), optional `publicId` (a resend answers `200` with the
  stored update), up to 5 files in the field `files` (JPEG / PNG photos, PDF files; `400 TICKETS_FILE_TYPE`,
  `400 TICKETS_TOO_MANY_FILES`). **One per person, ticket and day** (`409 TICKETS_UPDATE_EXISTS`). Answer `201`:
  `{ publicId, workDate, person, note, percentComplete, attachments: [{ publicId, kind, fileType }], createdAt }`.
  Event `daily_update`; the completion rule `daily_update_required` needs at least one.
- `GET /tickets/:id/updates` — newest first, for anyone who sees the ticket.
- **At the daily punch-out** the punch answer carries a notice listing today's tickets the person ran a timer on
  without an update — the app asks, it never blocks:
  `"notices": [{ "code": "TICKETS_DAILY_UPDATE_MISSING", "message": "...", "items": [{ "publicId", "label": "AE-0012 Site work" }] }]`.
- `GET /tickets/daily-updates/missing?date=YYYY-MM-DD` (default yesterday) — who ran a timer on a ticket that day
  without its update: `[{ date, ticket, person, department, minutes }]`. Heads see their departments; HR, admin user and
  Management all; anyone else themselves. This is the next-day flag for the department head.

### Daily job
`pnpm --filter @ageless/backend tickets:daily` (after `pnpm --filter @ageless/backend build`), every morning: closes the
timers of people whose daily punch-in has been open longer than the open-punch limit, as `unfinished`.

## Punch confirmations and addresses

The daily punch (`POST /hrms/attendance/punches`) and the ticket punch-in answer a **confirmation**: what the person is
shown now (push and WhatsApp later use the same text). Every punch answer carries it, a resend included.
```json
"confirmation": { "message": "Punched in at 09:00 IST on 22 Oct 2026, Test Road 1, Test Town, Goa",
  "at": "2026-10-22T03:30:00.000Z", "address": "Test Road 1, Test Town, Goa", "latitude": 15.4909, "longitude": 73.8278 }
```
- With coordinates but no address yet the message shows them: `…, location 15.490900, 73.827800 (address to follow)`;
  without a location sent: `…, no location sent` (address, latitude and longitude null).
- The ticket punch-in confirmation adds `tickets` (number, customer, description) — see **Punch in** above.

**Addresses.** When a punch carries `latitude` / `longitude`, the reverse-geocoding adapter (`platform/geocoding.ts`) is
asked for the address **before** the punch's transaction, and the place is stored with the punch (`core.places`;
`hrms.attendance_events.place_id`, `tickets.ticket_timelogs.place_id`):

| Outcome | Stored |
| --- | --- |
| the provider answers | `status = resolved`, the address |
| no provider configured | coordinates only, `status = pending`, 0 attempts |
| the lookup fails (error, timeout, empty answer) | coordinates only, `status = pending`, 1 attempt |

The background job `pnpm --filter @ageless/backend addresses:retry` (every 15 minutes or so) asks again for pending
places, oldest first; after 10 failed attempts a place is `failed`. While no provider is configured it does nothing.
Settings (`backend/.env`, never in code): `GEOCODING_PROVIDER` = `none` (default) | `nominatim` | `google`,
`GEOCODING_URL` (the provider's base URL, e.g. your own Nominatim server), `GEOCODING_API_KEY` (Google needs one),
`GEOCODING_TIMEOUT_MS` (default 3000). Locations and addresses are never logged; the job prints counts only.

## Reports

All under `GET /tickets/reports/...`, JSON or CSV (`format=csv`). Time is always **allocated time**: the shared time
per work day plus heads' adjustments (`ticket_time_allocations` + `ticket_time_adjustments`), never raw overlapping
timer time. Every report answers `report`, `company` (or null for all), `from`, `to`, `producedAt`, `rows`, `totals`; the
CSV starts with the same facts (Report, Company, Period, Produced at), then the rows and a `TOTAL` line with the same
totals as the screen.

| Who | Sees |
| --- | --- |
| HR, admin user, Management | every ticket (and every person) |
| Department head | tickets of the departments they head; utilisation: the people of those departments |
| Anyone else | `403 TICKETS_FORBIDDEN` |

Period reports take `from`, `to` (IST dates, at most 366 days) and optional `company`; `overdue` and `on-hold` are
as of today (`from = to = today`) and take only `company`. Unknown company: `400 TICKETS_UNKNOWN_COMPANY`.

| Path | Rows | Totals |
| --- | --- | --- |
| `hours?by=ticket\|type\|person\|department\|customer` (default ticket) | `{ key, label, minutes, hours }` — key is the ticket / type / person / department publicId; customers are grouped by the type's customer field (`(no customer)`), key null | `{ minutes, hours }` |
| `utilisation` | per person `{ person, attendanceMinutes, ticketMinutes, unallocatedMinutes, utilisationPercent }` — utilisation = ticket ÷ attendance × 100 (one decimal; null without attendance); unallocated = attendance − ticket time (information only). Attendance is the stored work days' minutes | the same fields over all rows |
| `overdue` | due date before today and not completed or cancelled: ticket, company, type, status, priority, department, supervisor, primary assignee, due date, `daysOverdue` | `{ tickets }` |
| `on-hold` | the same ticket fields plus `holdReason` and `heldSince` (when it was last put on hold) | `{ tickets }` |
| `weekly` | per week (Monday, IST) and type: `{ weekStart, type, created, completed }` (created by creation time, completed by completion time) | `{ created, completed }` |
| `missing-updates` | per person: `missingUpdates` (ticket-days with a timer but no daily update), `tickets`, `minutes` (allocated on those ticket-days) | `{ missingUpdates, minutes }` |

## Dashboard — `GET /tickets/dashboard?company=`
Numbers for the CEO dashboard, with the same visibility as the reports (Management: every ticket).
```json
{ "company": null, "producedAt": "...", "month": "2026-11", "lastMonth": "2026-10",
  "open": 3, "overdue": 1, "completedThisMonth": 1, "completedLastMonth": 0,
  "openByType": [{ "type": { "code": "site_work", "name": "Site work" }, "count": 2 }],
  "openByPriority": [{ "priority": 1, "count": 1 }, { "priority": 3, "count": 2 }],
  "openByTypeAndPriority": [{ "type": { "code": "site_work", "name": "Site work" }, "priority": 1, "count": 1 }] }
```
Open = open, assigned, in progress or on hold. Months are IST calendar months, by completion time.
