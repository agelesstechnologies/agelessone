# Intercompany API

Services one company of the group provides to another — today **ATPL** (Ageless Technologies: design, software,
IoT hardware, CGI) for **AE** (Ageless Entertainments). An **agreement** says what is covered and how it is priced;
**rate cards** give the hourly rates; **passed-on costs** are things the provider paid for the receiver; **tickets**
done for the other company's project or design request are billable to it; each month a **statement** bills the
billable ticket time and the costs — approved by the provider, reviewed by the receiver (disputes, corrections),
invoiced and closed; a **billed month** never changes again. **Reports** (CSV too) and the **CEO's cards** follow.

Base URL `http://localhost:3000/api`; every call needs `Authorization: Bearer <token>`. Request and answer shapes are
defined once in `shared/src/intercompany.ts`. Code: `backend/src/modules/intercompany`. Tables: schema `intercompany`
(migrations `0040_intercompany.sql`, `0041_intercompany_statements.sql`, `0042_intercompany_line_events.sql`). Daily job:
`intercompany:daily`. Web: `web/src/modules/intercompany/` (menu Accounts › Intercompany; the ticket page's billing box;
the CEO dashboard's cards).

**Money** is integer minor units (paise) with a `currency`, INR only for now: `rateMinor: 150000` is ₹1,500.00 an hour.

## Who may do what

| Who | May |
| --- | --- |
| The two **company heads** named on an agreement (provider's head, receiver's head) | see that agreement, its rates, billed months, passed-on costs and bill files. No permission is needed: being named is the right, as for a department head. It lasts while they hold that job (a head who leaves stops seeing it) |
| The **provider's head** | also records passed-on costs and attaches their bills |
| The **head of a ticket's department** (the provider's department head) | links the ticket to the other company's project or design request, and sets it billable or not billable (with a reason) |
| The **CEO** — `intercompany.view` / `intercompany.manage` with scope **all** (role Management in the seed) | sees everything; creates and changes agreements, adds rates, marks months billed, records costs on any agreement, sets any ticket (not) billable |
| Anyone else | an agreement does not exist for them (`404 IC_AGREEMENT_NOT_FOUND`); ticket billing answers `403 IC_NOT_DEPARTMENT_HEAD` |

Each side also names an **approver**. The receiver's approver (like its head) accepts or disputes statements; approvers
see the statements but not the agreement itself.

**Statements** are seen by the agreement's two heads and two approvers, the heads of departments with ticket time on
the statement, and the CEO. Who acts on them:

| Step | Who |
| --- | --- |
| build, rebuild, send, correct, explain, invoice, close | the provider's head, or the CEO (`IC_NOT_PREPARER`) |
| approve (provider) | a head of a department with ticket time on the statement, or the CEO — **never whoever prepared it last** (`IC_NOT_APPROVER`, `IC_SELF_APPROVAL`; also a database check) |
| accept or dispute | the receiver's head or approver (`IC_NOT_RECEIVER`) |
| margin report, dashboard cards, costs on statements | the CEO only |

Every change is written to the audit log (`core.audit_log`): `intercompany.agreement_created`, `…_changed`,
`…_activated`, `…_ended`, `intercompany.rate_added`, `intercompany.month_billed`, `intercompany.cost_added`,
`intercompany.bill_attached`, `intercompany.bill_replaced`, `intercompany.ticket_linked`,
`intercompany.ticket_not_billable`, `intercompany.ticket_billable`, `intercompany.statement_built`, `…_rebuilt`,
`…_approved`, `…_sent`, `…_accepted`, `…_disputed`, `…_accepted_automatically` (no actor), `…_invoiced`, `…_closed`,
`intercompany.line_corrected`, `intercompany.line_removed`, `intercompany.line_explained`, `intercompany.credit_added`.

## Endpoints

