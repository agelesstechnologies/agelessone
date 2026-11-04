import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';

type Auth = Record<string, string>;
// core.auth.session_hours is read for the group only (sign-in), so company versions and far-future dates affect no other test.
const KEY = 'core.auth.session_hours';

describe('Core policies API', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, tech: Auth;
  let db: pg.Client;
  const http = () => request(app.getHttpServer());
  const post = (body: Record<string, unknown>, auth = hr) => http().post('/api/core/policies').set(auth).send({ key: KEY, ...body });
  const valueOn = async (date: string, company?: string) =>
    (await http().get('/api/core/policies/in-force').query({ key: KEY, date, ...(company ? { company } : {}) }).set(hr)).body.value;

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, tech] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.technician].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('the seeded group default is in force; before any version the built-in default applies', async () => {
    const res = await http().get('/api/core/policies/in-force').query({ key: KEY, date: '2026-01-15' }).set(hr);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: KEY, company: null, value: 12, source: { version: 1, company: null, effectiveFrom: '2025-04-01' } });
    const before = await http().get('/api/core/policies/in-force').query({ key: KEY, date: '2020-01-01' }).set(hr);
    expect(before.body).toMatchObject({ value: 12, source: null });
  });

  it('a new version takes effect on its date; the company\'s own version comes before the group default', async () => {
    const id = randomUUID();
    const v1 = await post({ publicId: id, company: 'AE', value: 10, effectiveFrom: '2031-01-01' });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ publicId: id, key: KEY, company: 'AE', value: 10, version: 1, approvedBy: { publicId: DEMO.hr.publicId } });
    const again = await post({ publicId: id, company: 'AE', value: 10, effectiveFrom: '2031-01-01' });
    expect([again.status, again.body]).toEqual([200, v1.body]);

    expect(await valueOn('2030-12-31', 'AE')).toBe(12);   // AE's version not in force yet: group default
    expect(await valueOn('2031-01-01', 'AE')).toBe(10);
    expect(await valueOn('2031-01-01', 'ATPL')).toBe(12); // other company: group default

    expect((await post({ company: 'AE', value: 9, effectiveFrom: '2031-06-01' })).body.version).toBe(2);
    expect(await valueOn('2031-03-01', 'AE')).toBe(10);
    expect(await valueOn('2031-07-01', 'AE')).toBe(9);

    // a newer group version changes the group, not a company with its own version
    expect((await post({ value: 24, effectiveFrom: '2035-01-01' }, admin)).body).toMatchObject({ company: null, version: 2 });
    expect(await valueOn('2035-02-01', 'ATPL')).toBe(24);
    expect(await valueOn('2035-02-01', 'AE')).toBe(9);

    const list = await http().get('/api/core/policies').query({ key: KEY, company: 'AE' }).set(hr);
    expect(list.body.map((p: { version: number; value: number }) => [p.version, p.value])).toEqual([[2, 9], [1, 10]]);
  });

  it('refuses a value of the wrong shape, an unknown key, and people without the permission', async () => {
    expect((await post({ value: 'twelve', effectiveFrom: '2031-01-01' })).status).toBe(400);
    expect((await post({ key: 'hrms.no_such_policy', value: 1, effectiveFrom: '2031-01-01' })).status).toBe(400);
    expect((await http().post('/api/core/policies').set(hr).send({ key: 'hrms.leave.balance_check', value: 1, effectiveFrom: '2031-01-01' })).status).toBe(400);
    expect((await post({ value: 8, effectiveFrom: '2031-01-01' }, tech)).status).toBe(403);
    expect((await http().get('/api/core/policies').set(tech)).status).toBe(403);
    expect((await http().get('/api/core/policies').set(admin)).status).toBe(200);
  });

  it('a stored version can never be changed or deleted', async () => {
    const v = await post({ company: 'ATPL', value: 11, effectiveFrom: '2032-01-01' });
    await expect(db.query(`UPDATE core.policies SET value = '5' WHERE public_id = $1`, [v.body.publicId])).rejects.toThrow(/CORE_POLICY_APPEND_ONLY/);
    await expect(db.query('DELETE FROM core.policies WHERE public_id = $1', [v.body.publicId])).rejects.toThrow(/CORE_POLICY_APPEND_ONLY/);
  });
});
