# Ageless Platform

One repository for every Ageless module: one NestJS backend (`apps/api`), one React web app (`apps/web`),
and shared contracts (`packages/core-contracts`). Web only for now: there is no mobile app.

## Start on your PC (no Docker)
1. Install **Node.js 22**, **pnpm 9** (`npm i -g pnpm`), **Git**.
2. Choose where your development database lives:
   - **Your own PC:** install **PostgreSQL 16** (postgresql.org; Postgres.app on Mac), then run `docs/setup/local-pc.sql` once as the `postgres` user.
   - **The office database machine:** ask the lead for your own database (`dev_<name>`), created with `docs/setup/office-server.sql`.
3. `git clone <repo> && cd ageless-platform`
4. `cp apps/api/.env.example apps/api/.env` and set `DATABASE_URL` to your database
   (local: `postgres://ageless:ageless_dev@localhost:5432/ageless_dev`, office: `postgres://dev_anu:<password>@192.168.1.50:5432/dev_anu`).
5. `pnpm install`, then `pnpm db:migrate`
6. `pnpm --filter @ageless/api dev` → API on http://localhost:3000/api/hrms/attendance/health

Every day: `git pull` → `pnpm install` → `pnpm db:migrate`.
Start your database again from empty: `pnpm db:reset` (only works on development databases named `dev_*` or `ageless_dev`).

## Where things live
```
apps/api/src/
  platform/              shared plumbing: database pool, auth guard, outbox, jobs
  modules/
    core/                shared foundation (people, organisation, approvals, files, policies)
    tickets/             ticket engine and service tickets
    hrms/                HR module
      schema.ts          the 'hrms' PostgreSQL schema
      hrms.module.ts     registers the six sub-modules
      hrms.facade.ts     the ONLY entry point for other modules
      people/            employment, job history, private details, bank, documents
      skills/            skills, certificates, training
      attendance/        punches, work days, corrections, overtime
      leave/             leave types, requests, ledger, holidays
      expenses/          categories, claims, approvals, paid
      reports/           read-only reports and CSV
    sales/ operations/ inventory/ workshop/ ...   later modules (README only for now)
apps/api/drizzle/        ONE ordered list of migrations for the whole database
packages/core-contracts/ event types, facade interfaces, Zod request shapes (shared with web)
docs/reference/          reference SQL with every table and database rule
```

Each sub-module has the same four folders:
`api/` (controllers) · `application/` (use cases) · `domain/` (pure rules + tests) · `infrastructure/` (repositories) · `schema.ts` (its tables).

## Who owns what (edit `.github/CODEOWNERS` with real usernames)
| Area | Owner |
| --- | --- |
| core, platform, migrations folder | Lead developer (database steward) |
| tickets | Backend 2 |
| hrms/attendance, hrms/people | Backend 3 |
| hrms/leave, hrms/expenses | HR colleague B |
| hrms/skills, hrms/reports | HR colleague A |

## How we work
- Short-lived branches: `feature/hrms-leave-apply`, merged within 1–3 days.
- Every pull request: one owner review + passing CI (typecheck, boundaries, tests, migrations, build).
- Change a table: edit your `schema.ts` → `pnpm db:generate -- --name what_changed` → `pnpm db:migrate`
  → commit schema and `drizzle/` files together. If `drizzle/` conflicts: delete your new migration, pull main, generate again.
- Triggers, views, row-level security: `pnpm --filter @ageless/api exec drizzle-kit generate --custom --name ...`
- Never edit a merged migration. Never change a database by hand.

## Boundary rules (checked by `pnpm boundaries`)
1. A module uses another module only through its `*.facade.ts` (calls) or `schema.ts` (foreign keys).
2. Inside HRMS, a sub-module uses another only through its `application/*.service.ts` or `schema.ts`.
3. `domain/` code never imports NestJS, Drizzle, the database, controllers or repositories.

## Adding a new module (for example Sales)
Copy the HRMS layout: `modules/sales/schema.ts`, `sales.module.ts`, `sales.facade.ts`, sub-modules,
register it in `app.module.ts`, add `'sales'` to `schemaFilter` in `drizzle.config.ts`, add owners to CODEOWNERS.
