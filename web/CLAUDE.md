# Web admin panel

React + Vite + TypeScript admin panel for HR, supervisors and admin users. Read the root `CLAUDE.md` first; its rules apply here too.

## Current implementation
- People directory backed by `/api/hrms/people`: search as you type, status/company filters, pagination, person detail, and create person.
- Attendance, leave, expenses and login screens are not built in the web app yet; do not present them as working screens.
- Uses `@ageless/shared` schemas and response types. Until the sign-in page exists, requests send `x-tenant-id` and `x-person-id` headers.
- Configure the API URL and caller headers with `VITE_API_URL`, `VITE_TENANT_ID`, and `VITE_PERSON_ID`.
- Run with `pnpm --filter @ageless/web dev`; build with `pnpm --filter @ageless/web build`.

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
