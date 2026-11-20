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
| `expense_approved` | `expense.<category>` | `payable.reimbursements` |
| `expense_paid` | `payable.reimbursements` | `bank.operating` |
| `payroll_approved` | `salary.expense` | `payable.salary`, and the `stat.*` key of each deduction |
| `salary_paid` | `payable.salary` | `bank.salary` |

`expense.<category>` is not a key: it means the `ledger_key` of the claim's expense category (`hrms.expense_categories.ledger_key`, always an
`expense.*` key). A payroll deduction posts to the key of its label, never to the label: PF `stat.pf`, ESI `stat.esi`, PT `stat.pt`, TDS `stat.tds`,
Advance `asset.staff_advance` (`DEDUCTION_LEDGER_KEYS` in `shared/src/accounts.ts`; a label not listed there cannot be posted until it is added).

### Ledger keys

Only the fixed list `LEDGER_KEYS` (`shared/src/accounts.ts`) is accepted in a posting rule, a ledger mapping, an expense category and a journal line:
`salary.expense`, `payable.salary|reimbursements|vendors`, `stat.pf|esi|pt|tds`, `asset.staff_advance`, `tax.input_cgst|sgst|igst`,
`expense.fuel|travel|food|materials|other`, `bank.salary`, `bank.operating`, `round_off`. The API answers `400 VALIDATION`; the database refuses the
same rows through `accounts.is_ledger_key()` (a test keeps the two lists equal). Adding a key = add it in `shared` and replace that function in a new migration.
Rows stored before migration 0039 may hold old keys: they are kept (the journal is append-only) but nothing new can use them.

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

## Tally company

One per legal entity: the company name in Tally and the first day of the books. The maker drafts; a different person (checker) approves.
A ledger cannot be mapped (`409 ACCOUNTS_TALLY_COMPANY_MISSING`) until the company has one.

| Call | Who | Notes |
| --- | --- | --- |
| `GET /tally-company?company=` | view | `state: "unset"` until drafted, then `draft` or `approved` |
| `POST /tally-company` `{publicId?, company, tallyCompanyName, booksFrom}` | maker | `201` new; `200` if unchanged or a resend. Changing an approved one makes it a **draft again** |
| `POST /tally-company/:publicId/approve` | checker | `403 ACCOUNTS_SELF_APPROVAL` on your own draft |

## Tally ledger map

Maps each ledger key to a Tally ledger name, in the company's Tally company (above). The maker drafts; a different person (checker) approves.

| Call | Who | Notes |
| --- | --- | --- |
| `GET /ledger-map?company=` | view | keys in use (by a rule or an entry) with no mapping come first as `state: "unmapped"` (`publicId: null`); then `draft` and `approved` |
| `POST /ledger-map` `{publicId?, company, ledgerKey, tallyLedgerName}` | maker | `201` new; `200` if unchanged or a resend. Changing an approved mapping makes it a **draft again** until it is approved (so Tally never gets an unapproved name) |
| `POST /ledger-map/:publicId/approve` | checker | `403 ACCOUNTS_SELF_APPROVAL` on your own draft; approving an approved mapping changes nothing |

Keys used by a rule or an entry appear as `unmapped` until mapped; `tallyCompany` in the answer comes from the company's Tally company.

## Tally sync (a file, no connection to Tally)

Nothing is sent to Tally. A batch is one XML file (Tally "Import Data") for one company. The journal is only read. Needs an **approved Tally company**.
Flow: the maker builds a batch, a **different** person (checker) approves it, only then can it be downloaded, the accountant imports the file in
Tally by hand and records the result. An entry Tally refused goes back to the queue with Tally's error text; it can then go into a new batch.

Entries before the Tally company's `booksFrom` are never queued. An entry whose ledger key has no **approved** Tally ledger is *blocked*: it stays in
the queue and is left out of batches (`skippedBlocked`). One entry is in one live batch at a time (database rule).

