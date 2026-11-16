# People API

Persons, contacts, employments (jobs), departments, designations and positions. Base URL `http://localhost:3000/api`;
every call needs `Authorization: Bearer <token>` (see `backend/README.md`, sign-in). Request shapes are defined once in
`shared/src/hrms/people.ts` and `shared/src/hrms/organisation.ts`.

**Nothing is deleted.** A contact is ended (kept as history), a job is exited (kept as history), a person becomes
inactive. Records are identified by `publicId` (uuid) only.

| Who | May |
| --- | --- |
| Employee (own) | view themselves |
| Supervisor (team) | view themselves and the people they manage; change their team's jobs (not their own) |
| HR (all) | everything below |

## Persons

### Create — `POST /hrms/people`
A person, their contacts and their first job, **in one transaction** (all saved or none). Permission `hrms.people.create` (all).
```json
{
  "displayName": "Demo Person",
  "contacts": [{ "kind": "phone", "value": "+91 00000 12345", "label": "personal" }],
  "employment": {
    "legalEntityCode": "ATPL", "departmentCode": "ATS", "engagementType": "permanent",
    "status": "joining", "recruitedOn": "2026-03-15", "joinedOn": "2026-04-01",
    "designation": "Developer", "managerPublicId": "00000000-0000-4000-8000-000000000001"
  }
}
```
| Field | Rule |
| --- | --- |
| `contacts` | up to 10; `kind` phone / email / other; at most one primary per kind (else the first of a kind is primary) |
| `employment.legalEntityCode` | `AE`, `ATPL` |
| `employment.employeeCode` | optional when `departmentCode` is given: the next code for the department's prefix is generated in the same transaction (`ATS001`, `ATS002` …). Type it when importing existing staff. Unique per company; **never changes** |
| `employment.departmentCode` | a department's code prefix in that company (`ATD`, `ATS`, `ATH`, `ATC`, `ATHR` for ATPL) |
| `employment.status` | `active` (default) or `joining` — offer accepted, not started; cannot punch, apply for leave or claim expenses until activated |
| `employment.recruitedOn`, `joinedOn` | `YYYY-MM-DD`; recruited on or before joining |
| `employment.engagementType` | permanent / probation / contract / intern / external |

Answer `201 { "publicId": "…" }`. Errors: `HRMS_EMPLOYEE_CODE_REQUIRED`, `HRMS_UNKNOWN_DEPARTMENT`, `HRMS_UNKNOWN_COMPANY`,
`HRMS_MANAGER_NOT_FOUND`, `HRMS_DUPLICATE_EMPLOYEE_CODE`. A phone number already used by someone else is fine.

### List — `GET /hrms/people?search=&company=&status=&page=&pageSize=`
`search`: name, employee code, or a current phone/email (any phone format). `status`: joining / active / notice / exited.
Each item has `primaryEmployment: { company, employeeCode, department: { code, name } | null, designation, status }`.

### View — `GET /hrms/people/:publicId`
Contacts (current first) and employments (primary first), each employment with `department { code, name }`,
`designation`, `manager`, `recruitedOn`, `joinedOn`, `exitOn`, `exitReason`, `status`, `isPrimary`, `hasOfferLetter`.
`private`: Aadhaar, PAN and salary bank accounts, **masked** (`XXXX XXXX 1234`, `XXXXXX234F`, `XXXXXXXX7890`), for HR
(`hrms.private.view`) and Management; `null` for everyone else.

### Private details — `PUT /hrms/people/:publicId/private`, `POST /hrms/people/:publicId/private/reveal`
| Call | Permission |
| --- | --- |
| `PUT …/private` `{ "aadhaar": "9999 8888 7777", "pan": "ABCDE1234F" }` (either; `null` clears) → masked | `hrms.private.manage` (HR, all) |
| `POST …/private/reveal` → the same with `masked: false` and full values | `hrms.private.reveal` (Management, all) |

Both write an audit entry (`private.updated` with the field names, `private.revealed`) — never the values.

### Edit — `PATCH /hrms/people/:publicId`
`{ "displayName": "Demo P.", "status": "inactive" }` — one or both. Permission `hrms.people.update`.

## Contacts

