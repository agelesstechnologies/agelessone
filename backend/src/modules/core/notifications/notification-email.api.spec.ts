import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';
import { DB, Db } from '../../../platform/db/db.module';
import { sentMail } from '../../../platform/mailer';
import { CoreFacade } from '../core.facade';
import { NotificationEmailService } from './application/notification-email.service';

type Auth = Record<string, string>;

describe('Alert emails (urgent at once, the rest in a morning summary)', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth;
  let pgc: pg.Client;
  let core: CoreFacade, db: Db, email: NotificationEmailService;
  const http = () => request(app.getHttpServer());
  const idOf = async (publicId: string) => Number((await pgc.query('SELECT id FROM core.persons WHERE public_id = $1', [publicId])).rows[0].id);
  const mailsTo = (address: string) => sentMail().filter((m) => m.to === address);
  const alert = (personId: number, urgency: 'normal' | 'urgent', title: string) =>
    core.notify(db, { tenantId: 1, alertCode: 'tests.email', urgency, title, body: 'Details here', link: 'approvals', dedupeKey: `test:${randomUUID()}`, recipients: { personIds: [personId] } });
  const delivery = async (title: string, channel: string) => (await pgc.query(
    `SELECT d.status, d.attempts, d.last_error FROM core.notification_deliveries d JOIN core.notifications n ON n.id = d.notification_id
      WHERE n.title = $1 AND d.channel = $2`, [title, channel])).rows[0] as { status: string; attempts: number; last_error: string | null } | undefined;

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    core = app.get(CoreFacade); db = app.get(DB); email = app.get(NotificationEmailService);
    pgc = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgc.connect();
  });
  afterAll(async () => { await pgc?.end(); await app?.close(); });

  it('an urgent alert is emailed once; a normal one makes no email delivery until the summary', async () => {
    const s: Staff = await newStaff(app, hr, admin, ['AE']);
    const id = await idOf(s.personId);
    const title = `Urgent ${randomUUID()}`;
    await alert(id, 'urgent', title);
    await alert(id, 'normal', `Normal ${title}`);
    expect(await delivery(title, 'email')).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await delivery(`Normal ${title}`, 'email')).toBeUndefined();

    await email.sendPending(500);
    const mail = mailsTo(s.login).find((m) => m.subject === `[Ageless] ${title}`);
    expect(mail?.text).toContain('Details here');
    expect(mailsTo(s.login).some((m) => m.subject.includes('Normal'))).toBe(false);
    expect(await delivery(title, 'email')).toMatchObject({ status: 'sent', attempts: 1, last_error: null });

    const before = mailsTo(s.login).length;
    await email.sendPending(500);                                           // nothing left to send: no second email
    expect(mailsTo(s.login)).toHaveLength(before);
  });

  it('the morning summary: one email with what is still unread; read alerts and already-emailed ones are left out; run twice sends once', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const id = await idOf(s.personId);
    const tag = randomUUID().slice(0, 8);
    await alert(id, 'normal', `Alpha ${tag}`);
    await alert(id, 'normal', `Beta ${tag}`);
    await alert(id, 'normal', `Read ${tag}`);
    await alert(id, 'urgent', `Urgent ${tag}`);
    const mine = (await http().get('/api/core/notifications').set(s.auth).expect(200)).body.items as { publicId: string; title: string }[];
    await http().post(`/api/core/notifications/${mine.find((n) => n.title === `Read ${tag}`)!.publicId}/read`).set(s.auth).expect(200);
    await email.sendPending(500);                                            // the urgent one goes now, not in the summary

    const out = await email.sendDigests();
    expect(out.failed).toBe(0);
    const summary = mailsTo(s.login).filter((m) => m.subject.endsWith('alerts for you'));
    expect(summary).toHaveLength(1);
    expect(summary[0].subject).toBe('[Ageless] 2 alerts for you');
    expect(summary[0].text).toContain(`Alpha ${tag}`);
    expect(summary[0].text).toContain(`Beta ${tag}`);
    expect(summary[0].text).not.toContain(`Read ${tag}`);
    expect(summary[0].text).not.toContain(`Urgent ${tag}`);
    expect(await delivery(`Alpha ${tag}`, 'email')).toMatchObject({ status: 'sent' });

    await email.sendDigests();                                              // the same alerts are not summarised again
    expect(mailsTo(s.login).filter((m) => m.subject.endsWith('alerts for you'))).toHaveLength(1);
  });

  it('a failed send is tried again later, not at once, and the reason holds no address', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const title = `Retry ${randomUUID()}`;
    await alert(await idOf(s.personId), 'urgent', title);
    const broken = { ...process.env, EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: '', MAIL_FROM: 'x@example.com' };

    const first = await email.sendPending(500, broken);
    expect(first.retrying).toBeGreaterThanOrEqual(1);
    const row = await delivery(title, 'email');
    expect(row).toMatchObject({ status: 'pending', attempts: 1 });
    expect(row?.last_error).toBeTruthy();
    expect(row?.last_error).not.toContain('@');

    expect((await email.sendPending(500, broken)).retrying).toBe(0);         // waits attempts × 5 minutes before the next try
    expect(await delivery(title, 'email')).toMatchObject({ status: 'pending', attempts: 1 });

    await pgc.query(`UPDATE core.notification_deliveries SET last_attempt_at = now() - interval '10 minutes'
      WHERE notification_id = (SELECT id FROM core.notifications WHERE title = $1)`, [title]);
    await email.sendPending(500);                                            // the real (test) provider works: now it goes out
    expect(await delivery(title, 'email')).toMatchObject({ status: 'sent', attempts: 2 });
    expect(mailsTo(s.login).some((m) => m.subject === `[Ageless] ${title}`)).toBe(true);
  });
});
