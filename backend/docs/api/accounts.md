# Accounts API (Step 1: foundation)

For the developers of the web app and of the later Accounts steps. Base path `/api/accounts`. Conventions (sign-in, `publicId`,
error shape, resends) are in [README.md](README.md). Live schemas: `/api/docs`. Request and answer shapes are in
`shared/src/accounts.ts` (`@ageless/shared`).

Money is integer **paise** (`*Minor`), INR only. Dates are IST dates (`YYYY-MM-DD`). Every endpoint takes the company as its code
(`ATPL`, `AE`).

## Who may do what

| Role | Can |
| --- | --- |
| **Accounts maker** (executive) | read everything; draft ledger mappings; ask to reopen a month |
| **Accounts checker** (manager) | read everything; approve ledger mappings; soft close / close months; add posting rules; reverse entries; ask to reopen |
| **CEO** (Management) | read everything; approve a month's reopening |
| anyone else | `403` on every Accounts call |

Until Accounts staff exist the policy **`accounts.interim_roles`** (`{ "maker": ["hr"], "checker": ["ceo"] }`, per company or for the
group; `// DECISION`) lets HR act as maker and the CEO as checker. Permissions: `accounts.make`, `accounts.check`, `accounts.view`
(roles *Accounts executive* and *Accounts manager*).

Nobody approves their own draft or request: `403 ACCOUNTS_SELF_APPROVAL` (and the database refuses it too).

**MFA is not enforced yet**: the platform has no second factor. Both Accounts roles are meant to require it once it exists.

`GET /access?company=ATPL` answers `{ maker, checker, ceo, view }` for the caller; use it to decide which screens and buttons to show.

## Periods

One per company per month. A month nobody touched is **open**. States: `open`, `soft_closed` (still accepts entries), `closed`
(nothing can be posted: `409 ACCOUNTS_PERIOD_CLOSED`, enforced in the service and by a database trigger).

| Call | Who | Notes |
| --- | --- | --- |
| `GET /periods?company=&year=` | view | the twelve months: `state`, `closedBy`, `closedAt`, `reopenRequestedBy/At`, `reopenReason` |
| `POST /periods/soft-close` `{company,year,month}` | checker | `200`; asking again changes nothing |
| `POST /periods/close` `{company,year,month}` | checker | `200`; asking again changes nothing |
| `POST /periods/reopen-request` `{company,year,month,reason}` | maker or checker | month must be closed (`409 ACCOUNTS_PERIOD_NOT_CLOSED`) |
| `POST /periods/reopen-approve` `{company,year,month}` | CEO, not the requester | `409 ACCOUNTS_REOPEN_NOT_REQUESTED` before a request; reopens the month |

Reopening is therefore two people (the accounts side asks, the CEO approves). Every close, request and reopen is written to the audit log.

## Posting rules

Which ledgers an event debits and credits: `expense_approved`, `expense_paid`, `payroll_approved`, `salary_paid`. Versioned, never edited.
A company's newest version in force beats the group's; with nothing stored the built-in default applies (`source: "default"`, version 0).
**`// CA TO CONFIRM`**: every built-in ledger is a placeholder:

| Event | Debit | Credit |
| --- | --- | --- |
| `expense_approved` | `expense:<category>` | `staff_reimbursements_payable` |
| `expense_paid` | `staff_reimbursements_payable` | `bank` |
| `payroll_approved` | `salary_expense` | `salary_payable`, and `deduction:<label>` for each deduction |
| `salary_paid` | `salary_payable` | `bank` |

`<category>` and `<label>` are filled in when an entry is posted.

| Call | Who |
| --- | --- |
| `GET /posting-rules?company=` | view: the rule in force today for each event |
| `POST /posting-rules` `{publicId?, company?, eventType, debitLedgerKey, creditLedgerKey, deductionLedgerKey?, effectiveFrom}` | checker: a new version (company left out: the group). Same `publicId` again: `200`, nothing new. Debit and credit must differ (`400 ACCOUNTS_RULE_INVALID`) |

## Journal entries

One balanced entry per source document (`source_type` + `source_public_id`, unique per company). Append-only. A deferred
database trigger checks **debits = credits and at least two lines when the transaction commits**. Corrections are only reversals.

| Call | Who | Notes |
| --- | --- | --- |
| `GET /journal-entries?company=&from=&to=&sourceType=&ledgerKey=&page=&pageSize=` | view | newest first; `{ items, total, page, pageSize }` |
| `GET /journal-entries/:publicId` | view | lines, totals, `reversesPublicId`, `reversedByPublicId` |
| `GET /journal-entries/by-source/:sourceType/:sourcePublicId` | view | the entry written for an expense, payroll run ... (`404` if none) |
| `POST /journal-entries/:publicId/reverse` `{reason}` | checker | posts the opposite entry dated today (`201`); again: `200` with the same reversal; a reversal cannot be reversed (`409 ACCOUNTS_CANNOT_REVERSE_REVERSAL`) |

`sourceType`: `expense_approved`, `expense_paid`, `payroll_approved`, `salary_paid`, `reversal`.

Entries are not created through the API. Other modules write them through `AccountsFacade.postEntry(tx, ...)` with their own transaction
(later steps: HRMS expenses, payroll, payments). Posting a source again returns the stored entry; a closed month refuses.

## Tally ledger map

Maps each ledger key to the Tally company and ledger name. The maker drafts; a different person (checker) approves.

| Call | Who | Notes |
| --- | --- | --- |
| `GET /ledger-map?company=` | view | keys in use (by a rule or an entry) with no mapping come first as `state: "unmapped"` (`publicId: null`); then `draft` and `approved` |
| `POST /ledger-map` `{publicId?, company, ledgerKey, tallyCompany, tallyLedgerName}` | maker | `201` new; `200` if unchanged or a resend. Changing an approved mapping makes it a **draft again** until it is approved (so Tally never gets an unapproved name) |
| `POST /ledger-map/:publicId/approve` | checker | `403 ACCOUNTS_SELF_APPROVAL` on your own draft; approving an approved mapping changes nothing |

Keys with a variable part (`expense:fuel`, `deduction:advance`) appear once the first entry uses them.

## Error codes

`ACCOUNTS_PERIOD_CLOSED` (409), `ACCOUNTS_PERIOD_NOT_CLOSED` (409), `ACCOUNTS_REOPEN_NOT_REQUESTED` (409), `ACCOUNTS_SELF_APPROVAL` (403),
`ACCOUNTS_UNBALANCED` (400), `ACCOUNTS_DUPLICATE_ENTRY` (409), `ACCOUNTS_CANNOT_REVERSE_REVERSAL` (409), `ACCOUNTS_RULE_INVALID` (400),
`ACCOUNTS_DUPLICATE_ID` (409), `FORBIDDEN` (403), `NOT_FOUND` (404). A database rule hit directly reports `ACCOUNTS_APPEND_ONLY`,
`ACCOUNTS_UNBALANCED` or `ACCOUNTS_PERIOD_CLOSED` in its message.