| Method | Path | Who | What |
| --- | --- | --- | --- |
| `GET` | `/intercompany/agreements?status=&company=` | signed in | agreements you may see, newest first |
| `POST` | `/intercompany/agreements` | `intercompany.manage` (all) | draft an agreement (*resend*) |
| `GET` | `/intercompany/agreements/{publicId}` | heads, CEO | one agreement with its rates and billed months |
| `PATCH` | `/intercompany/agreements/{publicId}` | `intercompany.manage` (all) | change terms, people, days, status |
| `GET` | `/intercompany/agreements/{publicId}/rate-cards?on=` | heads, CEO | every rate, or the rates in force on a date |
| `POST` | `/intercompany/agreements/{publicId}/rate-cards` | `intercompany.manage` (all) | add a rate (*resend*) |
| `POST` | `/intercompany/agreements/{publicId}/billed-months` | `intercompany.manage` (all) | mark a finished month billed |
| `GET` | `/intercompany/agreements/{publicId}/passed-costs?month=YYYY-MM` | heads, CEO | costs with totals counted / waiting for a bill |
| `POST` | `/intercompany/agreements/{publicId}/passed-costs` | provider's head, CEO | record a cost; multipart, optional file `bill` (*resend*) |
| `POST` | `/intercompany/passed-costs/{publicId}/bill` | provider's head, CEO | attach or replace the bill; multipart, file `bill` |
| `GET` | `/intercompany/passed-costs/{publicId}/bill` | heads, CEO | download the bill (JPEG, PNG or PDF) |
| `GET` | `/intercompany/tickets/{ticketPublicId}/billing` | department head, CEO | the ticket's billing |
| `PUT` | `/intercompany/tickets/{ticketPublicId}/link` | department head, CEO | link to the other company's project or design request |
| `POST` | `/intercompany/tickets/{ticketPublicId}/billable` | department head, CEO | billable, or not billable with a reason |
| `GET` | `/intercompany/access` | signed in | what you see of Intercompany (for the menu): `seesAll`, `manages`, `agreements` (count), `statements` (yes/no) |
| `GET` | `/intercompany/statements?agreement=&status=&year=` | see above | statements you may see, newest month first |
| `POST` | `/intercompany/agreements/{publicId}/statements` | provider's head, CEO | build a month's statement (the same month again: `200`, the stored one) |
| `GET` | `/intercompany/statements/{publicId}` | see above | one statement with its lines and their tickets |
| `POST` | `/intercompany/statements/{publicId}/rebuild` | provider's head, CEO | rebuild a draft |
| `POST` | `/intercompany/statements/{publicId}/approve` | department head with time on it, CEO; not the preparer | provider approval; the month is billed |
| `POST` | `/intercompany/statements/{publicId}/send` | provider's head, CEO | send (again) to the receiver |
| `POST` | `/intercompany/statements/{publicId}/answer` | receiver's head or approver | dispute lines; the rest is accepted |
| `POST` | `/intercompany/statement-lines/{publicId}/correct` | provider's head, CEO | reduce or remove a line (reason) |
| `POST` | `/intercompany/statement-lines/{publicId}/explain` | provider's head, CEO | keep a disputed line, saying why |
| `POST` | `/intercompany/statements/{publicId}/invoice` | provider's head, CEO | record the invoice |
| `POST` | `/intercompany/statements/{publicId}/close` | provider's head, CEO | record the payment and close |
| `GET` | `/intercompany/reports/billed` · `unbilled` · `disputes` · `receiver-cost` `?from=YYYY-MM&to=YYYY-MM&company=&format=csv` | heads, CEO | reports (rows of the agreements you see) |
| `GET` | `/intercompany/reports/balance?company=&format=csv` | heads, CEO | invoices not yet paid: due dates, days overdue, what each receiver owes |
| `GET` | `/intercompany/reports/margin?from=&to=&format=csv` | CEO | billed against cost |
| `GET` | `/intercompany/dashboard` | CEO | the CEO's cards |

*Resend*: send your own `publicId`; sending the same one again answers `200` with the stored record.

## Agreements

```json
POST /api/intercompany/agreements
{
  "publicId": "0b6c…",
  "provider": { "company": "ATPL", "headEmploymentPublicId": "…", "approverEmploymentPublicId": "…" },
  "receiver": { "company": "AE",   "headEmploymentPublicId": "…", "approverEmploymentPublicId": "…" },
  "services": ["design", "software"],
  "pricingMethod": "rate_card",
  "passedCostHandling": "at_cost",
  "startDate": "2026-04-01"
}
```

