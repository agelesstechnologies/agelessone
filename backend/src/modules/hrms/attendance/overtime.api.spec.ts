import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { addDays, todayIst } from '../../../platform/time';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';

type Auth = Record<string, string>;
const ist = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;
const HR_JOB = '00000000-0000-4000-8000-000000000104';
// Working days at the end of July 2026 (Mon 27 – Fri 31) that no other test uses. Full day = 480 minutes.

describe('HRMS overtime API', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, sup: Auth;
  let db: pg.Client;
  const http = () => request(app.getHttpServer());
  /** A new employee managed by Demo Supervisor. */
  const staff = async () => {
    const s = await newStaff(app, hr, admin);
    await http().patch(`/api/hrms/employments/${s.jobs.AE}`).set(hr).send({ managerPublicId: DEMO.supervisor.publicId }).expect(200);
    return s;
  };
  const work = async (s: Staff, date: string, from: string, to: string) => {
    for (const [kind, t] of [['in', from], ['out', to]] as const) {
      await http().post('/api/hrms/attendance/punches').set(s.auth)
        .send({ publicId: randomUUID(), employmentPublicId: s.jobs.AE, kind, occurredAt: ist(date, t) }).expect(201);
    }
  };
  const ask = (auth: Auth, job: string, workDate: string, minutes: number, extra: Record<string, unknown> = {}) =>
    http().post('/api/hrms/attendance/overtime').set(auth).send({ employmentPublicId: job, workDate, minutes, reason: 'Site handover ran late', ...extra });
  const act = (auth: Auth, id: string, action: 'approve' | 'reject' | 'cancel', body: Record<string, unknown> = {}) =>
    http().post(`/api/hrms/attendance/overtime/${id}/${action}`).set(auth).send(body);
  const dayOf = async (s: Staff, date: string) => (await http().get('/api/hrms/attendance/history').query({ from: date, to: date }).set(s.auth)).body[0];
  const hoursOf = async (s: Staff, from: string, to: string) => (await http().get('/api/hrms/attendance/work-hours').query({ company: 'AE', from, to }).set(hr))
    .body.rows.find((r: { person: { publicId: string } }) => r.person.publicId === s.personId);

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, sup] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.supervisor].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('extra time without an approved request is not overtime', async () => {
    const s = await staff();
    await work(s, '2026-07-27', '09:00', '19:00');
    expect(await dayOf(s, '2026-07-27')).toMatchObject({ workedMinutes: 600, extraMinutes: 120, approvedOvertimeMinutes: 0 });
    expect(await hoursOf(s, '2026-07-27', '2026-07-27')).toMatchObject({ workedMinutes: 600, extraMinutes: 120, approvedOvertimeMinutes: 0, overtimePayable: false });
  });

  it('approved overtime is capped at the extra time worked; cancelling takes it back', async () => {
    const s = await staff();
    await work(s, '2026-07-28', '09:00', '18:00'); // 60 minutes extra
    const id = randomUUID();
    const r = await ask(s.auth, s.jobs.AE, '2026-07-28', 120, { publicId: id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ publicId: id, minutes: 120, status: 'submitted', approver: { publicId: DEMO.supervisor.publicId }, requestedBy: { publicId: s.personId } });
    expect((await ask(s.auth, s.jobs.AE, '2026-07-28', 120, { publicId: id })).status).toBe(200); // resend
    expect((await http().get('/api/hrms/attendance/overtime/to-approve').set(sup)).body.map((x: { publicId: string }) => x.publicId)).toContain(id);

    const approved = await act(sup, id, 'approve');
    expect(approved.body).toMatchObject({ status: 'approved', decidedBy: { publicId: DEMO.supervisor.publicId } });
    expect(await dayOf(s, '2026-07-28')).toMatchObject({ extraMinutes: 60, approvedOvertimeMinutes: 60 });
    expect(await hoursOf(s, '2026-07-28', '2026-07-28')).toMatchObject({ workedMinutes: 540, extraMinutes: 60, approvedOvertimeMinutes: 60 });

    expect((await act(s.auth, id, 'cancel')).body.status).toBe('cancelled');
    expect((await dayOf(s, '2026-07-28')).approvedOvertimeMinutes).toBe(0);
  });

  it('planned overtime: allowed for a future date, and applied when the day is built', async () => {
    const s = await staff();
    const future = addDays(todayIst(), 10);
    const planned = await ask(s.auth, s.jobs.AE, future, 60);
    expect(planned.status).toBe(201);
    expect((await act(sup, planned.body.publicId, 'approve')).status).toBe(200); // no work day yet: nothing to rebuild

    // approved before any punch of the day: the day picks it up when it is built
    const before = await ask(s.auth, s.jobs.AE, '2026-07-29', 90);
    await act(sup, before.body.publicId, 'approve').expect(200);
    await work(s, '2026-07-29', '09:00', '19:00');
    expect(await dayOf(s, '2026-07-29')).toMatchObject({ extraMinutes: 120, approvedOvertimeMinutes: 90 });
  });

  it('nobody decides overtime about themselves or that they filed', async () => {
    const own = await ask(hr, HR_JOB, '2026-07-30', 60);
    expect(own.status).toBe(201);
    expect(own.body.approver.publicId).not.toBe(DEMO.hr.publicId);
    const self = await act(hr, own.body.publicId, 'approve');
    expect([self.status, self.body.code]).toEqual([403, 'HRMS_SELF_APPROVAL']);

    const s = await staff();
    const filed = await ask(sup, s.jobs.AE, '2026-07-30', 60); // the supervisor asks for their team member
    expect(filed.body).toMatchObject({ requestedBy: { publicId: DEMO.supervisor.publicId }, approver: { publicId: DEMO.hr.publicId } });
    expect((await act(sup, filed.body.publicId, 'approve')).body.code).toBe('HRMS_SELF_APPROVAL');
    expect((await act(hr, filed.body.publicId, 'reject')).status).toBe(400); // a reason is needed
    expect((await act(hr, filed.body.publicId, 'reject', { reason: 'Not needed that day' })).body.status).toBe('rejected');
  });

  it('a locked day is refused, when asking and when approving', async () => {
    const s = await staff();
    const lock = (day: string) => db.query(`UPDATE hrms.work_days w SET locked_for_payroll = true FROM hrms.employments j
      WHERE j.id = w.employment_id AND j.public_id = $1 AND w.work_date = $2`, [s.jobs.AE, day]);
    await work(s, '2026-07-30', '09:00', '19:00');
    await work(s, '2026-07-31', '09:00', '19:00');
    await lock('2026-07-31');
    const refused = await ask(s.auth, s.jobs.AE, '2026-07-31', 60);
    expect([refused.status, refused.body.code]).toEqual([409, 'HRMS_DAY_LOCKED']);

    const r = await ask(s.auth, s.jobs.AE, '2026-07-30', 60);
    await lock('2026-07-30');
    const late = await act(sup, r.body.publicId, 'approve');
    expect([late.status, late.body.code]).toEqual([409, 'HRMS_DAY_LOCKED']);
  });
});
