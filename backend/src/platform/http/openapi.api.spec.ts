import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ZodTypeAny } from 'zod';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { buildOpenApi, routesOf } from './openapi';

describe('OpenAPI document', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createTestApp(AppModule); });
  afterAll(async () => { await app?.close(); });

  it('every route is documented with @Doc (health checks excepted)', () => {
    const missing = routesOf(app).filter((r) => !r.doc && !r.path.endsWith('/health')).map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('builds a valid OpenAPI 3 document with request and answer shapes', () => {
    const doc = buildOpenApi(app);
    expect(doc.openapi).toBe('3.0.3');
    const apply = doc.paths['/api/hrms/leave/requests'].post!;
    expect(apply.requestBody).toBeDefined();
    expect(JSON.stringify(apply.responses['201'])).toContain('#/components/schemas/LeaveRequestView');
    expect(apply.security).toEqual([{ bearer: [] }]);
    expect(doc.paths['/api/auth/login'].post!.security).toEqual([]);
    expect(doc.paths['/api/hrms/employments/{publicId}'].patch!.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'publicId', in: 'path' })]));
    expect(doc.components!.schemas!.PersonDetail).toBeDefined();
  });

  it('real answers match the documented shapes', async () => {
    const hr = await signIn(app, DEMO.hr.login);
    const shapes = new Map(routesOf(app).filter((r) => r.doc?.response).map((r) => [`${r.method} ${r.path}`, r.doc!.response as ZodTypeAny]));
    const check = async (path: string, url: string) => {
      const res = await request(app.getHttpServer()).get(url).set(hr);
      expect(res.status).toBe(200);
      const parsed = shapes.get(`get ${path}`)!.safeParse(res.body);
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    };
    await check('/api/auth/me', '/api/auth/me');
    await check('/api/hrms/people', '/api/hrms/people?pageSize=5');
    await check('/api/hrms/people/{publicId}', `/api/hrms/people/${DEMO.supervisor.publicId}`);
    await check('/api/hrms/attendance/work-hours', '/api/hrms/attendance/work-hours?from=2026-10-01&to=2026-10-31');
    await check('/api/hrms/attendance/register', '/api/hrms/attendance/register?date=2026-10-06');
    await check('/api/hrms/leave/report', '/api/hrms/leave/report?from=2026-01-01&to=2026-12-31');
    await check('/api/hrms/expenses/report', '/api/hrms/expenses/report?from=2025-01-01&to=2025-12-31');
    await check('/api/hrms/calendar', `/api/hrms/calendar?employment=00000000-0000-4000-8000-000000000104&from=2026-11-01&to=2026-11-30`);
    await check('/api/hrms/departments', '/api/hrms/departments');
    await check('/api/core/policies', '/api/core/policies');
    await check('/api/hrms/skills/matrix', '/api/hrms/skills/matrix');
  });
});
