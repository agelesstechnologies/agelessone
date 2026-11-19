import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import { Conn, DB, Db } from '../../../../platform/db/db.module';
import { mailFailure, sendMail } from '../../../../platform/mailer';
import { notificationDeliveries, notifications, personContacts, users } from '../../schema';
import { clockIst, inQuietHours } from '../domain/quiet-hours';
import { DEFAULT_CHOICES, NotificationPreferencesService } from './notification-preferences.service';

const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = 5;              // a failed send is tried again after attempts × 5 minutes
const LOOP_MS = 30_000;
const DIGEST_WINDOW_HOURS = 48;       // a missed morning is caught up the next one
const DIGEST_MAX_LINES = 30;

type Pending = { deliveryId: number; attempts: number; recipientPersonId: number; alertCode: string; title: string; body: string | null; link: string | null };

/** The web page an alert opens, when APP_URL is set (links are hash routes: #tickets/<id>). */
function openLink(link: string | null, env: NodeJS.ProcessEnv): string | null {
  const base = env.APP_URL?.trim().replace(/\/+$/, '');
  return base && link ? `${base}/#${link}` : base ?? null;
}

/**
 * The email channel of alerts. Urgent alerts get a pending email delivery when they are made and go out within seconds
 * (a loop in the API process when EMAIL_PROVIDER=smtp, or the notifications:daily job); every other unread alert goes in
 * one morning summary per person (notifications:daily, 8 AM). Each delivery is tracked: sent, failed, tried again with a
 * longer wait each time (at most 5 tries). A person's choices apply when the email is sent: email turned off for the type
 * (or for urgent emails, or for the summary) marks the delivery skipped; quiet hours (IST) hold urgent emails until they end. Nothing here logs an address: only the delivery id and the SMTP reply code.
 */
