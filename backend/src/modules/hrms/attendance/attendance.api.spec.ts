import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';

type Auth = Record<string, string>;
/** An IST wall-clock time on a date, as the device would send it. */
const ist = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;

describe('HRMS attendance API', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, tech: Auth;
  let db: pg.Client;
  const http = () => request(app.getHttpServer());
  const staff = (companies?: string[]) => newStaff(app, hr, admin, companies);
  const punch = (s: Staff, company: string, kind: 'in' | 'out', occurredAt: string, publicId = randomUUID()) =>
    http().post('/api/hrms/attendance/punches').set(s.auth).send({ publicId, employmentPublicId: s.jobs[company], kind, occurredAt });
  const history = (s: Staff, from: string, to = from) => http().get('/api/hrms/attendance/history').query({ from, to }).set(s.auth);

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, tech] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.technician].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  describe('punching', () => {
    it('a resend with the same publicId is stored once and answers with the stored punch', async () => {
      const s = await staff();
      const id = randomUUID();
      const first = await punch(s, 'AE', 'in', ist('2026-10-05', '09:00'), id);
      const again = await punch(s, 'AE', 'in', ist('2026-10-05', '09:00'), id);
      expect([first.status, again.status]).toEqual([201, 200]);
      expect(again.body).toEqual(first.body);
      expect(first.body).toMatchObject({ publicId: id, kind: 'in', employment: { publicId: s.jobs.AE, company: 'AE' }, locationStatus: 'not_taken' });
      const { rows } = await db.query('SELECT count(*)::int AS n FROM hrms.attendance_events WHERE public_id = $1', [id]);
      expect(rows[0].n).toBe(1);

      const other = await staff();
      const stolen = await http().post('/api/hrms/attendance/punches').set(other.auth)
        .send({ publicId: id, employmentPublicId: other.jobs.AE, kind: 'in', occurredAt: ist('2026-10-05', '09:00') });
      expect(stolen.status).toBe(409);
      expect(stolen.body.code).toBe('HRMS_DUPLICATE_ID');
    });

    it('in and out alternate per person across both companies', async () => {
      const s = await staff(['AE', 'ATPL']);
      const day = '2026-10-06';
      expect((await punch(s, 'AE', 'out', ist(day, '08:00'))).body.code).toBe('HRMS_PUNCH_ORDER'); // nothing to close
      expect((await punch(s, 'AE', 'in', ist(day, '09:00'))).status).toBe(201);

      const inElsewhere = await punch(s, 'ATPL', 'in', ist(day, '09:30'));
      expect(inElsewhere.status).toBe(409);
      expect(inElsewhere.body.code).toBe('HRMS_PUNCH_ORDER');
      const outElsewhere = await punch(s, 'ATPL', 'out', ist(day, '12:00'));
      expect(outElsewhere.status).toBe(409);
      expect(outElsewhere.body.code).toBe('HRMS_PUNCH_ORDER');
      const lateIn = await punch(s, 'AE', 'in', ist(day, '08:30')); // offline punch before the 09:00 in
      expect(lateIn.body.code).toBe('HRMS_PUNCH_ORDER');

      expect((await punch(s, 'AE', 'out', ist(day, '13:00'))).status).toBe(201);
      expect((await punch(s, 'ATPL', 'in', ist(day, '13:30'))).status).toBe(201);
      expect((await punch(s, 'ATPL', 'out', ist(day, '17:30'))).status).toBe(201);

      // one row per company: 4 hours each (a half day under the default rules: full 8 h, half 4 h)
      const rows = (await history(s, day)).body;
      expect(rows.map((r: { employment: { company: string }; workedMinutes: number; status: string }) =>
        [r.employment.company, r.workedMinutes, r.status])).toEqual([['AE', 240, 'half_day'], ['ATPL', 240, 'half_day']]);
    });

    it('refuses someone else\'s job and a time in the future', async () => {
      const s = await staff();
      const notMine = await http().post('/api/hrms/attendance/punches').set(s.auth)
        .send({ publicId: randomUUID(), employmentPublicId: '00000000-0000-4000-8000-000000000101', kind: 'in', occurredAt: ist('2026-10-05', '09:00') });
      expect(notMine.status).toBe(403);
      expect(notMine.body.code).toBe('HRMS_NOT_YOUR_EMPLOYMENT');
      const future = await punch(s, 'AE', 'in', new Date(Date.now() + 60 * 60 * 1000).toISOString());
      expect(future.status).toBe(400);
      expect(future.body.code).toBe('HRMS_PUNCH_IN_FUTURE');
    });
  });

  describe('work days and history', () => {
    it('counts the minutes of the day, with a lunch break', async () => {
      const s = await staff();
      const day = '2026-10-07';
      for (const [kind, t] of [['in', '09:00'], ['out', '13:00'], ['in', '14:00'], ['out', '18:30']] as const) {
        expect((await punch(s, 'AE', kind, ist(day, t))).status).toBe(201);
      }
      const res = await history(s, day);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{
        date: day, employment: { publicId: s.jobs.AE, company: 'AE', employeeCode: expect.any(String) },
        firstIn: new Date(ist(day, '09:00')).toISOString(), lastOut: new Date(ist(day, '18:30')).toISOString(),
        workedMinutes: 510, extraMinutes: 30, approvedOvertimeMinutes: 0, status: 'present', locked: false, running: false,
        leaveDays: 0, absentDays: 0, workedOnLeave: false, punches: expect.any(Array),
      }]);
    });

    it('a missed punch-out shows as missed_punch', async () => {
      const s = await staff();
      await punch(s, 'AE', 'in', ist('2026-10-08', '09:00')).expect(201);
      const [row] = (await history(s, '2026-10-08')).body;
      expect(row).toMatchObject({ status: 'missed_punch', workedMinutes: 0, lastOut: null, running: false });
    });

    it('today shows punched in, since when, and the running minutes', async () => {
      const s = await staff();
      const since = new Date(Date.now() - 30 * 60 * 1000);
      await punch(s, 'AE', 'in', since.toISOString()).expect(201);
      const today = await http().get('/api/hrms/attendance/today').set(s.auth);
      expect(today.status).toBe(200);
      expect(today.body).toMatchObject({ punchedIn: true, since: since.toISOString(), employment: { publicId: s.jobs.AE, company: 'AE' } });
      expect(today.body.workedMinutes).toBeGreaterThanOrEqual(29);
      expect(today.body.workedMinutes).toBeLessThanOrEqual(31);

      const [row] = (await history(s, today.body.date)).body;
      expect(row).toMatchObject({ status: 'working', running: true });
      expect(row.workedMinutes).toBeGreaterThanOrEqual(29);
    });
  });

  describe('automatic punch-out', () => {
    const kinds = (row: { punches: { kind: string; source: string; occurredAt: string }[] }) => row.punches.map((p) => [p.kind, p.source, p.occurredAt]);

    it('a forgotten punch-out is closed 8 hours after the punch-in when the next punch-in arrives', async () => {
      const s = await staff();
      await punch(s, 'AE', 'in', ist('2026-07-20', '09:00')).expect(201);
      await punch(s, 'AE', 'in', ist('2026-07-21', '09:30')).expect(201); // not blocked
      const [day] = (await history(s, '2026-07-20')).body;
      expect(day).toMatchObject({ status: 'missed_punch', workedMinutes: 480, absentDays: 0 });
      expect(kinds(day)).toEqual([['in', 'web', new Date(ist('2026-07-20', '09:00')).toISOString()], ['out', 'auto', new Date(ist('2026-07-20', '17:00')).toISOString()]]);
      expect((await http().get('/api/hrms/attendance/today').set(s.auth)).body.lastMissedPunchDate).toBe('2026-07-21'); // still open, then also missed
    });

    it('inside the 8 hours a second punch-in is still refused, and a late real punch-out (overtime) is kept', async () => {
      const s = await staff();
      await punch(s, 'AE', 'in', ist('2026-07-22', '09:00')).expect(201);
      expect((await punch(s, 'AE', 'in', ist('2026-07-22', '15:00'))).body.code).toBe('HRMS_PUNCH_ORDER');
      await punch(s, 'AE', 'out', ist('2026-07-22', '19:00')).expect(201);
      const [day] = (await history(s, '2026-07-22')).body;
      expect(day).toMatchObject({ status: 'present', workedMinutes: 600 });
      expect(kinds(day).map((k: string[]) => k[1])).toEqual(['web', 'web']);
    });
  });

  describe('database rules', () => {
    it('a row whose company differs from its employment\'s company is refused', async () => {
      const s = await staff(); // an AE job
      await expect(db.query(`INSERT INTO hrms.work_days (tenant_id, person_id, employment_id, legal_entity_id, work_date, day_status)
        SELECT 1, e.person_id, e.id, (SELECT id FROM core.legal_entities WHERE code = 'ATPL'), DATE '2026-10-26', 'absent'
          FROM hrms.employments e WHERE e.public_id = $1`, [s.jobs.AE])).rejects.toThrow(/work_days_employment_company_fk/);
    });

    it('punches can never be updated or deleted', async () => {
      const s = await staff();
      const id = randomUUID();
      await punch(s, 'AE', 'in', ist('2026-10-09', '09:00'), id).expect(201);
      await expect(db.query(`UPDATE hrms.attendance_events SET occurred_at = occurred_at - interval '1 hour' WHERE public_id = $1`, [id]))
        .rejects.toThrow(/HRMS_PUNCH_APPEND_ONLY/);
      await expect(db.query('DELETE FROM hrms.attendance_events WHERE public_id = $1', [id])).rejects.toThrow(/HRMS_PUNCH_APPEND_ONLY/);
    });

    it('a locked work day cannot change, and rebuild leaves it alone', async () => {
      const s = await staff();
      const day = '2026-10-12';
      await punch(s, 'AE', 'in', ist(day, '09:00')).expect(201);
      await punch(s, 'AE', 'out', ist(day, '17:00')).expect(201);
      // tamper with the stored day, then rebuild repairs it from the punches
      await db.query(`UPDATE hrms.work_days wd SET worked_minutes = 1 FROM hrms.employments e WHERE e.id = wd.employment_id AND e.public_id = $1`, [s.jobs.AE]);
      const rebuilt = await http().post('/api/hrms/attendance/rebuild').set(hr).send({ personPublicId: s.personId, from: day, to: day });
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body).toEqual({ rebuilt: 1, skippedLocked: 0 });
      expect((await history(s, day)).body[0].workedMinutes).toBe(480);

      await db.query(`UPDATE hrms.work_days wd SET locked_for_payroll = true FROM hrms.employments e WHERE e.id = wd.employment_id AND e.public_id = $1`, [s.jobs.AE]);
      await expect(db.query(`UPDATE hrms.work_days wd SET worked_minutes = 1 FROM hrms.employments e WHERE e.id = wd.employment_id AND e.public_id = $1`, [s.jobs.AE]))
        .rejects.toThrow(/HRMS_DAY_LOCKED/);
      const again = await http().post('/api/hrms/attendance/rebuild').set(hr).send({ employmentPublicId: s.jobs.AE, from: day, to: day });
      expect(again.body).toEqual({ rebuilt: 0, skippedLocked: 1 });
    });

    it('rebuild is for HR and admins only', async () => {
      const res = await http().post('/api/hrms/attendance/rebuild').set(tech).send({ personPublicId: DEMO.technician.publicId, from: '2026-10-01', to: '2026-10-02' });
      expect(res.status).toBe(403);
    });
  });

  describe('company day rules (policies)', () => {
    it('a company version of full_day_minutes changes how a day counts, from its date on', async () => {
      // ATPL: 6 hours is a full day from 1 Jun 2026; a newer version back to 8 hours from 8 Jun (a window no other test uses)
      await http().post('/api/core/policies').set(hr).send({ key: 'hrms.attendance.full_day_minutes', company: 'ATPL', value: 360, effectiveFrom: '2026-06-01' }).expect(201);
      await http().post('/api/core/policies').set(hr).send({ key: 'hrms.attendance.full_day_minutes', company: 'ATPL', value: 480, effectiveFrom: '2026-06-08' }).expect(201);
      const s = await staff(['ATPL']);
      for (const day of ['2026-06-03', '2026-06-10']) {
        await punch(s, 'ATPL', 'in', ist(day, '09:00')).expect(201);
        await punch(s, 'ATPL', 'out', ist(day, '15:00')).expect(201);
      }
      const rows = (await history(s, '2026-06-03', '2026-06-10')).body.map((r: { date: string; status: string }) => [r.date, r.status]);
      expect(rows).toEqual([['2026-06-10', 'half_day'], ['2026-06-03', 'present']]);
    });
  });

  describe('register and work hours', () => {
    it('the register lists everyone with an active job: their day, or absent', async () => {
      const worked = await staff();
      const idle = await staff();
      const day = '2026-10-13';
      await punch(worked, 'AE', 'in', ist(day, '09:00')).expect(201);
      await punch(worked, 'AE', 'out', ist(day, '18:00')).expect(201);

      const res = await http().get('/api/hrms/attendance/register').query({ date: day, company: 'AE' }).set(hr);
      expect(res.status).toBe(200);
      const find = (personId: string) => res.body.rows.find((r: { person: { publicId: string } }) => r.person.publicId === personId);
      expect(find(worked.personId)).toMatchObject({ status: 'present', workedMinutes: 540, extraMinutes: 60, approvedOvertimeMinutes: 0 });
      expect(find(idle.personId)).toMatchObject({ status: 'absent', workedMinutes: 0, leaveDays: 0, absentDays: 1 });
      expect(find(worked.personId)).toMatchObject({ leaveDays: 0, absentDays: 0 });
      expect(res.body.totals.absentDays).toBeGreaterThanOrEqual(1);
      expect(res.body.summary.present).toBeGreaterThanOrEqual(1);
      expect((await http().get('/api/hrms/attendance/register').query({ date: day }).set(tech)).status).toBe(403);
    });

    it('work hours add up a person\'s days over a range', async () => {
      const s = await staff();
      for (const [day, out] of [['2026-10-19', '17:00'], ['2026-10-20', '13:00'], ['2026-10-21', null]] as const) {
        await punch(s, 'AE', 'in', ist(day, '09:00')).expect(201);
        if (out) await punch(s, 'AE', 'out', ist(day, out)).expect(201);
        else await punch(s, 'AE', 'out', ist('2026-10-22', '10:00')).expect(201); // forgot to punch out on the 21st
      }
      const res = await http().get('/api/hrms/attendance/work-hours').query({ company: 'AE', from: '2026-10-19', to: '2026-10-21' }).set(hr);
      expect(res.status).toBe(200);
      const row = res.body.rows.find((r: { person: { publicId: string } }) => r.person.publicId === s.personId);
      expect(row).toMatchObject({ days: { present: 1, halfDay: 1, missedPunch: 1, absent: 0 }, workedMinutes: 480 + 240, extraMinutes: 0, approvedOvertimeMinutes: 0,
        leaveDays: 0, absentDays: 0.5, overtimePayable: false });

      // Thu 22 Oct holds only the late punch-out (absent); Fri 23 Oct has nothing at all and still counts as absent
      const wider = await http().get('/api/hrms/attendance/work-hours').query({ company: 'AE', from: '2026-10-19', to: '2026-10-23' }).set(hr);
      const w = wider.body.rows.find((r: { person: { publicId: string } }) => r.person.publicId === s.personId);
      expect(w).toMatchObject({ absentDays: 0.5 + 1 + 1, days: { absent: 2 } });
    });
  });
});
