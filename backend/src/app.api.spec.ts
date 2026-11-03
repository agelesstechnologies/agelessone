import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Body, Controller, INestApplication, Module, Post } from '@nestjs/common';
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
    expect(res.body).toMatchObject({ code: 'VALIDATION', message: 'Invalid request body' });
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(['count', 'name']);
  });

  it('a request without a token is rejected with AUTH_MISSING', async () => {
    const res = await request(app.getHttpServer()).post('/api/test/echo').send({ name: 'a', count: 1 });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'AUTH_MISSING', message: expect.any(String) });
  });
});
