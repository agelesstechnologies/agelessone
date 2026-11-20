import { Inject, Injectable } from '@nestjs/common';
import { ALERT_TYPES, NotificationPreferences, SaveNotificationPreferencesRequest } from '@ageless/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Conn, DB, Db } from '../../../../platform/db/db.module';
import { RequestContext } from '../../../../platform/http/request-context';
import { notificationPreferences, notificationSettings } from '../../schema';

/** What the email channel needs to know about one person. No saved choices means everything on, no quiet hours. */
export interface EmailChoices {
  emailUrgent: boolean;
  emailDigest: boolean;
  quiet: { start: string; end: string } | null;
  /** Alert types whose email the person turned off. */
  off: Set<string>;
}
export const DEFAULT_CHOICES: EmailChoices = { emailUrgent: true, emailDigest: true, quiet: null, off: new Set() };

/** A person's choices for alert emails (the bell is always on). Each person reads and changes only their own. */
@Injectable()
export class NotificationPreferencesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async get(ctx: RequestContext): Promise<NotificationPreferences> {
    const c = (await this.choicesFor(this.db, [ctx.personId])).get(ctx.personId) ?? DEFAULT_CHOICES;
    return {
      emailUrgent: c.emailUrgent, emailDigest: c.emailDigest, quietHours: c.quiet,
      types: Object.entries(ALERT_TYPES).map(([code, t]) => ({ code, module: t.module, label: t.label, urgent: t.urgent, email: !c.off.has(code) })),
    };
  }

  /** Saves the settings and the types given (the others keep their choice); answers the result. */
  async save(ctx: RequestContext, req: SaveNotificationPreferencesRequest): Promise<NotificationPreferences> {
    await this.db.transaction(async (tx) => {
      const quiet = { quietStart: req.quietHours?.start ?? null, quietEnd: req.quietHours?.end ?? null };
      await tx.insert(notificationSettings).values({ tenantId: ctx.tenantId, personId: ctx.personId, emailUrgent: req.emailUrgent, emailDigest: req.emailDigest, ...quiet })
        .onConflictDoUpdate({ target: notificationSettings.personId, set: { emailUrgent: req.emailUrgent, emailDigest: req.emailDigest, ...quiet, updatedAt: new Date() } });
      const types = Object.entries(req.types);
      if (types.length) {
        await tx.insert(notificationPreferences).values(types.map(([alertCode, email]) => ({ tenantId: ctx.tenantId, personId: ctx.personId, alertCode, email })))
          .onConflictDoUpdate({ target: [notificationPreferences.personId, notificationPreferences.alertCode], set: { email: sql`excluded.email`, updatedAt: new Date() } });
      }
    });
    return this.get(ctx);
  }

  /** The email choices of these people (people with none saved are left out: use DEFAULT_CHOICES). */
  async choicesFor(conn: Conn, personIds: number[]): Promise<Map<number, EmailChoices>> {
    const out = new Map<number, EmailChoices>();
    if (personIds.length === 0) return out;
    const settings = await conn.select().from(notificationSettings).where(inArray(notificationSettings.personId, personIds));
    for (const s of settings) {
      out.set(s.personId, { emailUrgent: s.emailUrgent, emailDigest: s.emailDigest, off: new Set(),
        quiet: s.quietStart && s.quietEnd ? { start: s.quietStart, end: s.quietEnd } : null });
    }
    const off = await conn.select({ personId: notificationPreferences.personId, code: notificationPreferences.alertCode }).from(notificationPreferences)
      .where(and(inArray(notificationPreferences.personId, personIds), eq(notificationPreferences.email, false)));
    for (const o of off) {
      const c = out.get(o.personId) ?? { ...DEFAULT_CHOICES, off: new Set<string>() };
      c.off.add(o.code);
      out.set(o.personId, c);
    }
    return out;
  }

}