- **services**: one or more of `design`, `software`, `iot_hardware`, `cgi`.
- **pricingMethod**: `rate_card` (hours × the rate in force) or `cost_plus` with `costPlusPercent` (e.g. `12.5`; given
  with cost_plus and only then).
- **passedCostHandling**: `at_cost`, or `percent` with `passedCostPercent` (added on top of the cost).
- **reviewDays** (days the receiver has to review a monthly bill) and **paymentTermsDays**: left out, they come from the
  provider's policies on the start date — `intercompany.review_days` (5) and `intercompany.payment_terms_days` (30),
  changed with `POST /api/core/policies` like any policy.
- **Heads and approvers** are jobs (`employmentPublicId`) held now in that side's company; the database refuses a job
  of the other company (company-safe keys).
- The answer is the agreement with `provider` / `receiver` (`company`, `companyName`, `head`, `approver`), the terms,
  `status`, `rateCards` and `billedMonths`.

**Status**: `draft` → `active` → `ended` (a draft may also be ended, i.e. dropped). One **active** agreement per provider
and receiver (`409 IC_ACTIVE_AGREEMENT_EXISTS`). Ending needs `endDate` (on or after the start, and not before the last
day of a billed month). An **ended agreement never changes** (also refused by a trigger).

```json
PATCH /api/intercompany/agreements/{publicId}
{ "status": "active" }
{ "paymentTermsDays": 45, "receiverApproverEmploymentPublicId": "…" }
{ "status": "ended", "endDate": "2027-03-31" }
```

Once any month is billed, the **pricing terms** (services, pricing method, percentages) stay as they are
(`409 IC_MONTH_BILLED`): end the agreement and start a new one. The start date changes only while a draft.

## Rate cards

An hourly rate for a **service type** or a **grade** (one of the two), from a date. *CA to confirm.*

```json
POST /api/intercompany/agreements/{publicId}/rate-cards
{ "serviceType": "design", "rateMinor": 150000, "effectiveFrom": "2026-04-01" }
{ "grade": "G2", "rateMinor": 90000, "effectiveFrom": "2026-04-01" }
```

- A **new rate is a new row**; rows are never changed or deleted (trigger). One rate per item and date
  (`409 IC_RATE_EXISTS`). A service type must be one the agreement covers (`400 IC_SERVICE_NOT_COVERED`).
- **Past months keep the rate in force then**: for each date, the newest rate starting on or before it.
  `GET …/rate-cards?on=2026-05-31` answers exactly those rates (one per service type and grade).
- A new rate never reaches back into a billed month: its `effectiveFrom` must be after the last billed month
  (`409 IC_MONTH_BILLED`, also refused by a trigger).

## Billed months

A month is billed when the provider **approves its statement** (see below). `POST …/billed-months`
`{ "year": 2026, "month": 3 }` marks one billed by hand — for months billed outside the system (before go-live); a
statement is then refused for it (`409 IC_MONTH_BILLED`). Only for an active (or ended) agreement, a month inside its
dates (`400 IC_MONTH_OUTSIDE_AGREEMENT`) that is over (`409 IC_MONTH_NOT_OVER`). The same month again answers `200`.
Billed months are never changed or deleted, and **nothing in a billed month changes**: no passed-on cost dated in it,
no rate reaching back into it, no ticket billing change for a ticket with time in it, no pricing change.

## Passed-on costs

Something the provider paid for the receiver (material, transport …), billed on at cost or with `passedCostPercent`.

```
POST /api/intercompany/agreements/{publicId}/passed-costs   (multipart/form-data)
  publicId, projectPublicId (optional: the receiver's project, stored as given until projects exist),
  description, amountMinor, currency (INR), incurredOn (YYYY-MM-DD), file field `bill` (optional)
```

- **Counted only with a bill attached**: the answer has `bill` (or null) and `counted`. Attach it later with
  `POST /intercompany/passed-costs/{publicId}/bill`; attaching again replaces it (the old file is kept on disk).
- The list (`?month=2026-04`) answers `rows`, `countedMinor` (with a bill) and `waitingForBillMinor` (without).
- Only for an active (or ended) agreement and a date inside its dates (`400 IC_DATE_OUTSIDE_AGREEMENT`), never in a
  billed month. Costs are never deleted; only the bill can change (trigger).
