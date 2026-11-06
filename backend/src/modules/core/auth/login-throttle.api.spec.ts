import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';
import { tag } from '../../../test/people';
import { throttleKey } from './domain/throttle';

type Auth = Record<string, string>;
const PASSWORD = 'first-pass-1';   // newStaff's password

describe('Sign-in limits: per account and per IP, brief lockout', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth;
  let ipCount = 0;
  /** A made-up address from the documentation range, new for every test, so tests never share an IP count. */
  const freshIp = () => `198.51.100.${++ipCount}`;
  const http = () => request(app.getHttpServer());
  const login = (login: string, password: string, ip: string) => http().post('/api/auth/login').set('X-Forwarded-For', ip).send({ login, password });
  /** Ends a lockout early (instead of waiting 15 minutes). */
  const expire = (kind: 'login' | 'ip', value: string) => db.query(
    `UPDATE core.login_throttle SET locked_until = now() - interval '1 second' WHERE key = $1`, [throttleKey(kind, value, process.env.JWT_SECRET!)]);

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }, 60_000);
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('five wrong passwords lock the account: the fifth and every try after answer 429, even with the right password', async () => {
    const s: Staff = await newStaff(app, hr, admin, ['AE']);
    const ip = freshIp();
    for (let i = 1; i <= 4; i++) {
      const r = await login(s.login, 'wrong-pass-1', ip);
      expect([r.status, r.body.code]).toEqual([401, 'AUTH_FAILED']);
    }
    const fifth = await login(s.login, 'wrong-pass-1', ip);
    expect([fifth.status, fifth.body.code, fifth.body.message]).toEqual([429, 'AUTH_LOCKED', 'Too many failed sign-ins. Try again in 15 minutes.']);
    expect(fifth.body.details.retryAfterSeconds).toBe(900);
    expect(fifth.headers['retry-after']).toBe('900');

    const right = await login(s.login, PASSWORD, freshIp());          // from another address too: the account is locked
    expect([right.status, right.body.code]).toEqual([429, 'AUTH_LOCKED']);
    const otherCase = await login(s.login.toUpperCase(), PASSWORD, freshIp()); // the same login in another form counts as the same account
    expect(otherCase.status).toBe(429);
    expect((await login(DEMO.engineer.login, 'demo-pass-1', ip)).status).toBe(200); // another account from the same address still signs in

    await expire('login', s.login);
    expect((await login(s.login, PASSWORD, ip)).status).toBe(200);
    // a successful sign-in starts the count again: four more failures are only 401
    for (let i = 1; i <= 4; i++) expect((await login(s.login, 'wrong-pass-1', ip)).status).toBe(401);
  });

  it('an unknown login locks the same way, so nothing tells whether an account exists', async () => {
    const ip = freshIp();
    const nobody = `nobody.${tag().toLowerCase()}@example.com`;
    const answers = [];
    for (let i = 1; i <= 5; i++) answers.push((await login(nobody, 'wrong-pass-1', ip)).status);
    expect(answers).toEqual([401, 401, 401, 401, 429]);
  });

  it('too many failures from one IP address lock that address for every account', async () => {
    const before = process.env.LOGIN_MAX_FAILURES_PER_IP;
    process.env.LOGIN_MAX_FAILURES_PER_IP = '3';
    try {
      const ip = freshIp();
      const people = await Promise.all([1, 2, 3].map(() => newStaff(app, hr, admin, ['AE'])));
      expect((await login(people[0].login, 'wrong-pass-1', ip)).status).toBe(401);
      expect((await login(people[1].login, 'wrong-pass-1', ip)).status).toBe(401);
      const third = await login(people[2].login, 'wrong-pass-1', ip);
      expect([third.status, third.body.code]).toEqual([429, 'AUTH_LOCKED']);
      expect((await login(DEMO.engineer.login, 'demo-pass-1', ip)).status).toBe(429);     // right password, locked address
      expect((await login(DEMO.engineer.login, 'demo-pass-1', freshIp())).status).toBe(200); // another address is fine
      await expire('ip', ip);
      expect((await login(DEMO.engineer.login, 'demo-pass-1', ip)).status).toBe(200);
    } finally {
      if (before === undefined) delete process.env.LOGIN_MAX_FAILURES_PER_IP; else process.env.LOGIN_MAX_FAILURES_PER_IP = before;
    }
  });

  it('a password reset by a login manager lifts the account lockout; nothing stores the login itself', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const ip = freshIp();
    for (let i = 1; i <= 5; i++) await login(s.login, 'wrong-pass-1', ip);
    expect((await login(s.login, PASSWORD, ip)).status).toBe(429);
    const me = (await http().get('/api/auth/me').set(s.auth)).body;   // the token from before still works
    await http().post(`/api/core/users/${me.user.publicId}/reset-password`).set(admin).send({ newPassword: 'second-pass-2' }).expect(204);
    expect((await login(s.login, 'second-pass-2', ip)).status).toBe(200);

    const { rows } = await db.query(`SELECT key FROM core.login_throttle WHERE key LIKE '%example%' OR key LIKE '%198.51%'`);
    expect(rows).toEqual([]);
  });
});
