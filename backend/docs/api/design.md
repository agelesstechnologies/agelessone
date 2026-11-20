# Design API

Design work of **Ageless Technologies (ATPL)**. A **design job** is received from a client (a customer of the Core
customer list; **AE is one**). **Tickets** of ATPL carry the work and its time. Each job has **drawings**, and each
drawing has **revisions** with their files (the PDF, CAD source files, the bill of materials). A submitted revision goes
to **QC**. QC-approved revisions are issued to the client in **transmittals**, which come with a PDF cover sheet and a
zip of the drawings. ATPL records the **client's response** on each issued revision. **Reports** (CSV too) follow.

There is no AE project register. A job only keeps the client's own reference as text (`clientProjectReference`, e.g.
"AE PRJ-014 Hungama Dome") and reserves `clientProjectPublicId` for linking AE's project later. It is always null for now.

Base URL `http://localhost:3000/api`; every call needs `Authorization: Bearer <token>`. Request and answer shapes are
defined once in `shared/src/design.ts` (customers: `shared/src/core/customers.ts`). Code: `backend/src/modules/design`
(customers: `backend/src/modules/core/customers`). Tables: schema `design` plus `core.customers`, migration
`0055_design.sql`. Web: `web/src/modules/design/` (menu Operations › Design: jobs, drawing register, QC, transmittals,
reports).

## Who may do what

| Who | May |
| --- | --- |
| The **Designing head**: the head of the job's department (the department whose code prefix is in policy `design.department_prefix`, default `ATD`) | everything on the company's design jobs. No permission is needed: being the department head is the right |
| **Admin user** (`design.jobs.manage`) | the same as the Designing head: create and run jobs, link tickets, attachments, drawings, transmittals, client responses |
| People **assigned to the job's tickets** | see the job; draw: add drawings and revisions, attach files, submit |
| **Design QC** (`design.qc`, new role `design_qc`) | see every job; decide QC. Never on a revision they drew, created or submitted, nor on a job whose tickets they are or were assigned to |
| `design.view` (Management, Design QC, Admin user) | see every design job, drawing, transmittal and the reports |
| Anyone else | design records do not exist for them (404). Reports answer 403 |

A permission held with scope **all** counts in every company. With scope own or team, it counts in the companies where
the person holds a current job. A company without the Designing department takes no design jobs (`409
DESIGN_NOT_ENABLED`; AE has none). That keeps the module to ATPL without naming ATPL anywhere in the code.

**Customers** (`/core/customers`): anyone signed in reads the list. `core.customers.manage` with scope all adds and changes
customers (System admin, Admin user, Management). The group companies are customers linked to their company, added by
the migration and by the seed.

Every change is written to the audit log (`core.audit_log`): `core.customer_added`, `core.customer_changed`,
`design.job_created`, `…_changed`, `design.job_status`, `design.attachment_added`, `design.ticket_linked`,
`design.drawing_created`, `design.drawing_changed`, `design.revision_created`, `design.revision_changed`,
`design.file_added`, `design.file_removed`, `design.revision_submitted`, `design.qc_approved`, `design.qc_changes_needed`,
`design.transmittal_issued`, `design.client_accepted`, `design.client_returned`, and `intercompany.ticket_linked` for an AE
job's tickets. The client contact's phone or email is never written to the log.

## Endpoints

*resend*: the create takes an optional `publicId`; the same request again answers 200 with the stored record.

