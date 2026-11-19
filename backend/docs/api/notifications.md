# Alerts (notifications) API

Written for developers of the web app and the backend. Base URL `http://localhost:3000/api`; every call needs
`Authorization: Bearer <token>`. Shapes: `shared/src/core/notifications.ts`; `/api/docs` shows the routes live.
Tables (schema `core`, migration `0049_core_notifications`): `notifications` (one row per person per alert) and
`notification_deliveries` (one row per channel; only `in_app` exists so far).

## How a module raises an alert

```ts
await this.core.notify(tx /* or the db, in a job */, {
  tenantId, legalEntityId,
  alertCode: 'tickets.overdue',            // module.what_happened
  urgency: 'normal',                       // or 'urgent'
  title: 'Ticket AE-0004 is overdue', body: '...', link: 'tickets/<publicId>',   // link = web hash route, without the #
  dedupeKey: 'tickets.overdue:<publicId>:<dueDate>:head',
  recipients: { roles: ['ceo'], personIds: [headId] },   // by role or relationship, never named people
  except: [actorId],                       // optional: never the person who made the change
});
```

- **Recipients** are the people holding a role today (active person, active assignment) plus people the caller looked up
  (a department head, a supervisor). Nothing names a person.
- **De-duplication:** the same `dedupeKey` for the same person is stored once (`unique (tenant_id, recipient_person_id,
  dedupe_key)`), so a job run twice or an event replayed makes no second alert. Put what makes the alert new in the key
  (the due date, the week, the request id).
- Inside a transaction the alert exists exactly when the change was saved.
- Never put phone numbers, bank or ID numbers or exact locations in an alert.

## Routes (any signed-in person; only their own alerts)

| Route | What |
|---|---|
| `GET /core/notifications?unread=true&limit=50` | newest first, with `unreadCount` |
| `POST /core/notifications/:publicId/read` | mark one read (`{ marked: 0 }` when already read or not theirs) |
| `POST /core/notifications/read-all` | mark all read |
| `GET /core/notifications/preferences` | my email choices: `emailUrgent`, `emailDigest`, `quietHours` (`{ start, end }` or null) and `types` (every alert type with `email` on or off) |
| `PUT /core/notifications/preferences` | save them; `types` holds only the ones being changed (the others keep their choice) |

## Alerts raised so far

| alertCode | Who | When |
|---|---|---|
| `tickets.overdue` | department head and the ticket's supervisor | first day past the due date (tickets:daily) |
| `tickets.overdue_ceo` (urgent) | CEO | policy `tickets.overdue.ceo_after_days` days overdue |
| `hrms.request_escalated` (urgent) | CEO | leave, expense, correction or overtime request waited past `hrms.approvals.escalate_after_days` (hrms:daily) |
| `hrms.certificates_expiring` | HR | certificates expire within 30 days; one per week (hrms:daily) |
| `inventory.stock_difference` (urgent) | inventory controller | the nightly rebuild found stored balances that differ from the moves |
| `hrms.leave_submitted` | the approver (named, else HR, else CEO) | leave applied for; not when the person's role needs no approval |
| `hrms.leave_decided` | the person | leave approved or rejected (rejection includes the reason) |
| `tickets.assigned` | the person added | added to a ticket's assignees (not the one who assigned) |
| `inventory.request_submitted` | store in-charge with a current job in the request's company | part request made |
| `inventory.request_decided` | the requester | part request fully approved (stock reserved) or rejected |
| `hrms.expense_submitted` | the job's manager (no manager: HR) | claim submitted; not when the role needs no approval |
| `hrms.expense_decided` | the person | claim approved (with the amount) or rejected (with the reason) |
| `hrms.correction_submitted` | the approver | punch correction asked for |
| `hrms.correction_decided` | the person and whoever filed it | correction approved or rejected |
| `hrms.overtime_submitted` | the approver | overtime asked for |
| `hrms.overtime_decided` | the person | overtime approved or rejected |
| `tickets.head_approval` | the ticket's department head and supervisor (never its assignees) | the type needs head approval and it is the only thing still missing: when someone tries to complete the ticket, and in `tickets:daily`; once per ticket |
| `tickets.reassign_requested` | the approver (supervisor, else manager, head, HR, CEO) | an assignee asks to be taken off a ticket |
| `tickets.reassign_decided` | the one who asked | request approved or rejected (the new person gets `tickets.assigned`) |
| `inventory.request_head_approval` | the ticket's department head | part request above the value limit |

## Instant alerts call `notify` directly

An instant alert is made by the module's own use case, in the same transaction as the change, so it exists exactly when
the change was saved and needs no dispatcher, polling or second table. `core.outbox` stays for events other modules
consume (stock documents); an alert is not one of those.

## Email

Settings in `backend/.env` (never committed): `EMAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
`SMTP_PASSWORD`, `MAIL_FROM`, and `APP_URL` (the web address put in the emails). Sign-in codes use the same settings.

- **Urgent alerts** (urgency `urgent`) get an `email` row in `core.notification_deliveries` (status `pending`) when they are
  made. `NotificationEmailService` sends them: a loop in the API process every 30 seconds when `EMAIL_PROVIDER=smtp`
  (turn it off with `NOTIFICATION_EMAIL_LOOP=off`), and the `notifications:daily` job.
- **Everything else** is in one **morning summary** per person: their unread alerts from the last 48 hours that no email
  has covered. Run `pnpm --filter @ageless/backend notifications:daily` from Task Scheduler at 08:00 IST, after
  `hrms:daily`, `tickets:daily` and `inventory:daily`. Read alerts are left out.
- **Tracking:** each delivery is `pending`, `sent` or `failed`, with `attempts`, `last_attempt_at` and `last_error`. A failed
  send is tried again after attempts x 5 minutes, at most 5 times. A person with no email address (contact or login) is
  marked failed once, with no retry. `last_error` holds only the error and SMTP reply code, never an address.
- The address is the person's current primary email contact, else any current email contact, else their login email.

## Choices (preferences)

The bell is always on. A person chooses only about **email**, in the web app (Overview, the Alerts panel, Settings) or with the two routes above:
- `emailUrgent` off: urgent alerts are not emailed. `emailDigest` off: no morning summary.
- Email off for one **type** of alert (`ALERT_TYPES` in `shared/src/core/notifications.ts`, the list people see).
  A new `alertCode` must be added there too; a test fails when the code and the list differ.
- **Quiet hours** (India time, may cross midnight, e.g. 22:00 to 07:00): urgent emails wait until the window ends.
- Choices are read when an email is sent, so a change applies to alerts already waiting. Something turned off is recorded
  as `skipped` in `core.notification_deliveries` (never emailed, never retried). Nothing saved means everything on.
- Tables: `core.notification_settings` (one row per person) and `core.notification_preferences` (one row per person per type
  turned on or off), migration `0051_notification_preferences`.

## Not built yet

WhatsApp, and push notifications for the mobile app. Overtime, correction and part-request head-approval alerts have no
test of their own yet; they follow the same pattern as the leave and expense ones. Urgent emails held by quiet hours are
looked at 200 at a time, so a very large number of held emails could delay others; not a concern at this size.
