import { Inject, Injectable } from '@nestjs/common';
import type { Notification, NotificationList, NotificationsMarked, NotificationsQuery } from '@ageless/shared';
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { Conn, DB, Db } from '../../../../platform/db/db.module';
import { RequestContext } from '../../../../platform/http/request-context';
import { todayIst } from '../../../../platform/time';
import { notificationDeliveries, notifications, persons, roleAssignments, roles } from '../../schema';

/**
 * Who gets an alert: people by relationship (the caller looked them up: a department head, a supervisor) and/or by role
 * code (ceo, hr, store_incharge ...). Never named people. A role means everyone who holds it today.
 */
export interface Recipients { personIds?: number[]; roles?: string[] }

export interface NewAlert {
  tenantId: number;
  legalEntityId?: number | null;
  /** The kind of alert, module.what_happened, e.g. tickets.overdue. */
  alertCode: string;
  urgency?: 'normal' | 'urgent';
  title: string;
  body?: string | null;
  /** The web hash route that opens the record, without the #, e.g. tickets/<publicId>. */
  link?: string | null;
  /** The same key for the same person never makes a second alert, e.g. tickets.overdue:<ticket>:<due date>:head. */
  dedupeKey: string;
  recipients: Recipients;
  /** People who must not get it (the one who made the change). */
  except?: number[];
}

/** The alerts behind the bell. Modules create them only through CoreFacade.notify. */
@Injectable()
export class NotificationsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The active people holding any of these roles today (oldest assignment first, each once). */
  async peopleWithRoles(conn: Conn, tenantId: number, roleCodes: string[]): Promise<number[]> {
    if (roleCodes.length === 0) return [];
    const today = todayIst();
    const rows = await conn.select({ personId: roleAssignments.personId }).from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .innerJoin(persons, eq(persons.id, roleAssignments.personId))
      .where(and(eq(roleAssignments.tenantId, tenantId), inArray(roles.code, roleCodes), isNull(roleAssignments.endedAt),
        lte(roleAssignments.validFrom, today), or(isNull(roleAssignments.validTo), gte(roleAssignments.validTo, today)), eq(persons.status, 'active')))
      .orderBy(roleAssignments.id);
    return [...new Set(rows.map((r) => r.personId))];
  }

  /**
   * Makes the alert for each recipient, once: an existing (person, dedupeKey) is left alone. Returns how many people got a
   * new one. Runs inside the caller's transaction so the alert exists exactly when the change was saved.
   */
  async notify(conn: Conn, a: NewAlert): Promise<number> {
    const byRole = await this.peopleWithRoles(conn, a.tenantId, a.recipients.roles ?? []);
    const ids = [...new Set([...(a.recipients.personIds ?? []), ...byRole])].filter((id) => !a.except?.includes(id));
    if (ids.length === 0) return 0;
    const created = await conn.insert(notifications).values(ids.map((recipientPersonId) => ({
      tenantId: a.tenantId, legalEntityId: a.legalEntityId ?? null, recipientPersonId, alertCode: a.alertCode,
      urgency: a.urgency ?? 'normal', title: a.title, body: a.body ?? null, link: a.link ?? null, dedupeKey: a.dedupeKey,
    }))).onConflictDoNothing().returning({ id: notifications.id });
    if (created.length) {
      // the bell is always on
      await conn.insert(notificationDeliveries).values(created.map((n) => ({
        tenantId: a.tenantId, notificationId: n.id, channel: 'in_app', status: 'sent', attempts: 1, sentAt: new Date(),
      })));
      // urgent alerts are also emailed at once (NotificationEmailService); the rest wait for the morning summary
      if (a.urgency === 'urgent') {
        await conn.insert(notificationDeliveries).values(created.map((n) => ({ tenantId: a.tenantId, notificationId: n.id, channel: 'email' })));
      }
    }
    return created.length;
  }

  /** The caller's own alerts, newest first, and how many are unread. */
  async list(ctx: RequestContext, q: NotificationsQuery): Promise<NotificationList> {
    const mine = and(eq(notifications.tenantId, ctx.tenantId), eq(notifications.recipientPersonId, ctx.personId));
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(mine, isNull(notifications.readAt)));
    const rows = await this.db.select().from(notifications)
      .where(q.unread ? and(mine, isNull(notifications.readAt)) : mine)
      .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(q.limit);
    return { unreadCount: n, items: rows.map(toNotification) };
  }

  /** Marks one of the caller's alerts read (again is fine). Another person's alert counts as not found. */
  async markRead(ctx: RequestContext, publicId: string): Promise<NotificationsMarked> {
    const rows = await this.db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.tenantId, ctx.tenantId), eq(notifications.recipientPersonId, ctx.personId),
        eq(notifications.publicId, publicId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return { marked: rows.length };
  }

  async markAllRead(ctx: RequestContext): Promise<NotificationsMarked> {
    const rows = await this.db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.tenantId, ctx.tenantId), eq(notifications.recipientPersonId, ctx.personId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return { marked: rows.length };
  }
}

function toNotification(r: typeof notifications.$inferSelect): Notification {
  return {
    publicId: r.publicId, alertCode: r.alertCode, urgency: r.urgency as Notification['urgency'], title: r.title, body: r.body, link: r.link,
    createdAt: r.createdAt.toISOString(), readAt: r.readAt?.toISOString() ?? null,
  };
}
