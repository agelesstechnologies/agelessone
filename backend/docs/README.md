# Ageless platform — documentation

Written for developers and whoever runs the servers. State as of 2026-11-06: Module 1 (HRMS, payroll) and the ticket
engine (types, tickets, ticket time, reports). Start with the project rules in the root `CLAUDE.md` and setup in the root
`README.md`.

| Document | What it covers |
| --- | --- |
| [api/README.md](api/README.md) | **API reference**: conventions, all endpoints with who may call them, request fields, answers, every request/answer schema, every error code. Generated from the running app. |
| [api/people.md](api/people.md) | Guide: persons, contacts, jobs, departments, designations, positions |
| [api/tickets.md](api/tickets.md) | Guide: ticket types, tickets, ticket time, confirmations and addresses, reports, dashboard |
| [security.md](security.md) | **Security**: sign-in and tokens, permissions and scopes, the roles matrix, tenant and company separation, self-approval rules, records that cannot change, sensitive data, files, logs, audit, settings, known gaps |
| [database/schemas.md](database/schemas.md) | **Database schemas**: every schema and table with its columns, keys, checks, indexes and triggers. Generated from the migrated database. |
| [database/connections.md](database/connections.md) | **Database connections**: diagrams, links between modules, company-safe keys, every foreign key, what points to what, connections that are not foreign keys, triggers |
| [reference/ageless_core_tickets_hrms.sql](reference/ageless_core_tickets_hrms.sql) | The original full reference design (all planned tables); the built tables are in `drizzle/` and `database/schemas.md` |
| [setup/](setup/) | SQL to create the databases on a PC or the office server |

Live API docs while the backend runs: `http://localhost:3000/api/docs` (Swagger UI) and `/api/docs.json`.

**Keeping them current.** `api/README.md` and the two `database/` pages are snapshots generated from the app's OpenAPI
document and the database catalog; regenerate them after endpoints or migrations change. `security.md`, `people.md` and
`tickets.md` are written by hand and updated with each change.
