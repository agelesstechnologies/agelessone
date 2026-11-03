# CLAUDE.md — Ageless platform

Guidance for Claude Code in this repository. Read before making changes.

## What this project is
One platform for the Ageless group (attractions business, parks, technologies), built module by module.
**Now: Module 1 = HRMS** (people, attendance, leave, expenses), then service tickets. Later: Sales, Operations,
Inventory, Workshop, Site Installation, Service and AMC, Accounts, Parks, Hub and AI.
It replaces the **Froid** app, so screens and flows must stay familiar to staff
(daily punch in/out, Work Hours History, leave requests, expense tracking).

## Stack
- pnpm workspaces + Turborepo; Node.js 22; TypeScript (strict)
- Backend: NestJS 10 in `apps/api`; PostgreSQL 16; Drizzle ORM + drizzle-kit migrations
- Shared types and Zod shapes: `packages/core-contracts` (used by api and web)
- Web app: `apps/web` (React, not created yet). Web only for now: no mobile app.
- Tests: Vitest. No Docker: each developer has their own PostgreSQL database (own PC, or `dev_<name>` on the office server).

## Commands (run from the repository root)
- `pnpm install` — install everything
- `pnpm --filter @ageless/api dev` — start the API on http://localhost:3000/api
- `pnpm typecheck`, `pnpm test`, `pnpm build`
- `pnpm boundaries` — check module boundary rules
- `pnpm db:generate -- --name <what_changed>` — create a migration from schema changes
- `pnpm db:migrate` — apply pending migrations to the database in `apps/api/.env`
- `pnpm db:reset` — empty a development database and rebuild it (refuses non-dev databases)

## Structure
```
apps/api/src/
  platform/db/                 one shared database pool (inject DB)
  modules/
    core/                      shared foundation: persons, organisation, approvals, files, policies (core.facade.ts)
    tickets/                   ticket engine and service tickets
    hrms/
      schema.ts                the 'hrms' PostgreSQL schema
      hrms.module.ts           registers the sub-modules
      hrms.facade.ts           the ONLY entry point for other modules
      people/ skills/ attendance/ leave/ expenses/ reports/
    sales/ operations/ ...     later modules (README only)
apps/api/drizzle/              migrations for the whole database, committed, applied in order
packages/core-contracts/       events, facade interfaces, Zod request shapes
docs/reference/                full reference SQL (all planned tables and rules)
docs/setup/                    database setup SQL (local PC, office server)
```
Each sub-module: `api/` (controllers) · `application/` (services, use cases) · `domain/` (pure rules + `.spec.ts` tests)
· `infrastructure/` (Drizzle repositories) · `schema.ts` (its tables) · `<name>.module.ts`.

## Rules (always follow)
1. **Database changes only through migrations**: edit a `schema.ts`, run `pnpm db:generate`, then `pnpm db:migrate`;
   commit the schema and the new `drizzle/` files together. Never change a database by hand.
2. **Never edit or delete a merged migration.** Add a new one to fix it.
3. **Module boundaries** (checked by `pnpm boundaries`):
   - another module is used only through its `*.facade.ts` (calls) or `schema.ts` (foreign keys);
   - inside HRMS, a sub-module uses another only through its `application/*.service.ts` or `schema.ts`;
   - `domain/` never imports NestJS, Drizzle, `pg`, controllers or repositories.
4. A module writes only its own PostgreSQL schema (`hrms` → `hrms.*`).
5. Every table has `tenant_id`; records in APIs use `public_id` (uuid), never internal `id`.
6. Money is integer **paise** (`bigint`). Times are `timestamptz` in UTC; work dates in IST (`Asia/Kolkata`).
7. **Punches (`attendance_events`) are append-only.** Corrections add rows; the work day is recalculated.
8. A request sent twice (double click, retry on a bad connection; same `public_id`) is stored once; return the existing record.
9. Nobody approves their own request (leave, expense, correction, reassignment).
10. Company policies (shifts, grace, leave entitlement, overtime, expense limits) are **not final**: read them through
    `CoreFacade.getPolicy(...)` with a default; never hard-code them.
11. Keep it simple: no new frameworks, packages or layers without asking.

## Coding style
- Controllers: validate with Zod, check permission, call one service method. No business logic.
- Services: transactions, repositories, other modules' facades, outbox events.
- Names: tables plural snake_case; TypeScript camelCase; routes `/api/<module>/<sub-module>/...`.
- Never log phone numbers, bank or ID numbers, or exact locations. Never put real staff data in seeds or tests.

## Before finishing a task
- `pnpm typecheck`, `pnpm test`, `pnpm boundaries` and `pnpm build` pass.
- If a schema changed: a new migration exists and `pnpm db:migrate` applies cleanly to a fresh database.

## Domain words
- **Daily punch**: punch in/out for the day. **Ticket punch**: time logged on a service ticket.
- **Work day**: one calculated row per person per date (present, half_day, absent, missed_punch, leave, holiday).
- **Correction**: request to fix a missed or wrong punch, approved by the supervisor.
- **Supervisor**: approves the team's leave, expenses, corrections and ticket reassignments.
- **Admin user**: creates service tickets and assigns employees.
