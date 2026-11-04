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
// July 2026 starts on a Wednesday; the dates used here are working days no other test touches.

describe('HRMS attendance corrections API', () => {
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
  const punch = async (auth: Auth, job: string, kind: 'in' | 'out', occurredAt: string) =>
    (await http().post('/api/hrms/attendance/punches').set(auth).send({ publicId: randomUUID(), employmentPublicId: job, kind, occurredAt }).expect(201)).body;
  const correct = (auth: Auth, body: Record<string, unknown>) => http().post('/api/hrms/attendance/corrections').set(auth).send(body);
  const act = (auth: Auth, id: string, action: 'approve' | 'reject' | 'cancel', body: Record<string, unknown> = {}) =>
    http().post(`/api/hrms/attendance/corrections/${id}/${action}`).set(auth).send(body);
  const dayOf = async (s: Staff, date: string) => (await http().get('/api/hrms/attendance/history').query({ from: date, to: date }).set(s.auth)).body[0];

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, sup] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.supervisor].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('a missed punch-out is fixed and the day recalculated; the correction replaces the automatic punch-out', async () => {
    const s = await staff();
    const day = '2026-07-07';
    await punch(s.auth, s.jobs.AE, 'in', ist(day, '09:00'));
    expect((await dayOf(s, day)).status).toBe('missed_punch');
    expect((await http().get('/api/hrms/attendance/today').set(s.auth)).body.lastMissedPunchDate).toBe(day);
    // the next punch-in is not blocked: that day is closed automatically 8 hours after its punch-in
    await punch(s.auth, s.jobs.AE, 'in', new Date().toISOString());
    expect(await dayOf(s, day)).toMatchObject({ status: 'missed_punch', workedMinutes: 480 });

    const id = randomUUID();
    const body = { publicId: id, employmentPublicId: s.jobs.AE, workDate: day, kind: 'missed_out', requestedOut: ist(day, '17:30'), reason: 'Forgot to punch out at the gate' };
    const created = await correct(s.auth, body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ publicId: id, status: 'submitted', kind: 'missed_out', approver: { publicId: DEMO.supervisor.publicId }, requestedBy: { publicId: s.personId } });
    expect((await correct(s.auth, body)).status).toBe(200); // resend
    expect((await http().get('/api/hrms/attendance/today').set(s.auth)).body.lastMissedPunchDate).toBeNull(); // a correction is open
    const waiting = await http().get('/api/hrms/attendance/corrections/to-approve').set(sup);
    expect(waiting.body.map((c: { publicId: string }) => c.publicId)).toContain(id);

    const approved = await act(sup, id, 'approve');
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', decidedBy: { publicId: DEMO.supervisor.publicId } });
    const fixed = await dayOf(s, day);
    expect(fixed).toMatchObject({ status: 'present', workedMinutes: 510, absentDays: 0 });
    expect(fixed.punches.map((p: { kind: string; source: string; corrected: boolean }) => [p.kind, p.source, p.corrected]))
      .toEqual([['in', 'web', false], ['out', 'auto', true], ['out', 'correction', false]]);
    expect((await act(sup, id, 'approve')).body.code).toBe('HRMS_CORRECTION_NOT_PENDING');
  });

  it('a wrong time is left out and replaced; the original punches stay stored and are marked corrected', async () => {
    const s = await staff();
    const day = '2026-07-08';
    await punch(s.auth, s.jobs.AE, 'in', ist(day, '09:00'));
    const wrongOut = await punch(s.auth, s.jobs.AE, 'out', ist(day, '13:00')); // actually left at 18:00
    expect(await dayOf(s, day)).toMatchObject({ status: 'half_day', workedMinutes: 240 });

    const c = await correct(s.auth, { employmentPublicId: s.jobs.AE, workDate: day, kind: 'wrong_time', punchIdsToExclude: [wrongOut.publicId],
      requestedOut: ist(day, '18:00'), reason: 'The gate reader stamped the wrong time' });
    expect(c.status).toBe(201);
    await act(sup, c.body.publicId, 'approve').expect(200);

    const fixed = await dayOf(s, day);
    expect(fixed).toMatchObject({ status: 'present', workedMinutes: 540 });
    expect(fixed.punches.map((p: { occurredAt: string; source: string; corrected: boolean }) => [p.occurredAt, p.source, p.corrected])).toEqual([
      [new Date(ist(day, '09:00')).toISOString(), 'web', false],
      [new Date(ist(day, '13:00')).toISOString(), 'web', true],
      [new Date(ist(day, '18:00')).toISOString(), 'correction', false],
    ]);

    const { rows } = await db.query(`SELECT count(*)::int AS n FROM hrms.attendance_events e JOIN hrms.employments j ON j.id = e.employment_id WHERE j.public_id = $1`, [s.jobs.AE]);
    expect(rows[0].n).toBe(3); // nothing deleted
    await expect(db.query(`DELETE FROM hrms.attendance_exclusions x USING hrms.attendance_events e WHERE e.id = x.punch_id AND e.public_id = $1`, [wrongOut.publicId]))
      .rejects.toThrow(/HRMS_EXCLUSION_APPEND_ONLY/);
  });

  it('a locked day cannot be corrected, nor a correction approved once the day is locked', async () => {
    const s = await staff();
    const lock = (day: string) => db.query(`UPDATE hrms.work_days w SET locked_for_payroll = true FROM hrms.employments j
      WHERE j.id = w.employment_id AND j.public_id = $1 AND w.work_date = $2`, [s.jobs.AE, day]);
    await punch(s.auth, s.jobs.AE, 'in', ist('2026-07-09', '09:00'));
    await punch(s.auth, s.jobs.AE, 'out', ist('2026-07-09', '12:00'));
    await lock('2026-07-09');
    const refused = await correct(s.auth, { employmentPublicId: s.jobs.AE, workDate: '2026-07-09', kind: 'missed_out', requestedOut: ist('2026-07-09', '17:00'), reason: 'Left later than recorded' });
    expect([refused.status, refused.body.code]).toEqual([409, 'HRMS_DAY_LOCKED']);

    await punch(s.auth, s.jobs.AE, 'in', ist('2026-07-10', '09:00'));
    const c = await correct(s.auth, { employmentPublicId: s.jobs.AE, workDate: '2026-07-10', kind: 'missed_out', requestedOut: ist('2026-07-10', '17:00'), reason: 'Forgot to punch out' });
    await lock('2026-07-10');
    const late = await act(sup, c.body.publicId, 'approve');
    expect([late.status, late.body.code]).toEqual([409, 'HRMS_DAY_LOCKED']);
  });

  it('nobody decides a correction about themselves or one they filed', async () => {
    // HR's own day: goes to someone else, and HR cannot approve it
    const hrPunch = await punch(hr, HR_JOB, 'in', ist('2026-07-14', '09:00'));
    await punch(hr, HR_JOB, 'out', ist('2026-07-14', '17:00'));
    const own = await correct(hr, { employmentPublicId: HR_JOB, workDate: '2026-07-14', kind: 'wrong_time', punchIdsToExclude: [hrPunch.publicId],
      requestedIn: ist('2026-07-14', '08:30'), reason: 'Came in earlier for the audit' });
    expect(own.status).toBe(201);
    expect(own.body.approver.publicId).not.toBe(DEMO.hr.publicId);
    const self = await act(hr, own.body.publicId, 'approve');
    expect([self.status, self.body.code]).toEqual([403, 'HRMS_SELF_APPROVAL']);

    // a supervisor files for a team member: the correction goes past them (to HR), and they cannot approve it
    const s = await staff();
    await punch(s.auth, s.jobs.AE, 'in', ist('2026-07-14', '09:00'));
    const filed = await correct(sup, { employmentPublicId: s.jobs.AE, workDate: '2026-07-14', kind: 'missed_out', requestedOut: ist('2026-07-14', '18:00'), reason: 'Saw them leave at six' });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ person: { publicId: s.personId }, requestedBy: { publicId: DEMO.supervisor.publicId }, approver: { publicId: DEMO.hr.publicId } });
    expect((await act(sup, filed.body.publicId, 'approve')).body.code).toBe('HRMS_SELF_APPROVAL');
    await act(hr, filed.body.publicId, 'approve').expect(200);
  });

  it('one open correction per job and date; cancel and reject end it', async () => {
    const s = await staff();
    const day = '2026-07-15';
    await punch(s.auth, s.jobs.AE, 'in', ist(day, '09:00'));
    const body = { employmentPublicId: s.jobs.AE, workDate: day, kind: 'missed_out', requestedOut: ist(day, '17:00'), reason: 'Forgot to punch out' };
    const first = await correct(s.auth, body);
    const second = await correct(s.auth, body);
    expect([second.status, second.body.code]).toEqual([409, 'HRMS_CORRECTION_OPEN']);

    expect((await act(s.auth, first.body.publicId, 'cancel')).body.status).toBe('cancelled');
    const third = await correct(s.auth, body);
    expect(third.status).toBe(201);
    expect((await act(sup, third.body.publicId, 'reject')).status).toBe(400); // a reason is needed
    expect((await act(sup, third.body.publicId, 'reject', { reason: 'Gate log shows 15:00' })).body).toMatchObject({ status: 'rejected', decisionReason: 'Gate log shows 15:00' });
    const mine = await http().get('/api/hrms/attendance/corrections/mine').set(s.auth);
    expect(mine.body.map((c: { status: string }) => c.status).sort()).toEqual(['cancelled', 'rejected']);
  });

  it('refuses a short reason, a time on another day, someone else\'s punch, a future day and a stranger\'s job', async () => {
    const s = await staff();
    const day = '2026-07-16';
    await punch(s.auth, s.jobs.AE, 'in', ist(day, '09:00'));
    const base = { employmentPublicId: s.jobs.AE, workDate: day, kind: 'missed_out', requestedOut: ist(day, '17:00'), reason: 'Forgot to punch out' };
    expect((await correct(s.auth, { ...base, reason: 'forgot' })).status).toBe(400);
    expect((await correct(s.auth, { ...base, requestedOut: ist('2026-07-17', '01:00') })).body.code).toBe('HRMS_CORRECTION_OUTSIDE_DAY');
    expect((await correct(s.auth, { ...base, kind: 'other', punchIdsToExclude: [randomUUID()] })).body.code).toBe('HRMS_CORRECTION_UNKNOWN_PUNCH');
    const future = addDays(todayIst(), 2);
    expect((await correct(s.auth, { ...base, workDate: future, requestedOut: ist(future, '17:00') })).body.code).toBe('HRMS_CORRECTION_FUTURE');
    const stranger = await newStaff(app, hr, admin);
    expect((await correct(stranger.auth, base)).status).toBe(403);
  });
});
