# Web admin panel

React + Vite + TypeScript UI for the backend APIs that currently exist. Read the root `CLAUDE.md` first; its rules apply here too.

## Current implementation
- People directory backed by `/api/hrms/people`: search, status/company filters, pagination, person detail, and create person.
- Attendance, leave, expenses, login, and permissions are not implemented in the backend yet; do not present them as working screens.
- Uses `@ageless/shared` schemas and response types. Until login exists, requests send `x-tenant-id` and `x-person-id` headers.
- Configure the API URL and caller headers with `VITE_API_URL`, `VITE_TENANT_ID`, and `VITE_PERSON_ID`.
- Run with `pnpm --filter @ageless/web dev`; build with `pnpm --filter @ageless/web build`.
