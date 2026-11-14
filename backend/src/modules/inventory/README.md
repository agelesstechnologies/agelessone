# inventory module

Stock for each company (ATPL first, AE as a completely separate company on the same tables). API guide:
`backend/docs/api/inventory.md`.

| Part | What | State |
| --- | --- | --- |
| Set-up | Units, item categories, items (unit conversions, copy from another company), store locations, CSV import, roles | built |
| Stock | Stock moves and balances, receipts, issues, returns, transfers, reversals, moving average cost, stock events | next |
| Requests | Part requests from tickets and projects, approvals by value, reservations, serial and batch tracking, cross-company requesters, intercompany charges | |
| Control | Counts, adjustments, reorder alerts, reports, links to projects and Accounts | |

Layout (like `tickets/` and `payroll/`): `api/` controllers · `application/` services (`CompanyAccess` decides which
companies a caller reaches) · `domain/` pure rules with specs · `infrastructure/` repositories · `schema.ts`.

Rules kept from the start:
- Every table has `legal_entity_id`, and every link to another inventory record or to a job carries it too
  (`(x_id, legal_entity_id)` foreign keys onto `(id, legal_entity_id)`), so an ATPL record can never use an AE unit,
  item, location or job. Stock tables and documents use the same keys.
- Scope all reaches every company; any narrower scope only the companies the person has a current job in.
- Nothing is deleted (trigger `inventory.refuse_delete`); records become inactive, conversions are ended, and changes go
  to `core.audit_log`.
- Quantities are in the item's base unit, `numeric(18,4)`, within the unit's decimals; conversions use
  `domain/quantities.ts` (exact, half up). Money is integer minor units with a currency column.
- From the stock part on: once an item has stock moves its base unit and tracking must no longer change, a non-stocked
  item takes no stock moves, and a location holding stock must not become inactive.
