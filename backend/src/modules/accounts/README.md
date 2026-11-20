# accounts module

Writes only the `accounts` PostgreSQL schema. Other modules use it through `accounts.facade.ts`. API reference: `backend/docs/api/accounts.md`.

Built so far (Step 1, foundation): periods (open / soft closed / closed), posting rules, the append-only balanced journal,
the Tally ledger map. Next: payment requests, payment batches, the Tally bridge, bank import and reports.

```
accounts.module.ts   accounts.facade.ts   schema.ts
api/ (controller)  application/ (AccountsService)  domain/ (ledger rules, tests)  infrastructure/ (Drizzle repository)
```