| Call | Who | Notes |
| --- | --- | --- |
| `GET /tally/queue?company=&from=&to=` | view | entries in no live batch: `ready`, or blocked (`blockedKeys`), with `lastError` when an earlier attempt failed. At most 1000 listed (`limited`) |
| `POST /tally/batches` `{publicId?, company, from, to}` | maker | builds one batch from the ready entries; `201`, or `200` for a resend of the same `publicId`. `409 ACCOUNTS_TALLY_NOTHING_TO_SEND`, `ACCOUNTS_TALLY_COMPANY_MISSING` / `_NOT_APPROVED` |
| `GET /tally/batches?company=` , `GET /tally/batches/:publicId` | view | newest first; the detail lists each entry's result |
| `POST /tally/batches/:publicId/approve` | checker | `403 ACCOUNTS_SELF_APPROVAL` for your own batch; approving again changes nothing |
| `GET /tally/batches/:publicId/download` | maker or checker | the XML file; `409 ACCOUNTS_TALLY_NOT_APPROVED` before approval. The first download is recorded |
| `POST /tally/batches/:publicId/mark-imported` `{failed?: [{entryPublicId, error}]}` | maker | needs approved **and** downloaded (`409 ACCOUNTS_TALLY_NOT_DOWNLOADED`). Failed entries return to the queue with the error; the rest are recorded as created. A resend changes nothing |
| `POST /tally/batches/:publicId/import-result` `{resultText}` | maker | Tally's own XML result. An error that names an entry's REMOTEID (the entry's `publicId`) returns that entry. `409 ACCOUNTS_TALLY_RESULT_UNCLEAR` (`details.reasons`) when it does not say which entries failed, or the counts do not add up: nothing changes, use `mark-imported` |
| `POST /tally/batches/:publicId/cancel` | maker or checker | before it is imported; its entries return to the queue |

Batch states: `built` (waiting for approval) → `approved` → `imported`, or `cancelled`. Vouchers are `Platform Journal` (accruals) and `Platform Payment`
(`expense_paid`, `salary_paid`); a reversal follows the entry it reverses. Every step is audited. Batches and their entries are never deleted.
Extra error codes: `ACCOUNTS_TALLY_BATCH_CANCELLED`, `ACCOUNTS_TALLY_BATCH_IMPORTED`, `ACCOUNTS_TALLY_UNKNOWN_ENTRY` (400), `ACCOUNTS_TALLY_ENTRY_ALREADY_BATCHED`,
`ACCOUNTS_TALLY_NOT_READY` / `_UNBALANCED` / `_BAD_ENTRY` (the file could not be built).

## Tally connector (the program on the Tally server PC)

Instead of a person downloading the file, the connector in `connector/` posts approved batches to Tally on its own PC. It is **not a person**:
it signs in with a **machine credential** and can use only the three routes below (every other route answers `403 FORBIDDEN` to it, and
these routes answer `403` to people). It only ever calls out; the API never connects to Tally.

| Call | Notes |
| --- | --- |
| `POST /api/core/machine-credentials {name}` | admin (`core.users.manage`, scope all). Answers `clientId` and `secret` **once**; only a bcrypt hash is kept. `GET` lists them, `POST /:publicId/revoke` stops one at once |
| `POST /api/auth/machine-token {clientId, secret}` | public. A 15-minute token. Same `401 AUTH_FAILED` for unknown client, wrong secret and revoked; failures are throttled (`429 AUTH_LOCKED`) like person sign-ins |
| `GET /tally/outbox` | `accounts.tally.connector`. Up to 5 approved batches that are not imported and **not on hold**: `{publicId, company, tallyCompanyName, xml, entries, expectedLedgers, expectedCostCentres}`. Handing a batch out counts as its first download. `expectedCostCentres` is empty until cost centres exist |
| `POST /tally/results {batchPublicId, outcome, created, altered, errors, lastVchId, lineErrors, message}` | `outcome`: `completed` (Tally answered), `not_posted` (nothing reached Tally; stays in the outbox), `in_doubt` (put on hold). A `completed` result that names failed entries (their REMOTEID in a `lineErrors` text) returns them to the queue; one that does not say which entries failed puts the batch **on hold** (`onHold: true`, answered `200`) for a person. Safe to send again |
| `POST /tally/mapping-report {tallyCompanyName, ledgersChecked, costCentresChecked, missingLedgers, missingCostCentres}` | names the ledger map expects that Tally does not have exactly. Kept on the Tally company (`connectorCheckedAt`, `connectorMissing`); audited when the answer changes |

A batch the connector finished shows `importedByConnector: true` (no person). **On hold** means the connector will not post it again: a person checks
Tally, then uses `mark-imported` / `import-result` (which clear the hold) or `cancel`. The connector's work is audited with no person and the machine's name.

## Error codes

`ACCOUNTS_PERIOD_CLOSED` (409), `ACCOUNTS_PERIOD_NOT_CLOSED` (409), `ACCOUNTS_REOPEN_NOT_REQUESTED` (409), `ACCOUNTS_SELF_APPROVAL` (403),
`ACCOUNTS_UNBALANCED` (400), `ACCOUNTS_DUPLICATE_ENTRY` (409), `ACCOUNTS_CANNOT_REVERSE_REVERSAL` (409), `ACCOUNTS_RULE_INVALID` (400),
`ACCOUNTS_DUPLICATE_ID` (409), `ACCOUNTS_TALLY_COMPANY_MISSING` (409), `FORBIDDEN` (403), `NOT_FOUND` (404). A database rule hit directly reports `ACCOUNTS_APPEND_ONLY`,
`ACCOUNTS_UNBALANCED` or `ACCOUNTS_PERIOD_CLOSED` in its message.
