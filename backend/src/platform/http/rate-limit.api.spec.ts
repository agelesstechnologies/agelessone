import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';

describe('Rate limit', () => {
  let app: INestApplication;
  let auth: Record<string, string>, other: Record<string, string>;
  const old = { u: process.env.RATE_LIMIT_PER_MIN, i: process.env.RATE_LIMIT_IP_PER_MIN, l: process.env.RATE_LIMIT_LOGIN_PER_MIN };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    auth = await signIn(app, DEMO.hr.login);
    other = await signIn(app, DEMO.admin.login);
  });
  afterAll(async () => {
    process.env.RATE_LIMIT_PER_MIN = old.u; process.env.RATE_LIMIT_IP_PER_MIN = old.i; process.env.RATE_LIMIT_LOGIN_PER_MIN = old.l;
    await app.close();
  });

  it('answers 429 RATE_LIMITED with Retry-After over the per-person limit; another person is not affected', async () => {
    process.env.RATE_LIMIT_PER_MIN = '3';
    for (let i = 0; i < 3; i++) expect((await http().get('/api/auth/me').set(auth)).status).toBe(200);
    const res = await http().get('/api/auth/me').set(auth);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await http().get('/api/auth/me').set(other)).status).toBe(200);
  });

  it('does not count /health routes', async () => {
    process.env.RATE_LIMIT_PER_MIN = '1';
    for (let i = 0; i < 5; i++) expect((await http().get('/api/hrms/attendance/health')).status).toBe(200);
  });

  it('limits sign-in attempts per IP address', async () => {
    process.env.RATE_LIMIT_PER_MIN = '100000'; process.env.RATE_LIMIT_LOGIN_PER_MIN = '2';
    const ip = '198.51.100.201';
    const go = () => http().post('/api/auth/login').set('X-Forwarded-For', ip).send({ login: 'nobody@example.com', password: 'wrong-pass-1' });
    expect((await go()).status).not.toBe(429);
    expect((await go()).status).not.toBe(429);
    expect((await go()).body.code).toBe('RATE_LIMITED');
  });
});
