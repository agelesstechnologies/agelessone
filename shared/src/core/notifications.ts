import { z } from 'zod';
import { Instant, PublicId } from '../common';
/** Alerts for a person (the bell in the web app). Created only by the backend (CoreFacade.notify), never by a request. */

export const Notification = z.object({
  publicId: PublicId,
  alertCode: z.string(),
  urgency: z.enum(['normal', 'urgent']),
  title: z.string(),
  body: z.string().nullable(),
  /** Where the web app opens the record: the hash route without the #, e.g. tickets/<publicId>; null when there is no single record. */
  link: z.string().nullable(),
  createdAt: Instant,
  readAt: Instant.nullable(),
});
export type Notification = z.infer<typeof Notification>;

/** GET /api/core/notifications?unread=true&limit=50 */
export const NotificationsQuery = z.object({
  unread: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type NotificationsQuery = z.infer<typeof NotificationsQuery>;

export const NotificationList = z.object({ unreadCount: z.number().int(), items: z.array(Notification) });
export type NotificationList = z.infer<typeof NotificationList>;

export const NotificationsMarked = z.object({ marked: z.number().int() });
export type NotificationsMarked = z.infer<typeof NotificationsMarked>;

/**
 * Every type of alert the system makes: what people see in their settings. A new CoreFacade.notify alertCode is added here
 * too (a test fails when one is missing). urgent: it is also emailed at once (otherwise it waits for the morning summary).
 */
export const ALERT_TYPES = {
  'tickets.overdue': { module: 'Tickets', label: 'A ticket you head or supervise is overdue', urgent: false },
  'tickets.overdue_ceo': { module: 'Tickets', label: 'A ticket is far overdue (sent to Management)', urgent: true },
  'tickets.assigned': { module: 'Tickets', label: 'You are added to a ticket', urgent: false },
  'tickets.head_approval': { module: 'Tickets', label: 'A ticket waits only for your approval as department head', urgent: false },
  'tickets.reassign_requested': { module: 'Tickets', label: 'Someone asks to be taken off a ticket you decide', urgent: false },
  'tickets.reassign_decided': { module: 'Tickets', label: 'Your request to be taken off a ticket is decided', urgent: false },
  'hrms.leave_submitted': { module: 'HRMS', label: 'Leave is waiting for your decision', urgent: false },
  'hrms.leave_decided': { module: 'HRMS', label: 'Your leave is approved or rejected', urgent: false },
  'hrms.expense_submitted': { module: 'HRMS', label: 'An expense claim is waiting for your decision', urgent: false },
  'hrms.expense_decided': { module: 'HRMS', label: 'Your expense claim is approved or rejected', urgent: false },
  'hrms.correction_submitted': { module: 'HRMS', label: 'A punch correction is waiting for your decision', urgent: false },
  'hrms.correction_decided': { module: 'HRMS', label: 'Your punch correction is approved or rejected', urgent: false },
  'hrms.overtime_submitted': { module: 'HRMS', label: 'Overtime is waiting for your decision', urgent: false },
  'hrms.overtime_decided': { module: 'HRMS', label: 'Your overtime is approved or rejected', urgent: false },
  'hrms.request_escalated': { module: 'HRMS', label: 'A request waited too long and was sent to Management', urgent: true },
  'hrms.certificates_expiring': { module: 'HRMS', label: 'Certificates are about to expire (weekly)', urgent: false },
  'inventory.request_submitted': { module: 'Inventory', label: 'A part request is waiting for the store', urgent: false },
  'inventory.request_head_approval': { module: 'Inventory', label: 'A part request needs your approval as department head', urgent: false },
  'inventory.request_decided': { module: 'Inventory', label: 'Your part request is approved or rejected', urgent: false },
  'inventory.stock_difference': { module: 'Inventory', label: 'The nightly check found stock that did not match', urgent: true },
} as const;
export type AlertCode = keyof typeof ALERT_TYPES;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24 hours)');

/** GET/PUT /api/core/notifications/preferences: my email choices (the bell is always on). */
export const NotificationPreferences = z.object({
  /** Urgent alerts are emailed at once. */
  emailUrgent: z.boolean(),
  /** The 8 AM summary of everything else still unread. */
  emailDigest: z.boolean(),
  /** IST. Urgent emails wait until the window ends; it may cross midnight (22:00 to 07:00). null: no quiet hours. */
  quietHours: z.object({ start: clock, end: clock }).refine((q) => q.start !== q.end, 'The start and the end must differ').nullable(),
  /** Email on or off per type of alert, for every type in the catalog. */
  types: z.array(z.object({ code: z.string(), module: z.string(), label: z.string(), urgent: z.boolean(), email: z.boolean() })),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;

export const SaveNotificationPreferencesRequest = z.object({
  emailUrgent: z.boolean(),
  emailDigest: z.boolean(),
  quietHours: NotificationPreferences.shape.quietHours,
  /** Only the types being changed; the others keep their choice. */
  types: z.record(z.boolean()).refine((t) => Object.keys(t).every((c) => c in ALERT_TYPES), 'Unknown alert type').default({}),
});
export type SaveNotificationPreferencesRequest = z.infer<typeof SaveNotificationPreferencesRequest>;