- The bill must be a JPEG, PNG or PDF (checked from the bytes, `400 IC_BILL_TYPE`), at most 10 MB.

## Tickets billable to the other company

Kept in `intercompany.ic_ticket_billing` (one row per ticket, with a company-safe key to the ticket); the tickets module
is unchanged.

```json
PUT /api/intercompany/tickets/{ticketPublicId}/link
{ "kind": "project", "publicId": "…", "company": "AE", "serviceType": "design" }
```

`serviceType` is what the ticket's time is billed as (its rate card line). Links made before it was asked have none;
a statement with their time is refused until they are linked again (`409 IC_TICKET_NO_SERVICE`).

- **A ticket linked to the other company's project or design request is billable to that company by default**:
  `billableTo: "AE"`, `billable: true`. The project or design request id is stored as given until those registers exist.
- Linked to its own company's work: `400 IC_SAME_COMPANY` (nothing to bill). Linking again to the same company keeps
  the billable decision; linking to another company starts again as billable. The same link again changes nothing.
- **Not billable needs a reason**: `POST …/billable` `{ "billable": false, "reason": "Warranty rework" }` (without a
  reason: `400 VALIDATION`); `{ "billable": true }` makes it billable again. Audited with the reason and what it was.
- Not linked yet: `409 IC_TICKET_NOT_LINKED`. Once a month with time on the ticket (its calculated or adjusted ticket
  time) is billed under an agreement between the two companies, its billing no longer changes (`409 IC_MONTH_BILLED`).

The answer:

```json
{ "ticket": { "publicId": "…", "number": "ATPL-0012", "title": "Ride design", "company": "ATPL" },
  "link": { "kind": "project", "publicId": "…" }, "billableTo": "AE", "serviceType": "design",
  "billable": false, "notBillableReason": "Warranty rework",
  "changedBy": { "publicId": "…", "displayName": "…" }, "changedAt": "2026-11-13T05:30:00.000Z" }
```

## Monthly statements

One statement per agreement and month (`POST /intercompany/agreements/{publicId}/statements` `{ "year": 2026, "month": 10 }`).

**Built only when the provider's attendance month is locked** (`POST /api/hrms/month-locks`; otherwise
`409 IC_MONTH_NOT_LOCKED`), for an active or ended agreement and a month inside its dates. A draft is rebuilt freely
(`…/rebuild`; whoever rebuilds becomes its preparer).

**Lines**

- **labour** — one line per project (the ticket's link), service type, person, grade and rate. Hours are the month's
  **allocated ticket time plus the heads' adjustments** on the billable tickets billed to the receiver (not billable or
  unlinked tickets are left out). Each line lists **its tickets** with their minutes.
  - **rate_card**: the rate in force on each work date — a **grade** rate when the agreement has one for the person's
    designation (same spelling, any case), else the service type's. A rate change mid-month gives two lines.
    No rate in force: `409 IC_NO_RATE` (with what is missing).
  - **cost_plus**: the person's **cost per hour from payroll** — monthly salary in force ÷ policy
    `intercompany.cost.hours_per_month` (208 for now; *CA to confirm*) — plus `costPlusPercent`. No salary:
    `409 IC_NO_COST`.
  - Amount = the line's hours × rate (minor units, rounded). **Totals equal hours × rates.**
- **passed_cost** — each cost of the month **with its bill**, at cost or plus `passedCostPercent`.
- **credit** — a correction made after invoicing an earlier statement (negative), on the next statement built.

**Costs are shown to the CEO only**: `costPerHourMinor` and `costMinor` on lines and `costMinor` on the statement are
`null` for everyone else. Labour cost = hours × cost per hour (payroll); a passed-on cost costs its amount.

**States**

```
draft ──approve──▶ approved_by_provider ──send──▶ sent ──answer──▶ accepted ──invoice──▶ invoiced ──close──▶ closed
                                                    │                 ▲
                                                    └──▶ partly_disputed ──correct / explain, send──▶ sent
```

- **approve**: a head of a department with ticket time on it, or the CEO; never the preparer. The month is **billed**
  from then on (`ic_billed_months`).
