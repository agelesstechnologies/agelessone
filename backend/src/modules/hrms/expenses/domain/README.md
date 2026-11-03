# Expenses domain

Pure business rules for hrms/expenses: no database, no HTTP. Unit-tested.

- `claims.ts` — receipt type from the file's first bytes; which step a claim may take next; the approved amount.
- `permissions.ts` — the permission codes the endpoints use.
