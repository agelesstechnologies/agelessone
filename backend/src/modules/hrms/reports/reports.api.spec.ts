import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { todayIst } from '../../../platform/time';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';

type Auth = Record<string, string>;
const ist = (date: string, hhmm: string) => `${date}T${hhmm}:00+05:30`;

/** The table part of a report CSV: header and rows (after the "about" lines and a blank line). */
function parseCsv(text: string) {
  const lines = text.replace(/^﻿/, '').trimEnd().split('\r\n');
  const blank = lines.indexOf('');
  return { about: Object.fromEntries(lines.slice(0, blank).map((l) => l.split(','))), header: lines[blank + 1].split(','), rows: lines.slice(blank + 2).map((l) => l.split(',')) };
}

describe('HRMS reports and month lock', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, sup: Auth;
  let db: pg.Client;
  const http = () => request(app.getHttpServer());
  const staff = async (company = 'AE') => {
    const s = await newStaff(app, hr, admin, [company]);
    await http().patch(`/api/hrms/employments/${s.jobs[company]}`).set(hr).send({ managerPublicId: DEMO.supervisor.publicId }).expect(200);
    return s;
  };
  const punch = (s: Staff, kind: 'in' | 'out', at: string) =>
    http().post('/api/hrms/attendance/punches').set(s.auth).send({ publicId: randomUUID(), employmentPublicId: s.jobs.AE, kind, occurredAt: at });

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, sup] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.supervisor].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  describe('month lock', () => {
    // AE, May 2026: no other test touches this month
    it('after HR locks a month nothing can change it; only a System Admin unlocks, with the reason recorded', async () => {
      const s = await staff();
      await punch(s, 'in', ist('2026-05-11', '09:00')).expect(201);
      await punch(s, 'out', ist('2026-05-11', '17:00')).expect(201);

      expect((await http().post('/api/hrms/month-locks').set(admin).send({ company: 'AE', year: 2026, month: 5 })).status).toBe(403);
      const [y, m] = todayIst().split('-').map(Number);
      expect((await http().post('/api/hrms/month-locks').set(hr).send({ company: 'AE', year: y, month: m })).body.code).toBe('HRMS_MONTH_NOT_ENDED');
      const lock = await http().post('/api/hrms/month-locks').set(hr).send({ company: 'AE', year: 2026, month: 5 });
      expect(lock.status).toBe(201);
      expect(lock.body).toMatchObject({ company: 'AE', year: 2026, month: 5, lockedBy: { publicId: DEMO.hr.publicId }, unlockedAt: null });
      expect((await http().post('/api/hrms/month-locks').set(hr).send({ company: 'AE', year: 2026, month: 5 })).body.code).toBe('HRMS_MONTH_ALREADY_LOCKED');

      const day = (await http().get('/api/hrms/attendance/history').query({ from: '2026-05-11', to: '2026-05-11' }).set(s.auth)).body[0];
      expect(day.locked).toBe(true);
      const refused = async (res: request.Test) => expect((await res).body.code).toBe('HRMS_MONTH_LOCKED');
      await refused(punch(s, 'in', ist('2026-05-12', '09:00')));
      await refused(http().post('/api/hrms/attendance/corrections').set(s.auth).send({ employmentPublicId: s.jobs.AE, workDate: '2026-05-11',
        kind: 'missed_out', requestedOut: ist('2026-05-11', '18:00'), reason: 'Left later than recorded' }));
      await refused(http().post('/api/hrms/leave/requests').set(s.auth).send({ employmentPublicId: s.jobs.AE, leaveTypeCode: 'EL', fromDate: '2026-05-13', toDate: '2026-05-13' }));
      await refused(http().post('/api/hrms/leave/requests').set(s.auth).send({ employmentPublicId: s.jobs.AE, leaveTypeCode: 'EL', fromDate: '2026-04-30', toDate: '2026-05-04' }));
      await refused(http().post('/api/hrms/attendance/overtime').set(s.auth).send({ employmentPublicId: s.jobs.AE, workDate: '2026-05-11', minutes: 30, reason: 'Stayed late' }));
      // the database refuses too, even when the services are bypassed
      await expect(db.query(`INSERT INTO hrms.attendance_events (tenant_id, public_id, person_id, employment_id, legal_entity_id, kind, source, occurred_at)
        SELECT 1, gen_random_uuid(), person_id, id, legal_entity_id, 'in', 'web', TIMESTAMPTZ '2026-05-20 09:00+05:30' FROM hrms.employments WHERE public_id = $1`, [s.jobs.AE]))
        .rejects.toThrow(/HRMS_MONTH_LOCKED/);

      expect((await http().post(`/api/hrms/month-locks/${lock.body.publicId}/unlock`).set(hr).send({ reason: 'Payroll mistake' })).status).toBe(403);
      expect((await http().post(`/api/hrms/month-locks/${lock.body.publicId}/unlock`).set(admin).send({ reason: 'oops' })).status).toBe(400);
      const unlocked = await http().post(`/api/hrms/month-locks/${lock.body.publicId}/unlock`).set(admin).send({ reason: 'Late corrections approved by the CEO' });
      expect(unlocked.body).toMatchObject({ unlockedBy: { publicId: DEMO.admin.publicId }, unlockReason: 'Late corrections approved by the CEO' });
      expect(unlocked.body.unlockedAt).not.toBeNull();
      const history = (await http().get('/api/hrms/month-locks').query({ company: 'AE', year: 2026 }).set(hr)).body;
      expect(history.find((l: { publicId: string }) => l.publicId === lock.body.publicId)).toMatchObject({ unlockReason: 'Late corrections approved by the CEO' });
      expect((await http().post(`/api/hrms/month-locks/${lock.body.publicId}/unlock`).set(admin).send({ reason: 'Again please' })).body.code).toBe('HRMS_MONTH_NOT_LOCKED');

      expect((await http().get('/api/hrms/attendance/history').query({ from: '2026-05-11', to: '2026-05-11' }).set(s.auth)).body[0].locked).toBe(false);
      await punch(s, 'in', ist('2026-05-12', '09:00')).expect(201);
    });
  });

  describe('reports: period, company, when produced; CSV totals match the screen', () => {
    it('expenses: per person, category and status; the CSV TOTAL in rupees equals the screen total', async () => {
      const s = await staff();
      const day = '2025-02-10'; // only this test uses this date
      for (const paise of ['1234', '5000']) {
        await http().post('/api/hrms/expenses').set(s.auth).field('employmentPublicId', s.jobs.AE).field('categoryCode', 'food')
          .field('spentOn', day).field('amountPaise', paise).expect(201);
      }
      const q = { company: 'AE', from: day, to: day };
      const screen = (await http().get('/api/hrms/expenses/report').query(q).set(hr)).body;
      expect(screen).toMatchObject({ company: 'AE', from: day, to: day, total: { count: 2, amountPaise: 6234 } });
      expect(screen.producedAt).toBeTruthy();
      expect(screen.rows).toEqual([expect.objectContaining({ person: expect.objectContaining({ publicId: s.personId }), status: 'submitted', count: 2, amountPaise: 6234, currency: 'INR' })]);

      const file = await http().get('/api/hrms/expenses/report').query({ ...q, format: 'csv' }).set(hr);
      expect(file.headers['content-type']).toContain('text/csv');
      const csv = parseCsv(file.text);
      expect(csv.about).toMatchObject({ Report: 'Expenses', Company: 'AE', Period: `${day} to ${day}` });
      const total = csv.rows.find((r) => r[0] === 'TOTAL')!;
      expect(total[csv.header.indexOf('Claimed')]).toBe('62.34');
      expect(Number(total[csv.header.indexOf('Claims')])).toBe(screen.total.count);
    });

    it('work hours: the CSV line equals the screen row', async () => {
      const s = await staff();
      await punch(s, 'in', ist('2026-03-10', '09:00')).expect(201);
      await punch(s, 'out', ist('2026-03-10', '18:30')).expect(201);
      const q = { company: 'AE', from: '2026-03-10', to: '2026-03-10' };
      const screen = (await http().get('/api/hrms/attendance/work-hours').query(q).set(hr)).body;
      expect(screen.producedAt).toBeTruthy();
      const row = screen.rows.find((r: { person: { publicId: string } }) => r.person.publicId === s.personId);
      const csv = parseCsv((await http().get('/api/hrms/attendance/work-hours').query({ ...q, format: 'csv' }).set(hr)).text);
      const line = csv.rows.find((r) => r[1] === row.employment.employeeCode)!;
      expect(Number(line[csv.header.indexOf('Worked minutes')])).toBe(row.workedMinutes);
      expect(Number(line[csv.header.indexOf('Extra minutes')])).toBe(row.extraMinutes);
      expect(Number(line[csv.header.indexOf('Present')])).toBe(row.days.present);
      expect(row).toMatchObject({ workedMinutes: 570, extraMinutes: 90 });
    });

    it('leave: days taken inside the period by type and the current balance; the CSV line equals the screen', async () => {
      const s = await staff();
      await http().post('/api/hrms/leave/ledger/adjustments').set(hr)
        .send({ employmentPublicId: s.jobs.AE, leaveTypeCode: 'EL', year: 2025, entry: 'opening', days: 10, reason: 'Opening balance' }).expect(201);
      // Fri 27 Jun – Tue 1 Jul 2025: Sat 28 (4th Saturday) and Sun 29 are off → June has Fri 27 and Mon 30, July has Tue 1
      const leave = await http().post('/api/hrms/leave/requests').set(s.auth).send({ employmentPublicId: s.jobs.AE, leaveTypeCode: 'EL', fromDate: '2025-06-27', toDate: '2025-07-01' });
      expect(leave.body.days).toBe(3);
      await http().post(`/api/hrms/leave/requests/${leave.body.publicId}/approve`).set(sup).expect(200);

      const q = { company: 'AE', from: '2025-06-01', to: '2025-06-30' };
      const screen = (await http().get('/api/hrms/leave/report').query(q).set(hr)).body;
      expect(screen).toMatchObject({ company: 'AE', from: '2025-06-01', to: '2025-06-30' });
      const mine = screen.people.find((p: { person: { publicId: string } }) => p.person.publicId === s.personId);
      expect(mine).toMatchObject({ takenByType: { EL: 2 }, balanceByType: { EL: 7 }, totalTaken: 2 });

      const csv = parseCsv((await http().get('/api/hrms/leave/report').query({ ...q, format: 'csv' }).set(hr)).text);
      expect(csv.about).toMatchObject({ Report: 'Leave', Company: 'AE', Period: '2025-06-01 to 2025-06-30' });
      const line = csv.rows.find((r) => r[1] === mine.employment.employeeCode && r[3] === 'EL')!;
      expect([Number(line[4]), Number(line[5])]).toEqual([2, 7]);
    });
  });
});