### Add — `POST /hrms/people/:publicId/contacts`
`{ "kind": "phone", "value": "+91 00000 99999", "label": "family", "isPrimary": true }`. The number may belong to other
people too; they stay separate people (**never merged**). `isPrimary: true` replaces the current primary of that kind.

### End — `POST /hrms/contacts/:publicId/end`
Sets `endedAt`; the contact stays in history and drops out of search and the shared list. `204`.

### Who shares a number — `GET /hrms/contacts/shared?value=%2B91 00000 99999`
For HR review (`hrms.contacts.review`, all): everyone currently using this phone/email, with their contact.

## Employments

### Add a job — `POST /hrms/people/:publicId/employments`
Same fields as `employment` above, plus `isPrimary: true` to move primary to this job. One current (joining, active or
notice) job per company per person (`HRMS_DUPLICATE_EMPLOYMENT`).

**One company at a time** — policy `hrms.people.one_company_per_person` (on by default; the version in force for the new
job's company on its joining date): while the person has a current job in another company the new job is refused with `409 HRMS_ONE_COMPANY_ONLY`
(`details.employmentPublicId`: that job). Moving company is a **transfer**: exit the current job, then add the new one.
When the person has no current job left (a transfer or a re-hire), the new job becomes **primary** (the exited job stops
being primary) and the person is **active** again, so they can sign in. People who already hold jobs in two companies
keep them until one is exited.

### Change a job — `PATCH /hrms/employments/:publicId`
Any of: `managerPublicId` (or `null`), `departmentCode` (or `null`; a **transfer keeps the employee code**),
`designation` (or `null`), `isPrimary: true` (the person's other primary is cleared in the same transaction; only an
active job). A Manager may change the jobs of people they manage, not their own.

### Activate — `POST /hrms/employments/:publicId/activate`
`joining` → `active` when the person starts. `HRMS_EMPLOYMENT_NOT_JOINING` otherwise.

### Offer letter — `POST /hrms/employments/:publicId/offer-letter`, `GET` the same path
Upload: multipart/form-data, file field `file`, PDF / JPEG / PNG (checked by content), at most 5 MB (`HRMS_FILE_TYPE`).
Download: the file itself, for the person themselves or whoever may manage their employments (`403` for anyone else).

### Exit — `POST /hrms/employments/:publicId/exit`
`{ "exitOn": "2026-06-30", "exitReason": "Moved to ATPL full time" }`. In one transaction: the job is `exited` (kept);
if it was primary, the most recently joined other active job becomes primary — **the other company's job stays
active**; if no active job is left, the person becomes `inactive` and can no longer sign in (until a new job is added).
Errors: `HRMS_EXIT_BEFORE_JOIN`, `HRMS_EMPLOYMENT_NOT_ACTIVE` (already exited).

## Departments, designations, positions

| Call | Permission |
| --- | --- |
| `GET /hrms/departments?company=` → `[{ publicId, company, name, codePrefix, head }]` | anyone signed in |
| `POST /hrms/departments` `{ "company": "ATPL", "name": "…", "codePrefix": "ATX" }` | `hrms.employments.manage` (all) |
| `PATCH /hrms/departments/:publicId` `{ "name": "…", "headPublicId": "…" \| null }` | `hrms.employments.manage` (all) |
| `GET /hrms/designations?company=` | anyone signed in |
| `GET /hrms/positions?company=&department=&status=` | `hrms.positions.manage` (all) |
| `POST /hrms/positions` `{ "company": "ATPL", "departmentCode": "ATS", "designation": "Developer", "status": "planned", "notes": "…" }` | `hrms.positions.manage` |
| `POST /hrms/positions/:publicId/status` `{ "status": "open" }` (planned ↔ open) | `hrms.positions.manage` |
| `POST /hrms/positions/:publicId/fill` `{ "employmentPublicId": "…" }` (a joining or active job in the same company) | `hrms.positions.manage` |

The department head is the approver after the job's manager (then HR, then the CEO) for leave, corrections and overtime.
Seeded for ATPL: departments Designing `ATD`, Software Development `ATS`, Hardware & IoT `ATH`, CGI Content Development
`ATC`, HR & Accounts `ATHR`; 13 designations (Designer … Accounts Executive).
