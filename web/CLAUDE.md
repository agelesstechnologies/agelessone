# Web admin panel

React + Vite + TypeScript admin panel for HR, supervisors and admin users. Read the root `CLAUDE.md` first; its rules apply here too.

## Current implementation
- Sign-in page (`POST /api/auth/login`); the token is kept in localStorage and sent as `Authorization: Bearer`. A 401 signs the person out.
- Menus, tabs and buttons are shown from `GET /api/auth/me` permissions (`src/permissions.ts`); the backend still checks every request.
- Screens: Overview, People, Attendance (punch, history, team register, work hours), Expenses (claims, approvals, report), Roles & access, and a Leave placeholder (the backend has no leave endpoints yet).
- Uses `@ageless/shared` schemas and response types. Configure the API URL with `VITE_API_URL`.
- Run with `pnpm --filter @ageless/web dev`; build with `pnpm --filter @ageless/web build`.
- The backend has no list of approved-but-unpaid claims, so Mark paid appears on a claim only right after it is approved in the same session.

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
