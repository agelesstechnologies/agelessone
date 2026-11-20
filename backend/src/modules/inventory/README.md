# inventory module

Stock for each company (ATPL first, AE as a completely separate company on the same tables). API guide:
`backend/docs/api/inventory.md`.

| Part | What | State |
| --- | --- | --- |
| Set-up | Units, item categories, items (unit conversions, copy from another company), store locations, CSV import, roles | built |
| Stock | Documents (receipt, issue, return, transfer, reversal), append-only stock moves, balances, moving average per item per company, stock events (`core.outbox`), nightly rebuild (`inventory:daily`) | built |
| Requests | Part requests from tickets, approvals by value, reservations, serial and batch rules, cross-company requesters (intercompany passed-cost lines: in the intercompany module from `stock.issued`, once merged) | built |
| Control | Counts, adjustments, reorder alerts, reports, links to projects and Accounts | |

Layout (like `tickets/` and `payroll/`): `api/` controllers · `application/` services (`CompanyAccess` decides which
companies and locations a caller reaches; `StockPosting` applies moves under locks) · `domain/` pure rules with specs
(`valuation.ts`: exact integer moving average) · `infrastructure/` repositories · `schema.ts`.

Rules kept from the start:
- Every table has `legal_entity_id`, and every link to another inventory record, a job or a ticket carries it too
  (`(x_id, legal_entity_id)` foreign keys onto `(id, legal_entity_id)`), so an ATPL record can never use an AE one.
- Scope all reaches every company; team the companies the person works in; own only the locations they look after.
- Nothing is deleted. Stock moves and document lines are never changed either (triggers); a mistake is reversed.
- Posting locks valuations (by item) and then balances (by item and location), always in that order, in one transaction
  with the moves, the event and the audit entry.
- Quantities are `numeric(18,4)` in the item's base unit; money is integer minor units with a currency; unit costs are
  `numeric(24,6)`. All arithmetic is in integers (`domain/valuation.ts`), never floating point.
- Once an item has stock moves its base unit, tracking and stocked setting no longer change; a location holding stock does
  not become inactive.
- Drizzle types a select that joins two aliases of one table, one inner and one left, as `never`: left-join both (see
  `stock-queries.repository.ts`).
