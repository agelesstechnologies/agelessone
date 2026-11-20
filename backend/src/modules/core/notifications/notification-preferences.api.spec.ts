import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { ALERT_TYPES } from '@ageless/shared';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';
import { DB, Db } from '../../../platform/db/db.module';
import { sentMail } from '../../../platform/mailer';
import { CoreFacade } from '../core.facade';
import { NotificationEmailService } from './application/notification-email.service';

type Auth = Record<string, string>;
type Prefs = { emailUrgent: boolean; emailDigest: boolean; quietHours: { start: string; end: string } | null; types: { code: string; email: boolean }[] };

describe('Alert email choices', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth;
  let pgc: pg.Client;
  let core: CoreFacade, db: Db, email: NotificationEmailService;
  const http = () => request(app.getHttpServer());
  const idOf = async (publicId: string) => Number((await pgc.query('SELECT id FROM core.persons WHERE public_id = $1', [publicId])).rows[0].id);
  const prefs = async (auth: Auth) => (await http().get('/api/core/notifications/preferences').set(auth).expect(200)).body as Prefs;
  const save = (auth: Auth, body: Record<string, unknown>) => http().put('/api/core/notifications/preferences').set(auth).send(body);
  const mailsTo = (address: string, startsWith = '[Ageless]') => sentMail().filter((m) => m.to === address && m.subject.startsWith(startsWith));
  const alert = (personId: number, code: string, urgency: 'normal' | 'urgent', title: string) =>
    core.notify(db, { tenantId: 1, alertCode: code, urgency, title, dedupeKey: `test:${randomUUID()}`, recipients: { personIds: [personId] } });
  const status = async (title: string) => (await pgc.query(
    `SELECT d.status, d.last_error FROM core.notification_deliveries d JOIN core.notifications n ON n.id = d.notification_id
      WHERE n.title = $1 AND d.channel = 'email'`, [title])).rows[0] as { status: string; last_error: string | null } | undefined;
  const defaults = { emailUrgent: true, emailDigest: true, quietHours: null };

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    core = app.get(CoreFacade); db = app.get(DB); email = app.get(NotificationEmailService);
    pgc = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgc.connect();
  });
  afterAll(async () => { await pgc?.end(); await app?.close(); });

  it('a person with no saved choices has everything on; saving changes only their own, and unnamed types keep their choice', async () => {
    const [a, b]: Staff[] = await Promise.all([newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE'])]);
    const first = await prefs(a.auth);
    expect(first).toMatchObject(defaults);
    expect(first.types).toHaveLength(Object.keys(ALERT_TYPES).length);
    expect(first.types.every((t) => t.email)).toBe(true);

    const saved = await save(a.auth, { ...defaults, emailDigest: false, quietHours: { start: '22:00', end: '07:00' }, types: { 'tickets.assigned': false } }).expect(200);
    expect(saved.body).toMatchObject({ emailUrgent: true, emailDigest: false, quietHours: { start: '22:00', end: '07:00' } });
    expect(saved.body.types.find((t: { code: string }) => t.code === 'tickets.assigned').email).toBe(false);

    await save(a.auth, { ...defaults, emailDigest: false, quietHours: null, types: { 'hrms.leave_decided': false } }).expect(200);   // another type: the first stays off
    const after = await prefs(a.auth);
    expect(after.quietHours).toBeNull();
    expect(after.types.filter((t) => !t.email).map((t) => t.code).sort()).toEqual(['hrms.leave_decided', 'tickets.assigned']);
    await save(a.auth, { ...defaults, types: { 'tickets.assigned': true } }).expect(200);                                         // turned back on
    expect((await prefs(a.auth)).types.filter((t) => !t.email).map((t) => t.code)).toEqual(['hrms.leave_decided']);

    expect(await prefs(b.auth)).toMatchObject(defaults);                                                                          // nobody else is touched
    expect((await prefs(b.auth)).types.every((t) => t.email)).toBe(true);
  });

  it('refuses unknown alert types, times that are not HH:MM, an empty window, and a missing sign-in', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    expect((await save(s.auth, { ...defaults, types: { 'nothing.known': false } })).body.code).toBe('VALIDATION');
    expect((await save(s.auth, { ...defaults, quietHours: { start: '25:00', end: '07:00' } })).body.code).toBe('VALIDATION');
    expect((await save(s.auth, { ...defaults, quietHours: { start: '08:00', end: '08:00' } })).body.code).toBe('VALIDATION');
    expect((await http().get('/api/core/notifications/preferences')).status).toBe(401);
  });

  it('email off for a type, or for urgent emails, is skipped (the bell still has it); the others still go out', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const id = await idOf(s.personId);
    await save(s.auth, { ...defaults, types: { 'inventory.stock_difference': false } }).expect(200);
    const off = `Off ${randomUUID()}`, on = `On ${randomUUID()}`;
    await alert(id, 'inventory.stock_difference', 'urgent', off);
    await alert(id, 'hrms.request_escalated', 'urgent', on);
    const out = await email.sendPending();
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    expect(await status(off)).toMatchObject({ status: 'skipped', last_error: 'turned off by the person' });
    expect(mailsTo(s.login).some((m) => m.subject.includes(off))).toBe(false);
    expect(mailsTo(s.login).some((m) => m.subject.includes(on))).toBe(true);
    const inBell = (await http().get('/api/core/notifications?limit=100').set(s.auth).expect(200)).body.items as { title: string }[];
    expect(inBell.some((n) => n.title === off)).toBe(true);

    await save(s.auth, { ...defaults, emailUrgent: false }).expect(200);
    const none = `None ${randomUUID()}`;
    await alert(id, 'hrms.request_escalated', 'urgent', none);
    await email.sendPending();
    expect(await status(none)).toMatchObject({ status: 'skipped' });
    expect(mailsTo(s.login).some((m) => m.subject.includes(none))).toBe(false);
  });

  it('quiet hours hold an urgent email until they end', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    await save(s.auth, { ...defaults, quietHours: { start: '22:00', end: '07:00' } }).expect(200);
    const title = `Quiet ${randomUUID()}`;
    await alert(await idOf(s.personId), 'hrms.request_escalated', 'urgent', title);

    const night = new Date('2026-11-19T20:00:00Z');                        // 01:30 IST
    expect((await email.sendPending(200, process.env, night)).held).toBeGreaterThanOrEqual(1);
    expect(await status(title)).toMatchObject({ status: 'pending' });
    expect(mailsTo(s.login).some((m) => m.subject.includes(title))).toBe(false);

    await email.sendPending(200, process.env, new Date('2026-11-19T06:30:00Z'));   // 12:00 IST: the window is over
    expect(await status(title)).toMatchObject({ status: 'sent' });
    expect(mailsTo(s.login).some((m) => m.subject.includes(title))).toBe(true);
  });

  it('the morning summary leaves out what the person turned off, and is not sent at all when they turned it off', async () => {
    const [kept, noSummary] = await Promise.all([newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE'])]);
    const tag = randomUUID().slice(0, 8);
    await save(kept.auth, { ...defaults, types: { 'tickets.assigned': false } }).expect(200);
    await save(noSummary.auth, { ...defaults, emailDigest: false }).expect(200);
    for (const s of [kept, noSummary]) {
      await alert(await idOf(s.personId), 'tickets.assigned', 'normal', `Assigned ${tag}`);
      await alert(await idOf(s.personId), 'hrms.leave_decided', 'normal', `Leave ${tag}`);
    }
    await email.sendDigests();

    const summary = mailsTo(kept.login, '[Ageless] 1 alert');
    expect(summary).toHaveLength(1);
    expect(summary[0].text).toContain(`Leave ${tag}`);
    expect(summary[0].text).not.toContain(`Assigned ${tag}`);
    expect(mailsTo(noSummary.login).some((m) => m.subject.endsWith('for you'))).toBe(false);

    const rows = (await pgc.query(`SELECT n.title, d.status FROM core.notification_deliveries d JOIN core.notifications n ON n.id = d.notification_id
      WHERE d.channel = 'email' AND n.title LIKE $1 ORDER BY n.recipient_person_id, n.title`, [`%${tag}`])).rows as { title: string; status: string }[];
    expect(rows.map((r) => r.status).sort()).toEqual(['sent', 'skipped', 'skipped', 'skipped']);
  });

  it('every alertCode the code makes is in the catalog people choose from', () => {
    const files = (readdirSync(join(__dirname, '../../..'), { recursive: true }) as string[]).filter((f) => /\.ts$/.test(f) && !/\.spec\.ts$/.test(f));
    const used = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(join(__dirname, '../../..', f), 'utf8').matchAll(/alertCode: '([a-z_.]+)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((c) => !(c in ALERT_TYPES))).toEqual([]);
    // and the catalog holds nothing that is never made
    expect(Object.keys(ALERT_TYPES).filter((c) => !used.has(c))).toEqual([]);
  });
});