- **send**: the review window starts: the receiver answers by **today + `reviewDays`** (`reviewDueOn`).
- **answer** (`{ "disputes": [{ "linePublicId": "…", "reason": "…" }] }`): the listed lines are disputed (reason
  required), every other line waiting is accepted. No dispute: **accepted**. After the review day: `409 IC_REVIEW_OVER`.
- **No answer by the review day: accepted automatically** by the daily job (`accepted.as: "automatic"`, audited with no actor):
  `pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend intercompany:daily` every morning.
- **Disputes**: the provider **corrects** each disputed line (`…/correct` with `amountMinor` lower than now, or
  `remove: true`; reason required; `originalAmountMinor` keeps the old amount) or **explains** it (`…/explain`, reason).
  Then **send again** (`409 IC_DISPUTES_OPEN` while any is unanswered): corrected and explained lines go back to the
  receiver (`pending`), removed lines stay off. The receiver answers those lines again.
- **invoice** (`{ "invoiceNumber": "AE-IC-0007", "invoicedOn": "2026-11-20" }`; unique per provider) and **close**
  (`{ "paidOn": "…", "paymentRef": "UTR …" }`).
- **Corrections after invoicing** (`…/correct` on an invoiced or closed statement) change nothing on it: the amount
  taken off becomes a **credit line on the agreement's next statement built** (`creditedMinor` on the line).

Statements are never deleted; lines change after the draft only by the receiver's answer and the provider's correction
(the amount only goes down) or explanation; a closed statement never changes (triggers, migration 0041).

**For the screens**, one statement (`GET /intercompany/statements/{publicId}`) also answers:

- `actions` — what the caller may do now: `rebuild`, `approve`, `send`, `answer`, `correct` (corrects or explains disputed
  lines; after invoicing, credits), `invoice`, `close`. The server checks every action again.
- `viewerSide` — `provider` (its head or approver, a department head with time on it: they see the **invoice**),
  `receiver` (its head or approver: they see the matching **bill**), `all` (the CEO).
- `paymentTermsDays` — the invoice is due this many days after its date.
- each line's `thread` — its dispute thread, oldest first (`disputed`, `corrected`, `removed`, `explained`, `credited`), with
  the round, reason, amount before and after, who and when. Append-only (`ic_statement_line_events`, migration 0042).

