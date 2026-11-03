# CLAUDE.md — Ageless

Guidance for Claude Code in this repository. Read this first; `backend/CLAUDE.md` and `web/CLAUDE.md` add the details
for each app.

## What this project is
One platform for the Ageless group (attractions business, parks, technologies), built module by module.
**Now: Module 1 = HRMS** (people, attendance, leave, expenses), then service tickets. Later: Sales, Operations,
Inventory, Workshop, Site Installation, Service and AMC, Accounts, Parks, Hub and AI.
It replaces the **Froid** app, so screens and flows must stay familiar to staff
(daily punch in/out, Work Hours History, leave requests, expense tracking).

## What's where
```
ageless/
  CLAUDE.md        this file: layout, commands, rules for every app
  README.md        setup for a new PC
  package.json     pnpm workspaces + Turborepo: backend, shared, web (mobile added later)
  backend/         NestJS API and the PostgreSQL database (migrations, seed, docs)   → backend/CLAUDE.md
  shared/          Zod request shapes and response types used by backend and web (@ageless/shared)
  web/             admin panel, React + Vite (not created yet)                     → web/CLAUDE.md
  mobile/          placeholder for the field app, built later
  .github/         CI workflow and CODEOWNERS
```

## Stack
- pnpm workspaces + Turborepo; Node.js 22; TypeScript (strict); Vitest.
- backend: NestJS 10, PostgreSQL 16, Drizzle ORM + drizzle-kit migrations.
- web: React + Vite (planned). Web only for now; the mobile field app comes later.
- No Docker: each developer has their own PostgreSQL database (own PC, or `dev_<name>` on the office server).

## Commands (run from the repository root)
- `pnpm install` — install everything
- `pnpm --filter @ageless/backend dev` — start the API on http://localhost:3000/api
- `pnpm typecheck`, `pnpm test`, `pnpm build` — every app
- `pnpm boundaries` — check the backend's module boundary rules
- `pnpm db:generate -- --name <what_changed>`, `pnpm db:migrate`, `pnpm db:reset`, `pnpm db:seed` — see `backend/CLAUDE.md`
  (in PowerShell quote the separator: `npm run db:generate '--' --name <what_changed>`)

## Rules for every app
1. Records are identified by `public_id` (uuid) in APIs, URLs and the web app, never by the internal `id`.
2. Request shapes are defined once in `shared/` (Zod) and used by both backend and web: change them there.
3. Money is integer **paise**. Times are UTC (`timestamptz`); work dates are in IST (`Asia/Kolkata`).
4. A request sent twice (double click, retry on a bad connection; same `public_id`) is stored once; return the existing record.
5. Nobody approves their own request (leave, expense, correction, reassignment).
6. Company policies (shifts, grace, leave entitlement, overtime, expense limits) are **not final**: the backend reads them
   through `CoreFacade.getPolicy(...)` with a default; nothing hard-codes them.
7. Never log phone numbers, bank or ID numbers, or exact locations. Never put real staff data in seeds or tests.
8. Keep it simple: no new frameworks, packages or layers without asking.

## Before finishing a task
- `pnpm typecheck`, `pnpm test`, `pnpm boundaries` and `pnpm build` pass.
- If a database schema changed: a new migration exists and `pnpm db:migrate` applies cleanly to a fresh database.

## Domain words
- **Daily punch**: punch in/out for the day. **Ticket punch**: time logged on a service ticket.
- **Work day**: one calculated row per person per date (present, half_day, absent, missed_punch, leave, holiday).
- **Correction**: request to fix a missed or wrong punch, approved by the supervisor.
- **Supervisor**: approves the team's leave, expenses, corrections and ticket reassignments.
- **Admin user**: creates service tickets and assigns employees.


## Git rules (always follow)
1. **Never run `git push`** (any branch, any remote, including `--force`). Pushing is always done by a person.
2. **Never commit unless I ask.** When a task is done, show me the changed files and a suggested commit message, then stop.
3. Never run `git reset --hard`, `git clean`, `git rebase`, `git checkout -- .`, or delete branches unless I ask for that exact command.
4. Never change Git settings (`git config`), remotes, or hooks.
5. Work only on the current branch. If a task needs a new branch, tell me the name to create.
6. Never commit `.env` files, `node_modules`, build output, database dumps, or real staff data.