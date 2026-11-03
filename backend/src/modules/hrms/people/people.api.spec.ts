import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { callerHeaders, createTestApp } from '../../../test/create-app';

// Fictional data only. Names and codes get a unique suffix so tests never collide.
const SUPERVISOR = '00000000-0000-4000-8000-000000000001'; // seeded 'Demo Supervisor'
const tag = () => randomUUID().slice(0, 8).toUpperCase();
const newPerson = (t: string, over: { phone?: string; company?: string; code?: string } = {}) => ({
  displayName: `Test Person ${t}`,
  contacts: [{ kind: 'phone', value: over.phone ?? '+91 00000 00000', label: 'personal' }, { kind: 'email', value: `test.${t}@example.com` }],
  employment: { legalEntityCode: over.company ?? 'AE', employeeCode: over.code ?? `T-${t}`, engagementType: 'permanent', joinedOn: '2026-01-05', designation: 'Technician', managerPublicId: SUPERVISOR },
});

describe('HRMS people API', () => {
  let app: INestApplication;
  const api = () => request(app.getHttpServer());
  const create = (body: object) => api().post('/api/hrms/people').set(callerHeaders).send(body);

  beforeAll(async () => { app = await createTestApp(AppModule); });
  afterAll(async () => { await app?.close(); });

  it('creates a person with contacts and a first employment', async () => {
    const res = await create(newPerson(tag()));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ publicId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('allows the same phone number for two different people', async () => {
    const phone = '+91 00000 22222';
    const a = await create(newPerson(tag(), { phone }));
    const b = await create(newPerson(tag(), { phone }));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.publicId).not.toBe(b.body.publicId);
  });

  it('refuses a second active employment in the same company', async () => {
    const { body } = await create(newPerson(tag(), { company: 'AE' }));
    const again = await api().post(`/api/hrms/people/${body.publicId}/employments`).set(callerHeaders)
      .send({ legalEntityCode: 'AE', employeeCode: `T-${tag()}`, engagementType: 'contract', joinedOn: '2026-02-01' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('HRMS_DUPLICATE_EMPLOYMENT');

    const otherCompany = await api().post(`/api/hrms/people/${body.publicId}/employments`).set(callerHeaders)
      .send({ legalEntityCode: 'ATPL', employeeCode: `T-${tag()}`, engagementType: 'contract', joinedOn: '2026-02-01' });
    expect(otherCompany.status).toBe(201);
  });

  it('refuses an employee code already used in the company, and saves nothing', async () => {
    const code = `T-${tag()}`;
    expect((await create(newPerson(tag(), { company: 'ATPL', code }))).status).toBe(201);
    const t = tag();
    const dup = await create(newPerson(t, { company: 'ATPL', code }));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('HRMS_DUPLICATE_EMPLOYEE_CODE');
    const search = await api().get('/api/hrms/people').query({ search: `Test Person ${t}` }).set(callerHeaders);
    expect(search.body.total).toBe(0); // the person row was rolled back with the employment
  });

  it('searches by name and by phone (any formatting)', async () => {
    const t = tag();
    const { body: created } = await create(newPerson(t, { phone: '+91 00000 33333' }));
    const byName = await api().get('/api/hrms/people').query({ search: `person ${t.toLowerCase()}` }).set(callerHeaders);
    expect(byName.status).toBe(200);
    expect(byName.body.items.map((p: { publicId: string }) => p.publicId)).toEqual([created.publicId]);
    expect(byName.body.items[0].primaryEmployment).toMatchObject({ company: 'AE', employeeCode: `T-${t}` });

    const byPhone = await api().get('/api/hrms/people').query({ search: '00000-33333' }).set(callerHeaders);
    expect(byPhone.body.items.map((p: { publicId: string }) => p.publicId)).toContain(created.publicId);
  });

  it('shows a person with contacts and employments, without internal ids', async () => {
    const t = tag();
    const { body: created } = await create(newPerson(t));
    const res = await api().get(`/api/hrms/people/${created.publicId}`).set(callerHeaders);
    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'phone', value: '+910000000000', label: 'personal', isPrimary: true, endedAt: null }),
      expect.objectContaining({ kind: 'email', value: `test.${t.toLowerCase()}@example.com`, isPrimary: true }),
    ]));
    expect(res.body.employments).toEqual([expect.objectContaining({
      company: { code: 'AE', name: 'Ageless Entertainments' }, employeeCode: `T-${t}`, engagementType: 'permanent',
      status: 'active', isPrimary: true, designation: 'Technician', manager: { publicId: SUPERVISOR, displayName: 'Demo Supervisor' },
    })]);
    expect(JSON.stringify(res.body)).not.toMatch(/"id"|personId|legalEntityId|managerPersonId/);
  });
});
