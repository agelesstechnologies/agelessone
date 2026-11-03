import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { peopleApi, SUPERVISOR } from '../../../test/people';

interface Job { publicId: string; company: { code: string }; status: string; isPrimary: boolean; exitOn: string | null; exitReason: string | null }
const job = (person: { employments: Job[] }, company: string) => person.employments.find((e) => e.company.code === company)!;

describe('HRMS employments API', () => {
  let app: INestApplication;
  let api: ReturnType<typeof peopleApi>;
  let callerHeaders: Record<string, string>; // signed in as Demo HR
  const patch = (id: string, body: object) => api.http().patch(`/api/hrms/employments/${id}`).set(callerHeaders).send(body);
  const exit = (id: string, body: object) => api.http().post(`/api/hrms/employments/${id}/exit`).set(callerHeaders).send(body);

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    callerHeaders = await signIn(app, DEMO.hr.login);
    api = peopleApi(app, callerHeaders);
  });
  afterAll(async () => { await app?.close(); });

  it('adds an employment in another company; the first one stays primary', async () => {
    const p = await api.createPerson({ company: 'AE' });
    expect((await api.addEmployment(p, 'ATPL')).status).toBe(201);
    const person = await api.get(p);
    expect(job(person, 'AE')).toMatchObject({ status: 'active', isPrimary: true });
    expect(job(person, 'ATPL')).toMatchObject({ status: 'active', isPrimary: false });
  });

  it('exiting one company keeps the other active, and primary moves to it', async () => {
    const p = await api.createPerson({ company: 'AE' });
    await api.addEmployment(p, 'ATPL');
    const res = await exit(await api.employmentIn(p, 'AE'), { exitOn: '2026-06-30', exitReason: 'Moved to ATPL full time' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(job(res.body, 'AE')).toMatchObject({ status: 'exited', isPrimary: false, exitOn: '2026-06-30', exitReason: 'Moved to ATPL full time' });
    expect(job(res.body, 'ATPL')).toMatchObject({ status: 'active', isPrimary: true });
  });

  it('exiting the last active employment makes the person inactive (the record is kept)', async () => {
    const p = await api.createPerson({ company: 'ATPL' });
    const res = await exit(await api.employmentIn(p, 'ATPL'), { exitOn: '2026-03-31', exitReason: 'Resigned' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('inactive');
    expect(res.body.employments).toHaveLength(1);
    expect(job(res.body, 'ATPL')).toMatchObject({ status: 'exited', isPrimary: true, exitReason: 'Resigned' });
  });

  it('making an employment primary removes primary from the other one', async () => {
    const p = await api.createPerson({ company: 'AE' });
    await api.addEmployment(p, 'ATPL');
    const res = await patch(await api.employmentIn(p, 'ATPL'), { isPrimary: true });
    expect(res.status).toBe(200);
    expect(job(res.body, 'ATPL').isPrimary).toBe(true);
    expect(job(res.body, 'AE').isPrimary).toBe(false);
  });

  it('changes manager, department and designation; a person cannot manage themselves', async () => {
    const p = await api.createPerson({ company: 'AE' });
    const ae = await api.employmentIn(p, 'AE');
    const res = await patch(ae, { managerPublicId: SUPERVISOR, department: 'Service', designation: 'Senior Technician' });
    expect(res.status).toBe(200);
    expect(job(res.body, 'AE')).toMatchObject({ department: 'Service', designation: 'Senior Technician', manager: { publicId: SUPERVISOR, displayName: 'Demo Supervisor' } });

    const self = await patch(ae, { managerPublicId: p });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('HRMS_SELF_MANAGER');

    const cleared = await patch(ae, { managerPublicId: null });
    expect(job(cleared.body, 'AE')).toMatchObject({ manager: null, department: 'Service' });
  });

  it('refuses an exit before joining, a second exit, and making an exited employment primary', async () => {
    const p = await api.createPerson({ company: 'AE', joinedOn: '2026-01-05' });
    await api.addEmployment(p, 'ATPL');
    const ae = await api.employmentIn(p, 'AE');

    const early = await exit(ae, { exitOn: '2025-12-31', exitReason: 'Wrong date' });
    expect(early.status).toBe(400);
    expect(early.body.code).toBe('HRMS_EXIT_BEFORE_JOIN');

    expect((await exit(ae, { exitOn: '2026-04-30', exitReason: 'Contract ended' })).status).toBe(200);
    const twice = await exit(ae, { exitOn: '2026-05-31', exitReason: 'Contract ended' });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('HRMS_EMPLOYMENT_NOT_ACTIVE');

    const primary = await patch(ae, { isPrimary: true });
    expect(primary.status).toBe(409);
    expect(primary.body.code).toBe('HRMS_EMPLOYMENT_NOT_ACTIVE');
    expect(job(await api.get(p), 'ATPL').isPrimary).toBe(true); // unchanged by the refused request
  });
});
