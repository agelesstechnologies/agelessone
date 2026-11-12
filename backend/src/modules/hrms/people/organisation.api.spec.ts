import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { fakePhone, tag } from '../../../test/people';
import { finishFirstLogin } from '../../../test/staff';

type Auth = Record<string, string>;
const PDF = Buffer.from('%PDF-1.4\n% offer letter\n');

describe('HRMS Ageless Technologies setup: departments, codes, joining, positions', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, tech: Auth;
  const http = () => request(app.getHttpServer());
  /** A new ATPL person; returns the person and their job. */
  const hire = async (employment: Record<string, unknown>) => {
    const res = await http().post('/api/hrms/people').set(hr).send({
      displayName: `Test Person ${tag()}`, contacts: [{ kind: 'phone', value: fakePhone() }],
      employment: { legalEntityCode: 'ATPL', engagementType: 'permanent', joinedOn: '2026-04-01', ...employment },
    });
    if (res.status !== 201) return { res, person: undefined as never, job: undefined as never };
    const person = (await http().get(`/api/hrms/people/${res.body.publicId}`).set(hr)).body;
    return { res, person, job: person.employments[0] };
  };

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, tech] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.technician].map((d) => signIn(app, d.login)));
  });
  afterAll(async () => { await app?.close(); });

  it('lists the ATPL departments and designations', async () => {
    const deps = (await http().get('/api/hrms/departments').query({ company: 'ATPL' }).set(tech)).body;
    expect(deps.map((d: { codePrefix: string }) => d.codePrefix).sort()).toEqual(['ATC', 'ATD', 'ATH', 'ATHR', 'ATS']);
    const titles = (await http().get('/api/hrms/designations').query({ company: 'ATPL' }).set(tech)).body;
    expect(titles).toHaveLength(13);
  });

  it('employee codes are generated per prefix, in order; a typed code (import) is kept and counted', async () => {
    const a = await hire({ departmentCode: 'ATC' });
    const b = await hire({ departmentCode: 'ATC' });
    const n = (code: string) => Number(code.slice(3));
    expect(a.job.employeeCode).toMatch(/^ATC\d{3,}$/);
    expect(n(b.job.employeeCode)).toBe(n(a.job.employeeCode) + 1);

    const imported = await hire({ departmentCode: 'ATC', employeeCode: `ATC${n(b.job.employeeCode) + 10}` });
    expect(imported.job.employeeCode).toBe(`ATC${n(b.job.employeeCode) + 10}`);
    const next = await hire({ departmentCode: 'ATC' });
    expect(n(next.job.employeeCode)).toBe(n(b.job.employeeCode) + 11);

    const other = await hire({ departmentCode: 'ATHR' }); // ATHR codes are counted apart from ATH
    expect(other.job.employeeCode).toMatch(/^ATHR\d{3,}$/);
    const none = await hire({});
    expect([none.res.status, none.res.body.code]).toEqual([400, 'HRMS_EMPLOYEE_CODE_REQUIRED']);
  });

  it('a transfer to another department keeps the employee code', async () => {
    const { job } = await hire({ departmentCode: 'ATS' });
    const moved = await http().patch(`/api/hrms/employments/${job.publicId}`).set(hr).send({ departmentCode: 'ATH' });
    expect(moved.status).toBe(200);
    expect(moved.body.employments[0]).toMatchObject({ employeeCode: job.employeeCode, department: { code: 'ATH', name: 'Hardware & IoT' } });
  });

  it('a joining person cannot punch, apply for leave or claim expenses until activated; the offer letter is kept and checked', async () => {
    const { person, job } = await hire({ departmentCode: 'ATD', status: 'joining', recruitedOn: '2026-03-15' });
    expect(job).toMatchObject({ status: 'joining', recruitedOn: '2026-03-15', hasOfferLetter: false });
    const login = `staff.${tag().toLowerCase()}@example.com`;
    await http().post('/api/core/users').set(admin).send({ personPublicId: person.publicId, loginEmail: login, password: 'first-pass-1' }).expect(201);
    await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: person.publicId, roleCode: 'employee', scope: 'own' }).expect(201);
    const me = await finishFirstLogin(app, login, 'first-pass-1', 'own-pass-1');

    const punch = () => http().post('/api/hrms/attendance/punches').set(me)
      .send({ publicId: randomUUID(), employmentPublicId: job.publicId, kind: 'in', occurredAt: '2026-04-06T09:00:00+05:30' });
    expect((await punch()).body.code).toBe('HRMS_EMPLOYMENT_NOT_ACTIVE');
    expect((await http().post('/api/hrms/leave/requests').set(me)
      .send({ employmentPublicId: job.publicId, leaveTypeCode: 'EL', fromDate: '2026-04-07', toDate: '2026-04-07' })).body.code).toBe('HRMS_EMPLOYMENT_NOT_ACTIVE');
    expect((await http().post('/api/hrms/expenses').set(me)
      .field('employmentPublicId', job.publicId).field('categoryCode', 'food').field('spentOn', '2026-04-06').field('amountPaise', '5000')).body.code)
      .toBe('HRMS_EMPLOYMENT_NOT_ACTIVE');

    // offer letter: HR uploads; the person and HR can fetch it, someone else cannot
    expect((await http().post(`/api/hrms/employments/${job.publicId}/offer-letter`).set(hr).attach('file', Buffer.from('not a pdf'), 'x.pdf')).body.code).toBe('HRMS_FILE_TYPE');
    const up = await http().post(`/api/hrms/employments/${job.publicId}/offer-letter`).set(hr).attach('file', PDF, 'offer.pdf');
    expect(up.body.employments[0].hasOfferLetter).toBe(true);
    const mine = await http().get(`/api/hrms/employments/${job.publicId}/offer-letter`).set(me);
    expect([mine.status, mine.headers['content-type']]).toEqual([200, 'application/pdf']);
    expect((await http().get(`/api/hrms/employments/${job.publicId}/offer-letter`).set(tech)).status).toBe(403);

    const active = await http().post(`/api/hrms/employments/${job.publicId}/activate`).set(hr);
    expect(active.body.employments[0].status).toBe('active');
    expect((await punch()).status).toBe(201);
    expect((await http().post(`/api/hrms/employments/${job.publicId}/activate`).set(hr)).body.code).toBe('HRMS_EMPLOYMENT_NOT_JOINING');
  });

  it('a position is planned, opened and filled by the person hired', async () => {
    const created = await http().post('/api/hrms/positions').set(hr).send({ company: 'ATPL', departmentCode: 'ATS', designation: 'Developer', notes: 'Backend' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ company: 'ATPL', department: { code: 'ATS' }, designation: 'Developer', status: 'planned', filledBy: null });
    const id = created.body.publicId;
    expect((await http().post(`/api/hrms/positions/${id}/status`).set(hr).send({ status: 'open' })).body.status).toBe('open');

    const { person, job } = await hire({ departmentCode: 'ATS', status: 'joining' });
    const filled = await http().post(`/api/hrms/positions/${id}/fill`).set(hr).send({ employmentPublicId: job.publicId });
    expect(filled.body).toMatchObject({ status: 'filled', filledBy: { employmentPublicId: job.publicId, person: { publicId: person.publicId } } });
    expect((await http().post(`/api/hrms/positions/${id}/status`).set(hr).send({ status: 'open' })).body.code).toBe('HRMS_POSITION_FILLED');
    const open = (await http().get('/api/hrms/positions').query({ company: 'ATPL', status: 'filled' }).set(hr)).body;
    expect(open.map((p: { publicId: string }) => p.publicId)).toContain(id);

    expect((await http().post('/api/hrms/positions').set(hr).send({ company: 'ATPL', departmentCode: 'ATS', designation: 'Astronaut' })).body.code).toBe('HRMS_UNKNOWN_DESIGNATION');
    expect((await http().get('/api/hrms/positions').set(tech)).status).toBe(403);
  });

  it('the department head decides when the job has no manager', async () => {
    const head = await hire({ departmentCode: 'ATH' });
    const dep = (await http().get('/api/hrms/departments').query({ company: 'ATPL' }).set(hr)).body.find((d: { codePrefix: string }) => d.codePrefix === 'ATH');
    const set = await http().patch(`/api/hrms/departments/${dep.publicId}`).set(hr).send({ headPublicId: head.person.publicId });
    expect(set.body.head).toMatchObject({ publicId: head.person.publicId });

    const { person, job } = await hire({ departmentCode: 'ATH' });
    const login = `staff.${tag().toLowerCase()}@example.com`;
    await http().post('/api/core/users').set(admin).send({ personPublicId: person.publicId, loginEmail: login, password: 'first-pass-1' }).expect(201);
    await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: person.publicId, roleCode: 'employee', scope: 'own' }).expect(201);
    const me = await finishFirstLogin(app, login, 'first-pass-1', 'own-pass-1');
    const leave = await http().post('/api/hrms/leave/requests').set(me).send({ employmentPublicId: job.publicId, leaveTypeCode: 'EL', fromDate: '2027-03-02', toDate: '2027-03-02' });
    expect(leave.body.approver).toEqual({ publicId: head.person.publicId, displayName: head.person.displayName });
    await http().patch(`/api/hrms/departments/${dep.publicId}`).set(hr).send({ headPublicId: null }).expect(200); // leave no head behind for other tests
  });
});
