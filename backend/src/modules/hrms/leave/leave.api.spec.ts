import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { addDays, todayIst } from '../../../platform/time';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';

type Auth = Record<string, string>;
const HR_JOB = '00000000-0000-4000-8000-000000000104'; // Demo HR's job (seed)

/** A Monday at least `days` ahead, so approved leave can still be cancelled whenever the tests run. */
function mondayAfter(days: number): string {
  let d = addDays(todayIst(), days);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}
const MONDAY = mondayAfter(70);
const day = (n: number) => addDays(MONDAY, n); // day(0) Monday … day(4) Friday, day(5) Saturday, day(7) next Monday

describe('HRMS leave API', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, sup: Auth, tech: Auth, engineer: Auth;
  const http = () => request(app.getHttpServer());
  const staff = (companies?: string[]) => newStaff(app, hr, admin, companies);
  const apply = (s: Staff, from: string, to: string, extra: Record<string, unknown> = {}, company = 'AE') =>
    http().post('/api/hrms/leave/requests').set(s.auth).send({ employmentPublicId: s.jobs[company], leaveTypeCode: 'GL', fromDate: from, toDate: to, ...extra });
  const act = (auth: Auth, id: string, action: 'approve' | 'reject' | 'cancel', body: Record<string, unknown> = {}) =>
    http().post(`/api/hrms/leave/requests/${id}/${action}`).set(auth).send(body);
  const balance = async (s: Staff) => (await http().get('/api/hrms/leave/balances/mine').set(s.auth)).body
    .find((b: { employment: { company: string }; leaveType: { code: string } }) => b.employment.company === 'AE' && b.leaveType.code === 'GL').balance;
  const statuses = async (s: Staff, from: string, to: string) =>
    (await http().get('/api/hrms/attendance/history').query({ from, to }).set(s.auth)).body.map((r: { date: string; status: string }) => [r.date, r.status]);
  const opening = (s: Staff, days: number) => http().post('/api/hrms/leave/ledger/adjustments').set(hr)
    .send({ employmentPublicId: s.jobs.AE, leaveTypeCode: 'GL', year: Number(day(0).slice(0, 4)), entry: 'opening', days, reason: 'Opening balance' });

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, sup, tech, engineer] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.supervisor, DEMO.technician, DEMO.engineer].map((d) => signIn(app, d.login)));
  });
  afterAll(async () => { await app?.close(); });

  it('lists the leave types', async () => {
    const res = await http().get('/api/hrms/leave/types').set(tech);
    expect(res.body).toEqual(expect.arrayContaining([{ code: 'GL', name: 'General leave', isPaid: true }]));
  });

  it('overlapping leave is refused on the same job but allowed in the other company; a resend is stored once', async () => {
    const s = await staff(['AE', 'ATPL']);
    const id = randomUUID();
    const first = await apply(s, day(0), day(1), { publicId: id });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ publicId: id, days: 2, status: 'submitted', approver: { publicId: DEMO.hr.publicId, displayName: 'Demo HR' }, employment: { company: 'AE' } }); // no manager: HR
    const again = await apply(s, day(0), day(1), { publicId: id });
    expect([again.status, again.body]).toEqual([200, first.body]);

    const overlap = await apply(s, day(1), day(2));
    expect([overlap.status, overlap.body.code]).toEqual([409, 'HRMS_LEAVE_OVERLAP']);
    expect((await apply(s, day(1), day(2), {}, 'ATPL')).status).toBe(201);
  });

  it('nobody approves their own leave; a supervisor decides only for their team', async () => {
    const own = await http().post('/api/hrms/leave/requests').set(hr).send({ employmentPublicId: HR_JOB, leaveTypeCode: 'GL', fromDate: day(21), toDate: day(21) });
    expect(own.status).toBe(201);
    expect(own.body.approver).not.toBeNull();
    expect(own.body.approver.publicId).not.toBe(DEMO.hr.publicId); // another HR person, else the CEO
    const self = await act(hr, own.body.publicId, 'approve');
    expect([self.status, self.body.code]).toEqual([403, 'HRMS_SELF_APPROVAL']);

    const s = await staff(); // no manager
    const r = await apply(s, day(0), day(0));
    expect((await act(sup, r.body.publicId, 'approve')).status).toBe(403);
    expect((await act(tech, r.body.publicId, 'approve')).status).toBe(403);
  });

  it('approver fallback: the manager first, else HR; a supervisor decides only what names them', async () => {
    const s = await staff();
    await http().patch(`/api/hrms/employments/${s.jobs.AE}`).set(hr).send({ managerPublicId: DEMO.supervisor.publicId }).expect(200);
    expect((await apply(s, day(35), day(35))).body.approver.publicId).toBe(DEMO.supervisor.publicId);

    // no manager and no department head: HR
    const other = await apply(await staff(), day(35), day(35));
    expect(other.body.approver.publicId).toBe(DEMO.hr.publicId);
    expect((await act(sup, other.body.publicId, 'approve')).status).toBe(403);
    // the CEO's own requests and Management decisions: reports/management.api.spec.ts
  });

  it('with the company balance-check policy on, leave may not take the balance below zero', async () => {
    // a far-future ATPL policy version, so no other test is affected
    await http().post('/api/core/policies').set(hr).send({ key: 'hrms.leave.balance_check', company: 'ATPL', value: true, effectiveFrom: '2030-01-01' }).expect(201);
    const s = await staff(['ATPL']);
    const body = { employmentPublicId: s.jobs.ATPL, leaveTypeCode: 'GL', fromDate: '2030-03-04', toDate: '2030-03-05' };
    const refused = await http().post('/api/hrms/leave/requests').set(s.auth).send(body);
    expect([refused.status, refused.body.code]).toEqual([409, 'HRMS_LEAVE_BALANCE']);
    await http().post('/api/hrms/leave/ledger/adjustments').set(hr)
      .send({ employmentPublicId: s.jobs.ATPL, leaveTypeCode: 'GL', year: 2030, entry: 'opening', days: 2, reason: 'Opening balance' }).expect(201);
    expect((await http().post('/api/hrms/leave/requests').set(s.auth).send(body)).status).toBe(201);
    // before the policy takes effect the check is off
    expect((await http().post('/api/hrms/leave/requests').set(s.auth).send({ ...body, fromDate: '2029-12-03', toDate: '2029-12-04' })).status).toBe(201);
  });

  it('a full day worked on full leave is present and marked as worked on leave', async () => {
    const s = await staff();
    const date = '2026-08-11'; // a past Tuesday
    for (const [kind, t] of [['in', '09:00'], ['out', '17:30']] as const) {
      await http().post('/api/hrms/attendance/punches').set(s.auth)
        .send({ publicId: randomUUID(), employmentPublicId: s.jobs.AE, kind, occurredAt: `${date}T${t}:00+05:30` }).expect(201);
    }
    const r = await apply(s, date, date);
    await act(hr, r.body.publicId, 'approve').expect(200);
    const [row] = (await http().get('/api/hrms/attendance/history').query({ from: date, to: date }).set(s.auth)).body;
    expect(row).toMatchObject({ status: 'present', leaveDays: 1, absentDays: 0, workedOnLeave: true });

    const register = await http().get('/api/hrms/attendance/register').query({ date, company: 'AE' }).set(hr);
    expect(register.body.rows.find((x: { person: { publicId: string } }) => x.person.publicId === s.personId))
      .toMatchObject({ status: 'present', leaveDays: 1, workedOnLeave: true });
    expect(register.body.totals.leaveDays).toBeGreaterThanOrEqual(1);
  });

  it('approval takes the days and marks the work days as leave; cancelling gives them back', async () => {
    const s = await staff();
    await http().patch(`/api/hrms/employments/${s.jobs.AE}`).set(hr).send({ managerPublicId: DEMO.supervisor.publicId }).expect(200);
    await opening(s, 10).expect(201);
    expect(await balance(s)).toBe(10);

    const r = await apply(s, day(0), day(1), { reason: 'Family function' });
    expect(r.body.approver).toEqual({ publicId: DEMO.supervisor.publicId, displayName: 'Demo Supervisor' });
    const waiting = await http().get('/api/hrms/leave/requests/to-approve').set(sup);
    expect(waiting.body.map((x: { publicId: string }) => x.publicId)).toContain(r.body.publicId);

    const approved = await act(sup, r.body.publicId, 'approve');
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', decidedBy: { publicId: DEMO.supervisor.publicId } });
    expect(await balance(s)).toBe(8);
    expect(await statuses(s, day(0), day(1))).toEqual([[day(1), 'leave'], [day(0), 'leave']]);
    expect((await act(sup, r.body.publicId, 'approve')).body.code).toBe('HRMS_LEAVE_NOT_PENDING');

    const cancelled = await act(s.auth, r.body.publicId, 'cancel', { reason: 'Plans changed' });
    expect(cancelled.body.status).toBe('cancelled');
    expect(await balance(s)).toBe(10);
    expect(await statuses(s, day(0), day(1))).toEqual([]);
    expect((await act(s.auth, r.body.publicId, 'cancel')).body.code).toBe('HRMS_LEAVE_CLOSED');

    // leave that has already started cannot be cancelled once approved
    const past = await apply(s, '2026-08-04', '2026-08-04');
    await act(hr, past.body.publicId, 'approve').expect(200);
    const late = await act(s.auth, past.body.publicId, 'cancel');
    expect([late.status, late.body.code]).toEqual([409, 'HRMS_LEAVE_STARTED']);
  });

  it('leave over a weekend counts only working days, and half days count half', async () => {
    const s = await staff();
    await http().post('/api/hrms/weekly-offs').set(hr).send({ employmentPublicId: s.jobs.AE, validFrom: day(-7), rule: { weekdays: [0, 6] } }).expect(201);
    expect((await apply(s, day(4), day(7))).body.days).toBe(2);                               // Fri, Sat, Sun, Mon
    const halves = await apply(s, day(11), day(14), { fromHalf: 'second_half', toHalf: 'first_half' });
    expect(halves.body.days).toBe(1);                                                          // Fri afternoon + Mon morning
    const weekendOnly = await apply(s, day(19), day(20));
    expect([weekendOnly.status, weekendOnly.body.code]).toEqual([400, 'HRMS_LEAVE_NO_WORKING_DAYS']);
    const oneDayBackwards = await apply(s, day(22), day(22), { fromHalf: 'second_half', toHalf: 'first_half' });
    expect(oneDayBackwards.status).toBe(400);

    await act(hr, halves.body.publicId, 'approve').expect(200);
    expect(await statuses(s, day(11), day(14))).toEqual([[day(14), 'half_day'], [day(13), 'weekly_off'], [day(12), 'weekly_off'], [day(11), 'half_day']]);
    const [mon] = (await http().get('/api/hrms/attendance/history').query({ from: day(14), to: day(14) }).set(s.auth)).body;
    expect(mon).toMatchObject({ status: 'half_day', leaveDays: 0.5, absentDays: 0.5, workedOnLeave: false }); // half leave, no work
  });

  it('a rejection needs a reason; a request not yet decided is simply cancelled', async () => {
    const s = await staff();
    const r = await apply(s, day(0), day(0));
    expect((await act(hr, r.body.publicId, 'reject')).status).toBe(400);
    const rejected = await act(hr, r.body.publicId, 'reject', { reason: 'Busy week' });
    expect(rejected.body).toMatchObject({ status: 'rejected', decisionReason: 'Busy week' });
    expect((await act(s.auth, r.body.publicId, 'cancel')).body.code).toBe('HRMS_LEAVE_CLOSED');

    const again = await apply(s, day(0), day(0)); // a rejected request does not block the dates
    expect(again.status).toBe(201);
    expect((await act(tech, again.body.publicId, 'cancel')).status).toBe(403);
    expect((await act(s.auth, again.body.publicId, 'cancel')).body.status).toBe('cancelled');
    expect(await balance(s)).toBe(0);
    const mine = await http().get('/api/hrms/leave/requests/mine').set(s.auth);
    expect(mine.body.map((x: { status: string }) => x.status).sort()).toEqual(['cancelled', 'rejected']);
  });

  it('HR posts opening balances and adjustments with a reason, never on their own balance', async () => {
    const s = await staff();
    const year = Number(day(0).slice(0, 4));
    const body = { employmentPublicId: s.jobs.AE, leaveTypeCode: 'GL', year, entry: 'adjustment', days: -1.5, reason: 'Unpaid absence in March' };
    expect((await http().post('/api/hrms/leave/ledger/adjustments').set(tech).send(body)).status).toBe(403);
    expect((await http().post('/api/hrms/leave/ledger/adjustments').set(hr).send({ ...body, reason: undefined })).status).toBe(400);
    expect((await http().post('/api/hrms/leave/ledger/adjustments').set(hr).send({ ...body, days: 0.3 })).status).toBe(400);
    const own = await http().post('/api/hrms/leave/ledger/adjustments').set(hr).send({ ...body, employmentPublicId: HR_JOB });
    expect([own.status, own.body.code]).toEqual([403, 'HRMS_SELF_APPROVAL']);

    await opening(s, 12).expect(201);
    const twice = await opening(s, 12);
    expect([twice.status, twice.body.code]).toEqual([409, 'HRMS_OPENING_EXISTS']);
    const adj = await http().post('/api/hrms/leave/ledger/adjustments').set(hr).send(body);
    expect(adj.status).toBe(201);
    expect(adj.body).toMatchObject({ entry: 'adjustment', days: -1.5, year, reason: 'Unpaid absence in March' });
    expect(await balance(s)).toBe(10.5);
  });

  it('the report shows HR everyone and a supervisor their team', async () => {
    const team = await staff();
    await http().patch(`/api/hrms/employments/${team.jobs.AE}`).set(hr).send({ managerPublicId: DEMO.supervisor.publicId }).expect(200);
    const other = await staff();
    const a = await apply(team, day(28), day(29));
    const b = await apply(other, day(28), day(28));
    await act(sup, a.body.publicId, 'approve').expect(200);

    const q = { company: 'AE', from: day(28), to: day(30) };
    const forHr = await http().get('/api/hrms/leave/report').query(q).set(hr);
    expect(forHr.status).toBe(200);
    expect(forHr.body.rows.map((r: { publicId: string }) => r.publicId)).toEqual(expect.arrayContaining([a.body.publicId, b.body.publicId]));
    const forSup = (await http().get('/api/hrms/leave/report').query(q).set(sup)).body.rows.map((r: { publicId: string }) => r.publicId);
    expect(forSup).toContain(a.body.publicId);
    expect(forSup).not.toContain(b.body.publicId);
    expect((await http().get('/api/hrms/leave/report').query(q).set(engineer)).status).toBe(403);
  });
});
