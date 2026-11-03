# Ageless People web app

React, Vite and TypeScript admin UI for the existing HRMS People API.

## Run locally

From the repository root, install dependencies and start the backend and frontend in separate terminals:

```sh
pnpm install
pnpm --filter @ageless/backend dev
pnpm --filter @ageless/web dev
```

Open http://localhost:5173. The backend is expected at `http://localhost:3000/api`.

The frontend sends the temporary `x-tenant-id` and `x-person-id` headers required by the backend. Defaults are tenant `1` and the seeded Demo Supervisor. Override these for a different local API using `web/.env.local`:

```dotenv
VITE_API_URL=http://localhost:3000/api
VITE_TENANT_ID=1
VITE_PERSON_ID=00000000-0000-4000-8000-000000000001
```

The backend allows the local Vite origin (`http://localhost:5173`) by default. Set `WEB_ORIGIN` for a different frontend origin.

## Current scope

The directory supports listing, searching, status/company filters, pagination, viewing a person's contacts and employments, and creating a person with their first employment. Attendance, leave, expenses, login, and permissions are not available in the backend yet.

Build with `pnpm --filter @ageless/web build`.