| Method | Path | Who | What |
| --- | --- | --- | --- |
| `GET` | `/core/customers?q=&status=` | signed in | the customer list (`company`: the group company a customer is, or null) |
| `POST` | `/core/customers` | `core.customers.manage` (all) | add a customer: `code`, `name`, optional `company` (*resend*) |
| `PATCH` | `/core/customers/{publicId}` | `core.customers.manage` (all) | name, or `status` active / inactive (code and company never change) |
| `GET` | `/design/access` | signed in | per company: `enabled` (has the Designing department), `manage`, `qc`, `view`; and `assignedJobs` (for the menu and buttons) |
| `GET` | `/design/jobs?company=&status=&customer=&q=` | signed in | the jobs you may see, newest first |
| `POST` | `/design/jobs` | Designing head, Admin user | receive a job: company, customer, client project reference, site, scope, requirements, due date, received from (name, contact) (*resend*) |
| `GET` | `/design/jobs/{publicId}` | who sees it | the job with attachments, tickets (with their `minutes`), the job's `minutes` (ticket time so far), drawings (current revision), transmittals, and `actions` (manage, draw, qc) |
| `PATCH` | `/design/jobs/{publicId}` | Designing head, Admin user | details, while the job is open (the client never changes) |
| `POST` | `/design/jobs/{publicId}/status` | Designing head, Admin user | `{ status, reason? }`: see *Job statuses* |
| `POST` | `/design/jobs/{publicId}/attachments` | Designing head, Admin user | multipart: file `file`, `description` (*resend*) |
| `GET` | `/design/job-attachments/{publicId}/file` | who sees the job | download |
| `POST` | `/design/jobs/{publicId}/tickets` | Designing head, Admin user | `{ ticketPublicId, serviceType? }`: the ticket works on this job |
| `POST` | `/design/jobs/{publicId}/drawings` | the job's people | `{ discipline, title }` (*resend*) |
| `GET` | `/design/drawings/{publicId}` | who sees the job | the drawing with every revision (oldest first) |
| `PATCH` | `/design/drawings/{publicId}` | the job's people | the title, until a revision is submitted |
| `POST` | `/design/drawings/{publicId}/revisions` | the job's people | `{ stage, changeNote, title?, clientProjectReference?, scale?, sheet?, drawnByPublicId? }`: the next revision, as a draft (*resend*) |
| `GET` | `/design/revisions/{publicId}` | who sees the job | the revision: title block, files, QC, transmittal, client response |
| `PATCH` | `/design/revisions/{publicId}` | the job's people | change a **draft** |
| `POST` | `/design/revisions/{publicId}/files` | the job's people | multipart: `kind` (`pdf`, `source`, `bom`) and file `file`, on a draft (*resend*) |
| `POST` | `/design/revision-files/{publicId}/remove` | the job's people | take a file off a draft (kept as history) |
| `GET` | `/design/revision-files/{publicId}/file` | who sees the job | download |
| `POST` | `/design/revisions/{publicId}/submit` | the job's people | submit for QC (the PDF must be attached) |
| `GET` | `/design/qc/checklist?company=` | who sees the company's design work | the checklist in force (policy `design.qc_checklist`) |
| `POST` | `/design/revisions/{publicId}/qc` | Design QC | `{ decision, comments?, checklist: [{ item, passed, note? }] }`; multipart with up to 5 mark-ups in `files` (checklist as a JSON string) (*resend*) |
| `GET` | `/design/qc-files/{publicId}/file` | who sees the job | download a mark-up |
| `POST` | `/design/jobs/{publicId}/transmittals` | Designing head, Admin user | `{ purpose, revisionPublicIds, recipient?, note? }`: issue (*resend*) |
| `GET` | `/design/transmittals?company=&job=` | signed in | transmittals you may see, newest first |
| `GET` | `/design/transmittals/{publicId}` | who sees the job | the transmittal with the revisions it issued |
| `GET` | `/design/transmittals/{publicId}/cover-sheet` | who sees the job | PDF cover sheet |
| `GET` | `/design/transmittals/{publicId}/zip` | who sees the job | zip: cover sheet + each issued revision's PDF |
| `POST` | `/design/revisions/{publicId}/response` | Designing head, Admin user | `{ response, comments?, respondedOn, responderName }`: accepted or returned (*resend*) |
| `GET` | `/design/reports/drawings?company=&job=&status=&discipline=` | who sees the company's design work | drawings by job and current status |
| `GET` | `/design/reports/qc-queue?company=` | 〃 | revisions waiting for QC, with days waiting |
| `GET` | `/design/reports/awaiting-response?company=` | 〃 | issued revisions with no client response, with days waiting |
| `GET` | `/design/reports/qc-by-discipline?company=&from=&to=` | 〃 | QC decisions (IST dates) per discipline: approved, changes needed, pass % |
| `GET` | `/design/reports/hours?company=&from=&to=&job=` | 〃 | hours per job from ticket time (allocations plus the heads' adjustments) |

Every report takes `format=csv` for a download (UTF-8, opens in Excel). Downloads are sent as attachments with
`X-Content-Type-Options: nosniff`, never shown inline. Every route is in the live docs at `/api/docs`.

## Design jobs

- **Number**: `DJ-025`, a series per company. Prefix and digits come from policy `design.numbering` (`jobPrefix` `DJ`,
  `jobDigits` 3). The counter is taken atomically, so two jobs never get the same number.
- **Job statuses**: `received → accepted → in_design → closed`, one step at a time. `on_hold` needs a reason and is
  allowed from any open status. It remembers where the job was (`resumeStatus` in the answer), and the job goes back only to that
  status. `cancelled` needs a reason and is allowed from any open status. A **closed or cancelled job no longer
  changes**: no edits, drawings, revisions, files, ticket links or transmittals (`409 DESIGN_JOB_CLOSED`). The same
  status sent again changes nothing. Wrong moves: `409 DESIGN_BAD_STATUS_CHANGE`.
- **Tickets**: a ticket of the job's company works on one job, once. It never moves to another job
  (`DESIGN_TICKET_ON_OTHER_JOB`). Its time is the job's time.

### Tickets for AE are billable to AE

When the job's client is a customer linked to **another company of the group** (AE), linking a ticket also links it in
Intercompany as that company's **design request**. The design job's `publicId` is the design request id, and
`serviceType` is `design` unless the request names another. This goes through `IntercompanyFacade.linkTicketToWork`, in
the same transaction, and is the existing intercompany rule: the ticket is billable to AE by default, the head of the
ticket's department may still set it not billable (with a reason), and nothing changes in a billed month
(`IC_MONTH_BILLED`). The ticket's time then appears on the monthly ATPL → AE statement. A job whose client is an outside
customer or ATPL itself bills nothing.

## Drawings and revisions

- **Drawing number**: `<job number>-<discipline>-<seq>`, e.g. `DJ-025-MEC-001`; `seq` counts per job and discipline
  (3 digits). Disciplines come from policy `design.disciplines` (default `MEC ELE IOT SW CGI ARC`). Others answer
  `400 DESIGN_UNKNOWN_DISCIPLINE`.
- **Revision codes**: the designer picks the stage when starting a revision. `preliminary` gets the next letter
  (A, B … Z, AA … ZZ). `construction` gets the next number (0, 1, 2 …). No letters once a construction revision exists
  (`409 DESIGN_REVISION_CODE`). The code is fixed at creation, so it never changes after submission.
- **Title block**: client project reference (default: the job's), drawn by (default: the caller; any person with a job in
  the company), scale, sheet, and the revision's own title (default: the drawing's).
