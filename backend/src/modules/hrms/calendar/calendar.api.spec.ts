import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { addDays, todayIst } from '../../../platform/time';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';
import { LeaveService } from '../leave/application/leave.service';

type Auth = Record<string, string>;
const ist = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;
// September 2026 starts on a Tuesday: Saturdays 5, 12, 19, 26; Sundays 6, 13, 20, 27.

describe('HRMS calendar API', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, tech: Auth;
  let db: pg.Client;
  const http = () => request(app.getHttpServer());
  const staff = () => newStaff(app, hr, admin);
  const punch = (s: Staff, kind: 'in' | 'out', occurredAt: string) =>
    http().post('/api/hrms/attendance/punches').set(s.auth).send({ publicId: randomUUID(), employmentPublicId: s.jobs.AE, kind, occurredAt }).expect(201);
  const dayOf = async (s: Staff, date: string) => (await http().get('/api/hrms/attendance/history').query({ from: date, to: date }).set(s.auth)).body[0];
  /** date → kind, from the job's calendar */
  const kinds = async (s: Staff, from: string, to: string, auth: Auth = s.auth) => {
    const res = await http().get('/api/hrms/calendar').query({ employment: s.jobs.AE, from, to }).set(auth);
    expect(res.status).toBe(200);
    return Object.fromEntries(res.body.days.map((d: { date: string; kind: string }) => [d.date, d.kind]));
  };
  const addHoliday = (date: string, name = 'Test Holiday', publicId = randomUUID()) =>
    http().post('/api/hrms/holidays').set(hr).send({ publicId, company: 'AE', date, name });

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, tech] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.technician].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('every Sunday and the 2nd and 4th Saturday are weekly offs; such a day is not absent', async () => {
    const s = await staff();
    const k = await kinds(s, '2026-09-01', '2026-09-30');
    expect([k['2026-09-05'], k['2026-09-12'], k['2026-09-19'], k['2026-09-26']]).toEqual(['working', 'weekly_off', 'working', 'weekly_off']);
    expect([k['2026-09-06'], k['2026-09-13'], k['2026-09-20'], k['2026-09-27']]).toEqual(['weekly_off', 'weekly_off', 'weekly_off', 'weekly_off']);
    expect(k['2026-09-07']).toBe('working');

    const register = await http().get('/api/hrms/attendance/register').query({ date: '2026-09-12', company: 'AE' }).set(hr);
    const row = register.body.rows.find((r: { person: { publicId: string } }) => r.person.publicId === s.personId);
    expect(row).toMatchObject({ status: 'weekly_off', workedMinutes: 0 });
  });

  it('a person\'s own weekly off wins over the company\'s, and days already worked are rebuilt', async () => {
    const s = await staff();
    await punch(s, 'in', ist('2026-09-04', '10:00'));
    await punch(s, 'out', ist('2026-09-04', '11:00'));
    expect(await dayOf(s, '2026-09-04')).toMatchObject({ status: 'absent', workedMinutes: 60 });

    const id = randomUUID();
    const fridays = { publicId: id, employmentPublicId: s.jobs.AE, validFrom: '2026-09-01', rule: { weekdays: [5] } };
    const res = await http().post('/api/hrms/weekly-offs').set(hr).send(fridays);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ publicId: id, company: 'AE', employment: { publicId: s.jobs.AE }, validTo: null, rule: { weekdays: [5], nthWeekdays: [] } });
    const again = await http().post('/api/hrms/weekly-offs').set(hr).send(fridays);
    expect([again.status, again.body]).toEqual([200, res.body]);

    expect(await dayOf(s, '2026-09-04')).toMatchObject({ status: 'weekly_off', workedMinutes: 60 }); // rebuilt
    const k = await kinds(s, '2026-09-04', '2026-09-12');
    expect([k['2026-09-04'], k['2026-09-06'], k['2026-09-12']]).toEqual(['weekly_off', 'working', 'working']);

    const overlap = await http().post('/api/hrms/weekly-offs').set(hr).send({ ...fridays, publicId: randomUUID() });
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('HRMS_WEEKLY_OFF_OVERLAP');

    // a later rule ends the open one the day before
    await http().post('/api/hrms/weekly-offs').set(hr).send({ employmentPublicId: s.jobs.AE, validFrom: '2026-09-15', rule: { weekdays: [0] } }).expect(201);
    const list = await http().get('/api/hrms/weekly-offs').query({ employment: s.jobs.AE }).set(hr);
    expect(list.body.map((r: { validFrom: string; validTo: string | null }) => [r.validFrom, r.validTo]))
      .toEqual([['2026-09-01', '2026-09-14'], ['2026-09-15', null]]);
  });

  it('a holiday shows as holiday, not absent, and days already worked are rebuilt', async () => {
    const idle = await staff();
    const worked = await staff();
    const id = randomUUID();
    const added = await addHoliday('2026-09-15', 'Test Holiday One', id);
    expect(added.status).toBe(201);
    expect(added.body).toEqual({ publicId: id, company: 'AE', date: '2026-09-15', name: 'Test Holiday One', isOptional: false });
    expect((await addHoliday('2026-09-15', 'Test Holiday One', id)).status).toBe(200);
    const twice = await addHoliday('2026-09-15', 'Another Name');
    expect([twice.status, twice.body.code]).toEqual([409, 'HRMS_HOLIDAY_EXISTS']);

    const register = await http().get('/api/hrms/attendance/register').query({ date: '2026-09-15', company: 'AE' }).set(hr);
    expect(register.body.rows.find((r: { person: { publicId: string } }) => r.person.publicId === idle.personId).status).toBe('holiday');

    await punch(worked, 'in', ist('2026-09-16', '09:00'));
    await punch(worked, 'out', ist('2026-09-16', '11:00'));
    expect((await dayOf(worked, '2026-09-16')).status).toBe('absent');
    await addHoliday('2026-09-16', 'Test Holiday Two').expect(201);
    expect(await dayOf(worked, '2026-09-16')).toMatchObject({ status: 'holiday', workedMinutes: 120 });

    const cal = await http().get('/api/hrms/calendar').query({ employment: idle.jobs.AE, from: '2026-09-15', to: '2026-09-15' }).set(idle.auth);
    expect(cal.body.days).toEqual([{ date: '2026-09-15', kind: 'holiday', holiday: 'Test Holiday One', optionalHoliday: null }]);
    const list = await http().get('/api/hrms/holidays').query({ company: 'AE', year: 2026 }).set(idle.auth);
    expect(list.body.map((h: { date: string }) => h.date)).toEqual(expect.arrayContaining(['2026-09-15', '2026-09-16']));
  });

  it('only HR changes the calendar; a past holiday, or one inside an approved leave, cannot be removed', async () => {
    expect((await http().post('/api/hrms/holidays').set(tech).send({ company: 'AE', date: '2026-09-17', name: 'Not Allowed' })).status).toBe(403);
    const other = await staff();
    expect((await http().get('/api/hrms/calendar').query({ employment: other.jobs.AE, from: '2026-09-01', to: '2026-09-02' }).set(tech)).status).toBe(403);

    const past = await addHoliday('2026-09-18');
    const refusedPast = await http().delete(`/api/hrms/holidays/${past.body.publicId}`).set(hr);
    expect([refusedPast.status, refusedPast.body.code]).toEqual([409, 'HRMS_HOLIDAY_PAST']);

    const covered = addDays(todayIst(), 40);
    const inLeave = await addHoliday(covered);
    const s = await staff();
    const leave = await http().post('/api/hrms/leave/requests').set(s.auth)
      .send({ employmentPublicId: s.jobs.AE, leaveTypeCode: 'EL', fromDate: addDays(covered, -3), toDate: addDays(covered, 3) }).expect(201);
    await http().post(`/api/hrms/leave/requests/${leave.body.publicId}/approve`).set(hr).expect(200); // no manager: HR decides
    const refusedLeave = await http().delete(`/api/hrms/holidays/${inLeave.body.publicId}`).set(hr);
    expect([refusedLeave.status, refusedLeave.body.code]).toEqual([409, 'HRMS_HOLIDAY_IN_USE']);

    const free = await addHoliday(addDays(todayIst(), 45));
    await http().delete(`/api/hrms/holidays/${free.body.publicId}`).set(hr).expect(204);
    const list = await http().get('/api/hrms/holidays').query({ company: 'AE', year: Number(addDays(todayIst(), 45).slice(0, 4)) }).set(hr);
    expect(list.body.map((h: { publicId: string }) => h.publicId)).not.toContain(free.body.publicId);
  });

  it('leave days skip weekly offs and holidays', async () => {
    const s = await staff();
    await addHoliday('2026-09-23', 'Test Holiday Three').expect(201);
    const leave = app.get(LeaveService, { strict: false });
    // Mon 21 – Sun 27: Wed 23 holiday, Sat 26 (4th Saturday) and Sun 27 off → Mon, Tue, Thu, Fri
    expect(await leave.countDays(1, s.jobs.AE, '2026-09-21', '2026-09-27', 'full', 'full')).toBe(4);
    expect(await leave.countDays(1, s.jobs.AE, '2026-09-05', '2026-09-05', 'full', 'full')).toBe(1); // 1st Saturday is worked
    expect(await leave.countDays(1, s.jobs.AE, '2026-09-12', '2026-09-12', 'full', 'full')).toBe(0); // 2nd Saturday is off
  });
});
