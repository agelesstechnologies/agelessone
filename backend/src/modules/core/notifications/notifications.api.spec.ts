import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { DB, Db } from '../../../platform/db/db.module';
import { CoreFacade } from '../core.facade';

type Auth = Record<string, string>;

describe('Alerts (CoreFacade.notify and the bell API)', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth;
  let pgc: pg.Client;
  let core: CoreFacade, db: Db;
  let hrId: number, adminId: number;
  const http = () => request(app.getHttpServer());
  const idOf = async (publicId: string) => Number((await pgc.query('SELECT id FROM core.persons WHERE public_id = $1', [publicId])).rows[0].id);
  const base = (dedupeKey: string) => ({ tenantId: 1, alertCode: 'tests.something_happened', title: 'Something happened', dedupeKey });

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    core = app.get(CoreFacade);
    db = app.get(DB);
    pgc = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgc.connect();
    [hrId, adminId] = await Promise.all([idOf(DEMO.hr.publicId), idOf(DEMO.admin.publicId)]);
  });
  afterAll(async () => { await pgc?.end(); await app?.close(); });

  it('the same alert for the same person is made once, however often it is sent', async () => {
    const key = `test:${randomUUID()}`;
    expect(await core.notify(db, { ...base(key), recipients: { personIds: [hrId] } })).toBe(1);
    expect(await core.notify(db, { ...base(key), recipients: { personIds: [hrId] } })).toBe(0);
    expect(await core.notify(db, { ...base(key), recipients: { personIds: [hrId, adminId] } })).toBe(1);   // only the new person
    const rows = await pgc.query('SELECT count(*)::int AS n FROM core.notifications WHERE dedupe_key = $1', [key]);
    expect(rows.rows[0].n).toBe(2);
    const deliveries = await pgc.query(`SELECT count(*)::int AS n FROM core.notification_deliveries d JOIN core.notifications n ON n.id = d.notification_id
      WHERE n.dedupe_key = $1 AND d.channel = 'in_app' AND d.status = 'sent'`, [key]);
    expect(deliveries.rows[0].n).toBe(2);
  });

  it('a role reaches everyone who holds it, and `except` leaves out the one who made the change', async () => {
    const key = `test:${randomUUID()}`;
    const got = await core.notify(db, { ...base(key), recipients: { roles: ['hr'] } });
    expect(got).toBeGreaterThanOrEqual(1);
    const hrGot = await pgc.query('SELECT 1 FROM core.notifications WHERE dedupe_key = $1 AND recipient_person_id = $2', [key, hrId]);
    expect(hrGot.rowCount).toBe(1);

    const key2 = `test:${randomUUID()}`;
    expect(await core.notify(db, { ...base(key2), recipients: { personIds: [hrId] }, except: [hrId] })).toBe(0);
    expect(await core.notify(db, { ...base(key2), recipients: { roles: [] } })).toBe(0);
  });

  it('a person sees only their own alerts, with an unread count; reading is theirs alone', async () => {
    const key = `test:${randomUUID()}`;
    await core.notify(db, { ...base(key), title: 'For HR only', link: 'approvals', urgency: 'urgent', recipients: { personIds: [hrId] } });

    const mine = await http().get('/api/core/notifications').set(hr);
    expect(mine.status).toBe(200);
    const item = mine.body.items.find((n: { title: string }) => n.title === 'For HR only');
    expect(item).toMatchObject({ alertCode: 'tests.something_happened', urgency: 'urgent', link: 'approvals', readAt: null });
    expect(mine.body.unreadCount).toBeGreaterThanOrEqual(1);

    const theirs = await http().get('/api/core/notifications').set(admin);
    expect(theirs.body.items.some((n: { title: string }) => n.title === 'For HR only')).toBe(false);

    const stolen = await http().post(`/api/core/notifications/${item.publicId}/read`).set(admin);
    expect([stolen.status, stolen.body]).toEqual([200, { marked: 0 }]);

    const read = await http().post(`/api/core/notifications/${item.publicId}/read`).set(hr);
    expect([read.status, read.body]).toEqual([200, { marked: 1 }]);
    expect((await http().post(`/api/core/notifications/${item.publicId}/read`).set(hr)).body).toEqual({ marked: 0 });

    const unread = await http().get('/api/core/notifications').query({ unread: 'true' }).set(hr);
    expect(unread.body.items.some((n: { publicId: string }) => n.publicId === item.publicId)).toBe(false);
  });

  it('read-all clears the unread count', async () => {
    await core.notify(db, { ...base(`test:${randomUUID()}`), recipients: { personIds: [adminId] } });
    const res = await http().post('/api/core/notifications/read-all').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.marked).toBeGreaterThanOrEqual(1);
    expect((await http().get('/api/core/notifications').set(admin)).body.unreadCount).toBe(0);
  });

  it('needs a sign-in', async () => {
    expect((await http().get('/api/core/notifications')).status).toBe(401);
  });
});