- **One revision at a time**: a new revision is refused while another revision of the drawing is a draft or submitted
  (`409 DESIGN_REVISION_OPEN`; also a unique index).
- **Revision statuses**: `draft → submitted → qc_approved | changes_needed`. Then `qc_approved → issued → accepted |
  returned`. An issued, accepted or returned revision, or an approved one never issued, becomes `superseded` when a
  later revision of its drawing is issued.
- **Submitted revisions are immutable.** Submitting needs the PDF (`409 DESIGN_PDF_REQUIRED`). From then on its content
  and files never change (`409 DESIGN_REVISION_LOCKED`). The database enforces this too: triggers refuse changing a
  submitted revision, adding or removing its files, moving a status backwards, and deleting any revision or file.
- **Files**: the **PDF** (one per revision; a new upload replaces the draft's PDF), **source** files (DWG, DXF, STEP/STP,
  IGES, SolidWorks, Inventor, SketchUp, Rhino, Fusion 360, ZIP) and the **BOM** (CSV, XLSX or PDF). Types are told from
  the bytes; the uploaded name only picks between formats that share a container (XLSX vs ZIP). Programs and scripts are
  always refused. The size limit is policy `design.max_file_mb` (default 50 MB, at most 100). Files are stored under a
  random name and given a server-made name such as `DJ-025-MEC-001_B.pdf` or `DJ-025-MEC-001_B_source-2.dwg`; the
  uploaded name is never stored.

