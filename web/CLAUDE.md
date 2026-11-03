# CLAUDE.md — web

The admin panel for HR, supervisors and admin users. **Not created yet**: this file holds the plan until the
React + Vite app is set up as its own step. Read the root `CLAUDE.md` first; its rules apply here too.

## Plan
- React + Vite + TypeScript, package name `@ageless/web`, created inside this folder (keep this file and the README).
- Talks only to the backend API under `/api`. Request and response shapes come from `@ageless/shared`;
  forms validate with the same Zod schemas the backend uses.
- Sign in with `POST /api/auth/login` (phone or email + password); send the token as `Authorization: Bearer <token>`.
  Use `GET /api/auth/me` for the person's name and permissions to decide which menus and buttons to show
  (the backend still checks every request). On 401 go back to the sign-in page.
- Errors from the API are `{ code, message, details? }`: show `message`, and map `VALIDATION` details to form fields.
- Links and routes use `public_id`, never internal ids.
- Screens stay familiar to Froid users: daily punch, Work Hours History, leave requests, expense tracking.
- One folder per module under `src/modules/` (core, tickets, hrms ...).
