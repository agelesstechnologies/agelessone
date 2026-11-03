# CLAUDE.md — backend

The NestJS API and the PostgreSQL database. Read the root `CLAUDE.md` first; its rules apply here too.

## Commands (from the repository root)
- `pnpm --filter @ageless/backend dev` — start the API on http://localhost:3000/api
- `pnpm db:generate -- --name <what_changed>` — create a migration from schema changes
- `pnpm db:migrate` — apply pending migrations to the database in `backend/.env`
- `pnpm db:reset` — empty a development database and rebuild it (refuses non-dev databases)
- `pnpm db:seed` — add fictional starter data (tenant 1, AE and ATPL, roles, five demo people with logins); safe to run again
- `pnpm boundaries` — check the module boundary rules below
- Settings: copy `backend/.env.example` to `backend/.env` (`DATABASE_URL`, `TEST_DATABASE_URL`, `PORT`, `JWT_SECRET`).
- Tests use their own database `TEST_DATABASE_URL` (`ageless_test`), reset, migrated and seeded before every `pnpm test`.

## Structure
```
backend/
  src/
    platform/db/              one shared database pool (inject DB), Tx type, violatedConstraint()
    platform/http/            AppError + error filter, ZodValidationPipe, RequestContext (caller), configureApp
    modules/
      core/                   shared foundation: persons, contacts, organisation, policies (core.facade.ts)
        auth/                 sign-in (JWT), the global AuthGuard, logins and role assignments
      tickets/                ticket engine and service tickets
      hrms/
        schema.ts             the 'hrms' PostgreSQL schema
        hrms.module.ts        registers the sub-modules
        hrms.facade.ts        the ONLY entry point for other modules
        people/ skills/ attendance/ leave/ expenses/ reports/
      sales/ operations/ ...  later modules (README only)
    test/                     test setup and helpers (not part of the build)
  drizzle/                    migrations for the whole database, committed, applied in order
  uploads/                    uploaded files (receipts), git-ignored; tests use UPLOAD_DIR in a temp folder
  scripts/                    db-reset.mjs, db-seed.mjs
  docs/reference/             full reference SQL (all planned tables and rules)
  docs/setup/                 database setup SQL (local PC, office server)
```
Each sub-module: `api/` (controllers) · `application/` (services, use cases) · `domain/` (pure rules + `.spec.ts` tests)
· `infrastructure/` (Drizzle repositories) · `schema.ts` (its tables) · `<name>.module.ts`. API tests: `<name>.api.spec.ts`.

## Rules (always follow)
1. **Database changes only through migrations**: edit a `schema.ts`, run `pnpm db:generate`, then `pnpm db:migrate`;
   commit the schema and the new `drizzle/` files together. Never change a database by hand.
2. **Never edit or delete a merged migration.** Add a new one to fix it.
3. **Module boundaries** (checked by `pnpm boundaries`):
   - another module is used only through its `*.facade.ts` (calls) or `schema.ts` (foreign keys);
   - inside HRMS, a sub-module uses another only through its `application/*.service.ts` or `schema.ts`;
   - `domain/` never imports NestJS, Drizzle, `pg`, controllers or repositories.
4. A module writes only its own PostgreSQL schema (`hrms` → `hrms.*`).
5. Every table has `tenant_id`.
6. **Punches (`attendance_events`) are append-only.** Corrections add rows; the work day is recalculated.
7. Nothing is deleted: records are ended, exited or marked inactive, so history is kept.

## Coding style
- Controllers: validate with `new ZodValidationPipe(Schema)` on `@Body`/`@Query`/`@Param`, check permission, call one
  service method. No business logic. Get the caller with `@Ctx() ctx: RequestContext`.
- **Every route declares who may use it**, or the guard refuses it: `@Public()` (health, login), `@SignedIn()` (anyone
  signed in), or `@Permission('module.area.action')`. The guard checks the caller holds the permission; the service then
  checks the scope against the record (`own` = yourself; `team` = yourself to view, plus the people you manage;
  `all` = whole tenant). Tenant-wide actions call `requireAll(ctx, permission)`.
- New permission codes are added to `core.permissions` by a migration; which role has them is data (seed / admin).
- Services: transactions, repositories, other modules' facades, outbox events. Throw `AppError(code, status, message, details?)`.
- Every write that touches more than one table runs in one transaction.
- Writing another module's tables: call its facade and pass your `tx` (e.g. `CoreFacade.createPerson(tx, ...)`), so one
  use case stays one transaction. Reading them (joins for search and detail views) may use their `schema.ts` directly.
- Uploaded files: keep them in memory (multer, size limit), check the type from the bytes, save with
  `saveUpload(folder, ext, buffer)` (random file name, never the uploaded name), store only the relative path, and
  `discardUpload(path)` if the record can't be saved.
- Turn database rule violations into clear codes with `violatedConstraint(err)` (e.g. 409 `HRMS_DUPLICATE_EMPLOYEE_CODE`).
- Errors always leave the API as `{ code, message, details? }` (bad input: 400 `VALIDATION`; no caller: 401 `AUTH_MISSING`).
- Constructor injection always uses explicit `@Inject(Class)`: Vitest does not emit decorator metadata.
- Sign-in: `POST /api/auth/login` (phone or email + password) returns a JWT; requests send `Authorization: Bearer <token>`.
  The guard reloads the login and today's roles on every request, so ending a role, deactivating, exiting the last job
  or changing the password takes effect at once. `JWT_SECRET` must be set (`backend/.env`).
- Names: tables plural snake_case; TypeScript camelCase; routes `/api/<module>/<sub-module>/...`.