## QC

- The checklist is policy `design.qc_checklist`. Every item must be answered exactly once (matching ignores case and
  spacing) with `passed` and an optional `note`. The decision **approved** needs every item passed; **changes_needed**
  needs comments (`400 DESIGN_CHECKLIST` / `VALIDATION`). Mark-ups are PDF, JPEG or PNG, up to 5.
- **Independence**: the reviewer is never the revision's author (who drew, created or submitted it), nor anyone who is or
  was assigned to a ticket of the job (`403 DESIGN_QC_NOT_INDEPENDENT`). A **database trigger** on `design.qc_reviews`
  checks the same, so even a direct insert is refused.
- One decision per revision, never changed. After changes needed, the designer starts the next revision.

## Transmittals

- Issue one or more revisions of **one job**, at most one per drawing. Only **QC-approved** revisions can be issued
  (`409 DESIGN_NOT_QC_APPROVED`), and never one older than a revision already issued (`DESIGN_NEWER_ISSUED`). Purpose
  `for_approval`, `for_construction` (construction revisions only: `DESIGN_NOT_CONSTRUCTION`) or `for_information`.
- Number per company: `TR-0001` (policy `design.numbering`: `transmittalPrefix`, `transmittalDigits`).
- Issuing marks the revisions `issued` and **supersedes** each drawing's earlier issued, accepted, returned (or
  approved, never issued) revisions.
- The **cover sheet** PDF and the **zip** are made from the stored rows whenever asked for, so they always list exactly the
  revisions the transmittal issued. The zip holds `TR-0001_cover.pdf` and each revision's PDF under its stored name.
- **Client response** (recorded by ATPL) on an issued revision: `accepted`, or `returned` with comments, plus the date
  (not in the future, not before the issue) and the responder's name. Once per revision. A returned drawing needs its
  next revision.

## Policies (company settings; defaults until changed)

| Key | Default | What |
| --- | --- | --- |
| `design.department_prefix` | `ATD` | the Designing department; its head runs design jobs; a company without it takes none |
| `design.disciplines` | `MEC ELE IOT SW CGI ARC` | drawing disciplines |
| `design.qc_checklist` | 5 items (title block, dimensions/scale, requirements, BOM, revision note) | what QC checks |
| `design.numbering` | `DJ` / 3 digits, `TR` / 4 digits | job and transmittal numbers |
| `design.max_file_mb` | 50 | largest file (at most 100) |

## Web screens (`web/src/modules/design/`)

- **Jobs**: the list (client, reference, status, due, drawings) as cards on a phone; New job; the job page with scope,
  status actions (accept, start, close, hold, resume, cancel), attachments, linked tickets with their hours, drawings by
  discipline, transmittals, and the job's hours.
- **Drawing register** (`design.view`): every drawing by job and discipline with its current revision; the drawing page
  shows the revision history (files, QC, transmittal, client response). **New revision** takes the change note, title
  block and files (PDF, source files, BOM) in one go, then saves a draft or submits. A draft takes more files and is
  submitted after a confirmation.
- **QC** (`design.qc`): the queue, oldest first. The review screen is **desktop first**: the PDF (fetched with the token
  and shown through an object URL) sits beside the checklist (pass or fail per item, a note when failed), comments and
  mark-ups. Approve needs every item passed; changes needed needs comments. On a phone the PDF stacks above the checklist
  and opens in a new tab.
- **Transmittals**: issue from the job (pick QC-approved current revisions; for construction offers construction
  revisions only; purpose, recipient, note); the transmittal page downloads the cover sheet and the zip and records the
  client's response per revision.
- **Reports**: the five reports with CSV.
- Reads go through `useApi` (the shared cache); every change calls `invalidate('/design')`, so lists and pages refresh.

## Not yet

- No alerts (for example to Design QC when a revision is submitted).
- The issue form offers each drawing's **current** revision when it is QC-approved. An approved revision with a newer
  draft started on top of it is not offered.
- No AE project register: `clientProjectPublicId` is reserved.
- Zips are built in memory: a transmittal of up to 100 revisions with PDFs of normal size is fine, while very large
  drawing sets would need a streamed zip.