**Invoice.** "Create invoice" records the invoice number and date of an accepted statement (`…/invoice`); the invoice
document (and the receiver's matching bill) is made from the statement. When the Accounts module issues invoices, this
step should create the Accounts invoice and link it.

## Reports and the CEO's cards

`?from=YYYY-MM&to=YYYY-MM&company=AE&format=csv` (CSV with a TOTAL line, amounts in rupees). Rows come from the
agreements you see (the company heads; the CEO sees all).

| Report | What |
| --- | --- |
| `reports/billed` | billed hours and amounts: every line of statements past draft (removed lines left out) |
| `reports/unbilled` | billable ticket time (allocated + adjustments) in months not billed yet, per month, ticket and person |
| `reports/disputes` | disputed lines, the reason, and the provider's correction or explanation |
| `reports/margin` | **CEO only**: billed against cost per statement (`costMissing` when someone has no salary) |
| `reports/receiver-cost` | what the receiver pays per project: hours, labour, passed-on costs, credits |
| `reports/balance` | the intercompany balance today: each invoice not yet paid (due = invoice date + payment days, days overdue) and what each receiver owes each provider (no months: `?company=&format=csv`) |

`GET /intercompany/dashboard` (**CEO only**): `billedThisMonthMinor` (statements first sent this month, IST),
`unbilledMinutes` (billable time in months not billed), `balanceMinor` and `balances` per pair (invoiced, not yet paid).

## Error codes

| Status | Code | When |
| --- | --- | --- |
| 404 | `IC_AGREEMENT_NOT_FOUND` | no such agreement, or you may not see it |
| 409 | `IC_DUPLICATE_ID` | the publicId is used by another record |
| 400 | `IC_UNKNOWN_COMPANY` | no company with that code |
| 404 / 400 / 409 | `IC_JOB_NOT_FOUND` / `IC_JOB_OTHER_COMPANY` / `IC_JOB_NOT_CURRENT` | a head's or approver's job: unknown, in the other company, no longer held |
| 400 | `IC_COST_PLUS_PERCENT` / `IC_PASSED_COST_PERCENT` | a percentage missing, or given where it does not apply |
| 409 | `IC_AGREEMENT_ENDED` | an ended agreement does not change |
| 409 | `IC_STATUS_CHANGE` | not draft → active → ended |
| 409 | `IC_ACTIVE_AGREEMENT_EXISTS` | the two companies already have an active agreement |
| 409 | `IC_START_DATE_FIXED` | the start date moves only while a draft |
| 400 | `IC_END_BEFORE_START` | the end date is before the start |
| 409 | `IC_AGREEMENT_NOT_ACTIVE` | a draft bills nothing and takes no costs |
| 409 | `IC_MONTH_BILLED` | the change would touch a billed month |
| 400 / 409 | `IC_MONTH_OUTSIDE_AGREEMENT` / `IC_MONTH_NOT_OVER` | a month that cannot be billed |
| 409 | `IC_RATE_EXISTS` | a rate for that item from that date exists |
| 400 | `IC_SERVICE_NOT_COVERED` | a rate for a service the agreement does not cover |
| 403 | `IC_NOT_PROVIDER_HEAD` | passed-on costs are the provider's head's (or the CEO's) |
| 400 | `IC_DATE_OUTSIDE_AGREEMENT` | a cost dated outside the agreement |
| 400 / 400 | `IC_BILL_TYPE` / `IC_BILL_REQUIRED` | the bill is not a JPEG, PNG or PDF / no file sent |
| 404 | `IC_COST_NOT_FOUND` / `IC_NO_BILL` | no such cost (or not yours to see) / no bill attached yet |
| 404 | `IC_TICKET_NOT_FOUND` | no such ticket |
| 403 | `IC_NOT_DEPARTMENT_HEAD` | only the head of the ticket's department (or the CEO) |
| 400 | `IC_SAME_COMPANY` | linked to the ticket's own company's work |
| 409 | `IC_TICKET_NOT_LINKED` | link the ticket first |
| 404 | `IC_STATEMENT_NOT_FOUND` / `IC_LINE_NOT_FOUND` | no such statement or line, or you may not see it |
| 409 | `IC_MONTH_NOT_LOCKED` | the provider's attendance month is not locked |
| 409 | `IC_TICKET_NO_SERVICE` | billable tickets linked without a service type |
| 409 | `IC_NO_RATE` / `IC_NO_COST` | time with no rate in force / cost plus without a salary |
| 403 | `IC_NOT_PREPARER` / `IC_NOT_APPROVER` / `IC_SELF_APPROVAL` / `IC_NOT_RECEIVER` | not yours to do (see the table above) |
| 409 | `IC_STATEMENT_STATUS` | not possible in the statement's state |
| 409 | `IC_STATEMENT_EMPTY` | nothing to approve |
| 409 | `IC_REVIEW_OVER` | the review day has passed (accepted automatically) |
| 400 | `IC_LINE_NOT_PENDING` | only lines waiting for the answer are disputed |
| 409 | `IC_DISPUTES_OPEN` | correct, remove or explain every disputed line first |
| 409 | `IC_LINE_NOT_DISPUTED` | only a disputed line is corrected or explained (after invoicing: a credit) |
| 400 / 409 | `IC_AMOUNT_NOT_LOWER` / `IC_LINE_NOT_CORRECTABLE` / `IC_ALREADY_CREDITED` | a correction only lowers; credit lines are not corrected; nothing left to credit |
| 409 | `IC_INVOICE_NUMBER_USED` | the provider already used that invoice number |
| 403 | `IC_CEO_ONLY` | margin and dashboard |

## Tests

`src/modules/intercompany/intercompany.api.spec.ts` (only the two heads and the CEO see an agreement; policy defaults;
rate in force by date; billable default from the link; not billable needs a reason and is audited; costs count only with
a bill; billed months can't change), `src/modules/intercompany/statements.api.spec.ts` (unlocked month refused; totals
equal allocated hours × rates, adjustments included, a rate change mid-month; the preparer can't approve; the dispute
flow and a credit after invoicing; automatic acceptance after the review days; margin and costs for the CEO only;
reports and cards) and the domain specs in `src/modules/intercompany/domain/`.
