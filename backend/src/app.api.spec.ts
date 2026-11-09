import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Body, Controller, Get, INestApplication, Module, Post } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';
import { AppModule } from './app.module';
import { ZodValidationPipe } from './platform/http/zod-validation.pipe';
import { SignedIn } from './platform/http/request-context';
import { createTestApp, DEMO, signIn } from './test/create-app';

// A test-only endpoint, so the validation format is checked without depending on a business endpoint.
const Echo = z.object({ name: z.string().min(1), count: z.number().int() });
@Controller('test/echo')
class EchoController {
  @SignedIn() @Post() echo(@Body(new ZodValidationPipe(Echo)) body: z.infer<typeof Echo>) { return body; }
  // errors as the database driver throws them (Drizzle wraps the pg error in cause), and an unknown bug
  @SignedIn() @Get('duplicate') duplicate() { throw Object.assign(new Error('query failed'), { cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', constraint: 'uq_people_login_phone', detail: 'Key (login_phone)=(+910000000099) already exists.' }) }); }
  @SignedIn() @Get('trigger') trigger() { throw Object.assign(new Error('HRMS_PUNCH_ORDER: punch in refused, the punch before it is also in'), { code: 'P0001' }); }
  @SignedIn() @Get('bug') bug() { throw new TypeError("Cannot read properties of undefined (reading 'x')"); }
}
@Module({ imports: [AppModule], controllers: [EchoController] })
class TestAppModule {}

describe('API basics', () => {
  let app: INestApplication;
  let callerHeaders: Record<string, string>;
  beforeAll(async () => { app = await createTestApp(TestAppModule); callerHeaders = await signIn(app, DEMO.technician.login); });
  afterAll(async () => { await app?.close(); });

  it('health endpoint answers without caller headers', async () => {
    const res = await request(app.getHttpServer()).get('/api/hrms/attendance/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ module: 'hrms', sub: 'attendance', ok: true });
  });

  it('bad input returns 400 in the shared error format', async () => {
    const res = await request(app.getHttpServer()).post('/api/test/echo').set(callerHeaders).send({ name: '', count: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION', message: 'Name is required. Count must be a number' });
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(['count', 'name']);
  });

  it('a request without a token is rejected with AUTH_MISSING', async () => {
    const res = await request(app.getHttpServer()).post('/api/test/echo').send({ name: 'a', count: 1 });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'AUTH_MISSING', message: expect.any(String) });
  });
});

describe('Error answers a person can act on', () => {
  let app: INestApplication;
  let auth: Record<string, string>;
  const http = () => request(app.getHttpServer());
  beforeAll(async () => { app = await createTestApp(TestAppModule); auth = await signIn(app, DEMO.technician.login); });
  afterAll(async () => { await app?.close(); });

  it('validation names each field in plain words', async () => {
    const res = await http().post('/api/test/echo').set(auth).send({ count: 1.5 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Name is required. Count must be a whole number');
    expect(res.body.details).toEqual(expect.arrayContaining([{ path: 'name', field: 'Name', message: 'Name is required' }]));
  });

  it('malformed JSON is a 400, not a server error', async () => {
    const res = await http().post('/api/test/echo').set(auth).set('Content-Type', 'application/json').send('{"name": ');
    expect([res.status, res.body.code]).toEqual([400, 'BAD_JSON']);
  });

  it('an unknown address says so', async () => {
    const res = await http().get('/api/no-such-thing').set(auth);
    expect([res.status, res.body.code]).toEqual([404, 'NOT_FOUND']);
    expect(res.body.message).toContain('does not exist');
  });

  it('a duplicate in the database is a 409 that never repeats the stored value', async () => {
    const res = await http().get('/api/test/echo/duplicate').set(auth);
    expect([res.status, res.body.code]).toEqual([409, 'DUPLICATE']);
    expect(res.body.message).toContain('already exists');
    expect(JSON.stringify(res.body)).not.toContain('+910000000099');
  });

  it('our own database rules answer with their code and message', async () => {
    const res = await http().get('/api/test/echo/trigger').set(auth);
    expect(res.body).toEqual({ code: 'HRMS_PUNCH_ORDER', message: 'Punch in refused, the punch before it is also in.' });
    expect(res.status).toBe(409);
  });

  it('an unknown bug is a 500 with a reference to find it in the server log, and no internals', async () => {
    const res = await http().get('/api/test/echo/bug').set(auth);
    expect([res.status, res.body.code]).toEqual([500, 'INTERNAL']);
    expect(res.body.details.reference).toMatch(/^[0-9a-f]{8}$/);
    expect(res.body.message).toContain(res.body.details.reference);
    expect(res.body.message).not.toContain('Cannot read');
  });
});
