# Ageless

One repository for the Ageless platform: the NestJS API and database (`backend/`), the React admin panel (`web/`,
not created yet) and the request shapes both use (`shared/`). Web only for now; `mobile/` is a placeholder for later.

```
ageless/
  backend/   API and database: src/, drizzle/ (migrations), scripts/ (reset, seed), docs/ (reference SQL, setup SQL)
  shared/    Zod request shapes and types (@ageless/shared)
  web/       admin panel (React + Vite, planned)
  mobile/    field app (later)
```

## Start on your PC (no Docker)
1. Install **Node.js 22**, **pnpm 9** (`npm i -g pnpm@9`), **Git**.
2. Choose where your development database lives:
   - **Your own PC:** install **PostgreSQL 16** (postgresql.org; Postgres.app on Mac), then run `backend/docs/setup/local-pc.sql` once as the `postgres` user.
   - **The office database machine:** ask the lead for your own database (`dev_<name>`), created with `backend/docs/setup/office-server.sql`.
3. `git clone <repo> && cd ageless`
4. `cp backend/.env.example backend/.env` and set `DATABASE_URL` (and `TEST_DATABASE_URL` for tests) to your databases
   (local: `postgres://ageless:ageless_dev@localhost:5432/ageless_dev`, office: `postgres://dev_anu:<password>@192.168.1.50:5432/dev_anu`).
5. `pnpm install`, then `pnpm db:migrate`, then `pnpm db:seed` (fictional starter data)
6. `pnpm --filter @ageless/backend dev` → API on http://localhost:3000/api/hrms/people/health

Every day: `git pull` → `pnpm install` → `pnpm db:migrate`.
Start your database again from empty: `pnpm db:reset` (only works on development databases named `dev_*` or `ageless_dev`).

## Who owns what (edit `.github/CODEOWNERS` with real usernames)
| Area | Owner |
| --- | --- |
| backend core, platform, migrations folder | Lead developer (database steward) |
| backend tickets | Backend 2 |
| hrms/attendance, hrms/people | Backend 3 |
| hrms/leave, hrms/expenses | HR colleague B |
| hrms/skills, hrms/reports | HR colleague A |
| shared | Lead developer, Backend 2, Backend 3 |
| web | Web developer |

## How we work
- Short-lived branches: `feature/hrms-leave-apply`, merged within 1–3 days.
- Every pull request: one owner review + passing CI (typecheck, boundaries, tests, migrations, build).
- Change a table: edit your `schema.ts` → `pnpm db:generate -- --name what_changed` → `pnpm db:migrate`
  → commit schema and `backend/drizzle/` files together. If `drizzle/` conflicts: delete your new migration, pull main, generate again.
- Triggers, views, row-level security: `pnpm --filter @ageless/backend exec drizzle-kit generate --custom --name ...`
- Never edit a merged migration. Never change a database by hand.
- Backend structure and boundary rules: `backend/CLAUDE.md`.

## Adding a new backend module (for example Sales)
Copy the HRMS layout: `backend/src/modules/sales/schema.ts`, `sales.module.ts`, `sales.facade.ts`, sub-modules,
register it in `app.module.ts`, add `'sales'` to `schemaFilter` in `backend/drizzle.config.ts`, add owners to CODEOWNERS.