@Injectable()
export class NotificationEmailService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NotificationEmailService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NotificationPreferencesService) private readonly preferences: NotificationPreferencesService,
  ) {}

  onModuleInit(): void {
    // only with real email: development prints codes to the console and tests read them from memory
    if ((process.env.EMAIL_PROVIDER ?? '').trim().toLowerCase() !== 'smtp' || process.env.NOTIFICATION_EMAIL_LOOP === 'off') return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.sendPending().catch((e) => this.log.warn(`email loop failed: ${mailFailure(e)}`)).finally(() => { this.running = false; });
    }, LOOP_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  /** A person's email: their current primary email contact, else any current one, else their login email. */
  async addressOf(conn: Conn, personId: number): Promise<string | null> {
    const [contact] = await conn.select({ value: personContacts.value }).from(personContacts)
      .where(and(eq(personContacts.personId, personId), eq(personContacts.kind, 'email'), isNull(personContacts.endedAt)))
      .orderBy(desc(personContacts.isPrimary), asc(personContacts.id)).limit(1);
    if (contact) return contact.value;
    const [login] = await conn.select({ email: users.loginEmail }).from(users).where(and(eq(users.personId, personId), eq(users.isActive, true)));
    return login?.email ?? null;
  }

  /**
   * Sends the pending email deliveries that are due, one email each. A person without an email address is marked failed
   * once (no retry can help). Returns the counts. Safe to run from two places: a row is taken by one runner at a time.
   */
  async sendPending(limit = 200, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): Promise<{ sent: number; failed: number; retrying: number; skipped: number; held: number }> {
    const out = { sent: 0, failed: 0, retrying: 0, skipped: 0, held: 0 };
    await this.db.transaction(async (tx) => {
      // lock the due deliveries first (one table: FOR UPDATE SKIP LOCKED), then read what they say
      const due = await tx.select({ id: notificationDeliveries.id, attempts: notificationDeliveries.attempts, notificationId: notificationDeliveries.notificationId })
        .from(notificationDeliveries)
        .where(and(eq(notificationDeliveries.channel, 'email'), eq(notificationDeliveries.status, 'pending'),
          or(isNull(notificationDeliveries.lastAttemptAt),
            lt(notificationDeliveries.lastAttemptAt, sql`now() - (${notificationDeliveries.attempts} * ${RETRY_MINUTES} * interval '1 minute')`))))
        .orderBy(asc(notificationDeliveries.id)).limit(limit).for('update', { skipLocked: true });
      const texts = due.length === 0 ? [] : await tx.select({ id: notifications.id, recipientPersonId: notifications.recipientPersonId, alertCode: notifications.alertCode,
        title: notifications.title, body: notifications.body, link: notifications.link }).from(notifications).where(inArray(notifications.id, due.map((d) => d.notificationId)));
      const byId = new Map(texts.map((t) => [t.id, t]));
      const rows: Pending[] = due.map((d) => ({ deliveryId: d.id, attempts: d.attempts, ...byId.get(d.notificationId)! }));
      const choices = await this.preferences.choicesFor(tx, [...new Set(rows.map((r) => r.recipientPersonId))]);
      const clock = clockIst(now);
      for (const r of rows) {
        const mine = choices.get(r.recipientPersonId) ?? DEFAULT_CHOICES;
        if (!mine.emailUrgent || mine.off.has(r.alertCode)) {
          await this.mark(tx, r.deliveryId, { status: 'skipped', attempts: r.attempts, lastError: 'turned off by the person' });
          out.skipped++;
          continue;
        }
        if (inQuietHours(clock, mine.quiet)) { out.held++; continue; }          // stays pending until the quiet hours end
        const to = await this.addressOf(tx, r.recipientPersonId);
        if (!to) {
          await this.mark(tx, r.deliveryId, { status: 'failed', attempts: r.attempts + 1, lastError: 'no email address' });
          out.failed++;
          continue;
        }
        const url = openLink(r.link, env);
        const text = [r.title, r.body, url ? `Open it here: ${url}` : null].filter(Boolean).join('\n\n');
        try {
          await sendMail({ to, subject: `[Ageless] ${r.title}`, text }, env);
          await this.mark(tx, r.deliveryId, { status: 'sent', attempts: r.attempts + 1, lastError: null, sentAt: new Date() });
          out.sent++;
        } catch (e) {
          const attempts = r.attempts + 1;
          const final = attempts >= MAX_ATTEMPTS;
          await this.mark(tx, r.deliveryId, { status: final ? 'failed' : 'pending', attempts, lastError: mailFailure(e) });
          if (final) out.failed++; else out.retrying++;
        }
      }
    });
    return out;
  }

  /**
   * The morning summary: one email per person listing their unread alerts (not urgent ones: those were emailed at once)
   * made in the last 48 hours that no email has covered. A person with no email address gets none (recorded once as
   * failed); a send that fails is tried again the next morning.
   */
  async sendDigests(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<{ people: number; alerts: number; failed: number }> {
    const since = new Date(now.getTime() - DIGEST_WINDOW_HOURS * 3_600_000);
    const open = await this.db.select().from(notifications)
      .where(and(eq(notifications.urgency, 'normal'), isNull(notifications.readAt), gte(notifications.createdAt, since),
        notExists(this.db.select({ one: sql`1` }).from(notificationDeliveries)
          .where(and(eq(notificationDeliveries.notificationId, notifications.id), eq(notificationDeliveries.channel, 'email'))))))
      .orderBy(asc(notifications.recipientPersonId), asc(notifications.createdAt), asc(notifications.id));
    const byPerson = new Map<number, typeof open>();
    for (const n of open) byPerson.set(n.recipientPersonId, [...(byPerson.get(n.recipientPersonId) ?? []), n]);

    const out = { people: 0, alerts: 0, failed: 0 };
    const choices = await this.preferences.choicesFor(this.db, [...byPerson.keys()]);
    for (const [personId, everything] of byPerson) {
      const mine = choices.get(personId) ?? DEFAULT_CHOICES;
      const record = (rows: typeof everything, status: 'sent' | 'failed' | 'skipped', lastError: string | null) => this.db.insert(notificationDeliveries).values(rows.map((n) => ({
        tenantId: n.tenantId, notificationId: n.id, channel: 'email', status, attempts: 1, lastError, lastAttemptAt: now, sentAt: status === 'sent' ? now : null,
      }))).onConflictDoNothing();
      // what the person turned off (the summary, or this type of alert) is recorded as skipped, never emailed
      const wanted = mine.emailDigest ? everything.filter((n) => !mine.off.has(n.alertCode)) : [];
      const skipped = everything.filter((n) => !wanted.includes(n));
      if (skipped.length) await record(skipped, 'skipped', 'turned off by the person');
      const list = wanted;
      if (list.length === 0) continue;
      const to = await this.addressOf(this.db, personId);
      if (!to) { await record(list, 'failed', 'no email address'); continue; }
      const url = openLink(null, env);
      const lines = list.slice(0, DIGEST_MAX_LINES).map((n) => `- ${n.title}${n.body ? ` — ${n.body}` : ''}`);
      if (list.length > DIGEST_MAX_LINES) lines.push(`…and ${list.length - DIGEST_MAX_LINES} more.`);
      const text = [`You have ${list.length} alert${list.length === 1 ? '' : 's'} waiting:`, lines.join('\n'), url ? `Open them here: ${url}/#alerts` : null].filter(Boolean).join('\n\n');
      try {
        await sendMail({ to, subject: `[Ageless] ${list.length} alert${list.length === 1 ? '' : 's'} for you`, text }, env);
        await record(list, 'sent', null);
        out.people++; out.alerts += list.length;
      } catch (e) {
        this.log.warn(`digest for person ${personId} failed: ${mailFailure(e)}`);
        out.failed++;
      }
    }
    return out;
  }

  private mark(conn: Conn, id: number, v: { status: 'pending' | 'sent' | 'failed' | 'skipped'; attempts: number; lastError: string | null; sentAt?: Date }) {
    return conn.update(notificationDeliveries).set({ ...v, lastAttemptAt: new Date() }).where(eq(notificationDeliveries.id, id));
  }
}
