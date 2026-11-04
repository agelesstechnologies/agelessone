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

Sign in with a login from the backend seed (`pnpm db:seed`). In development the sign-in page shows buttons for the demo logins (Employee, Supervisor, HR, System admin); they all use the seeded development password. The backend needs `JWT_SECRET` in `backend/.env` (see `backend/.env.example`).

Point the app at a different API with `web/.env.local`:

```dotenv
VITE_API_URL=http://localhost:3000/api
```

The backend allows the local Vite origin (`http://localhost:5173`) by default. Set `WEB_ORIGIN` for a different frontend origin.

## Current scope

Menus and buttons follow the permissions from `GET /api/auth/me`; the backend still checks every request.

| Screen | Needs | Notes |
| --- | --- | --- |
| People | `hrms.people.view` | Add person needs `hrms.people.create` |
| Attendance: My day, My history | `hrms.attendance.punch` | Punch in and out, Work Hours History |
| Attendance: Team register, Work hours | `hrms.attendance.view` | Recalculate needs `hrms.attendance.rebuild` |
| Expenses: My claims | `hrms.expenses.submit` | New claim with optional receipt |
| Expenses: To approve | `hrms.expenses.approve` | Approve, reject; Mark paid needs `hrms.expenses.pay` |
| Expenses: Report | `hrms.expenses.report` | Totals by category and status |
| Roles & access | signed in | Create login and Give role need `core.users.manage` |
| Leave | none | Placeholder: the backend has no leave endpoints yet |

Build with `pnpm --filter @ageless/web build`.
