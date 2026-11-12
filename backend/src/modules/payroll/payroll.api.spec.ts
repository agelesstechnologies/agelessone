import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { peopleApi } from '../../test/people';
import { newStaff, Staff } from '../../test/staff';

type Auth = Record<string, string>;
const MONTHLY = 3_000_000; // INR 30,000.00
// ATPL, November 2025 (30 days; Sundays and the 8th and 22nd are weekly offs): no other test uses this month.

/** The table part of a CSV file (after the "about" lines and a blank line). */
function parseCsv(text: string) {
  const lines = text.replace(/^﻿/, '').trimEnd().split('\r\n');
  const blank = lines.indexOf('');
  return { about: Object.fromEntries(lines.slice(0, blank).map((l) => [l.split(',')[0], l.split(',').slice(1).join(',')])),
    header: lines[blank + 1].split(','), rows: lines.slice(blank + 2).map((l) => l.split(',')) };
}

describe('Payroll API', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, mgr: Auth, sup: Auth, ceo: Auth;
  let db: pg.Client;
  let worker: Staff;               // full month, 2 working days absent
  let joinerJob: string;           // joined on 16 Nov
  let preparer: Auth;              // holds both payroll roles (to test self-approval)
  let runId: string;
  const http = () => request(app.getHttpServer());
  /** Present on every date from..to except the given ones (filled before the month is locked). */
  const present = (job: string, from: string, to: string, except: string[] = []) => db.query(
    `INSERT INTO hrms.work_days (tenant_id, person_id, employment_id, legal_entity_id, work_date, day_status, worked_minutes)
     SELECT 1, e.person_id, e.id, e.legal_entity_id, d::date, 'present', 480
       FROM hrms.employments e, generate_series($2::date, $3::date, interval '1 day') d
      WHERE e.public_id = $1 AND NOT (d::date = ANY($4::date[]))`, [job, from, to, except]);
  const run = async (auth = hr) => (await http().get(`/api/payroll/runs/${runId}`).set(auth)).body;
  const itemOf = (r: { items: { employment: { publicId: string } }[] }, job: string) => r.items.find((i) => i.employment.publicId === job) as any;

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, mgr, sup, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.manager, DEMO.supervisor, DEMO.ceo].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();

    worker = await newStaff(app, hr, admin, ['ATPL']);
    const people = peopleApi(app, hr);
    joinerJob = await people.employmentIn(await people.createPerson({ company: 'ATPL', joinedOn: '2025-11-16' }), 'ATPL');
    for (const [job, from] of [[worker.jobs.ATPL, '2025-04-01'], [joinerJob, '2025-11-16']]) {
      await http().post('/api/payroll/salaries').set(hr).send({ employmentPublicId: job, monthlyAmountPaise: MONTHLY, effectiveFrom: from }).expect(201);
    }
    await present(worker.jobs.ATPL, '2025-11-01', '2025-11-30', ['2025-11-10', '2025-11-11']);
    await present(joinerJob, '2025-11-16', '2025-11-30');
    await http().post('/api/payroll/bank-accounts').set(hr).send({ employmentPublicId: worker.jobs.ATPL, accountHolder: 'Test Worker',
      accountNumber: '000011112222', ifsc: 'TEST0001234', effectiveFrom: '2025-04-01' }).expect(201);

    // someone holding both payroll roles, to show nobody approves what they prepared
    const p = await newStaff(app, hr, admin, ['ATPL']);
    for (const roleCode of ['payroll', 'payroll_approver']) {
      await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: p.personId, roleCode, scope: 'all' }).expect(201);
    }
    preparer = p.auth;
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('no run before the month\'s attendance is locked', async () => {
    const res = await http().post('/api/payroll/runs').set(hr).send({ company: 'ATPL', year: 2025, month: 11 });
    expect([res.status, res.body.code]).toEqual([409, 'HRMS_MONTH_NOT_LOCKED']);
  });

  it('a run pays every job with a salary: loss of pay for 2 absent days; a mid-month joiner only for their days', async () => {
    await http().post('/api/hrms/month-locks').set(hr).send({ company: 'ATPL', year: 2025, month: 11 }).expect(201);
    const created = await http().post('/api/payroll/runs').set(hr).send({ company: 'ATPL', year: 2025, month: 11 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ company: 'ATPL', year: 2025, month: 11, status: 'draft', preparedBy: { publicId: DEMO.hr.publicId } });
    runId = created.body.publicId;
    expect((await http().post('/api/payroll/runs').set(hr).send({ company: 'ATPL', year: 2025, month: 11 })).status).toBe(200); // the same month again

    expect(itemOf(created.body, worker.jobs.ATPL)).toMatchObject({
      monthlySalaryPaise: MONTHLY, daysInMonth: 30, employedDays: 30, absentDays: 2, lopAmountPaise: 200_000, salaryForMonthPaise: 2_800_000, netPayPaise: 2_800_000,
    });
    expect(itemOf(created.body, joinerJob)).toMatchObject({ employedDays: 15, absentDays: 0, lopAmountPaise: 0, salaryForMonthPaise: 1_500_000 });
    // jobs with no salary are listed, not paid
    expect(created.body.withoutSalary.length).toBeGreaterThan(0);
    expect(created.body.items).toHaveLength(2);
  });

  it('adjustments change net pay while the run is a draft; recalculating keeps them', async () => {
    const item = itemOf(await run(), worker.jobs.ATPL).publicId;
    const pt = randomUUID();
    const add = (body: Record<string, unknown>) => http().post(`/api/payroll/items/${item}/adjustments`).set(hr).send(body);
    expect(itemOf((await add({ publicId: pt, kind: 'deduction', label: 'PT', amountPaise: 20_000 })).body, worker.jobs.ATPL).netPayPaise).toBe(2_780_000);
    expect((await add({ publicId: pt, kind: 'deduction', label: 'PT', amountPaise: 20_000 })).status).toBe(200); // sent again: stored once
    const withBonus = (await add({ kind: 'addition', label: 'Bonus', amountPaise: 50_000 })).body;
    expect(itemOf(withBonus, worker.jobs.ATPL)).toMatchObject({ additionsTotalPaise: 50_000, deductionsTotalPaise: 20_000, netPayPaise: 2_830_000 });

    const bonus = itemOf(withBonus, worker.jobs.ATPL).adjustments.find((a: { label: string }) => a.label === 'Bonus').publicId;
    expect(itemOf((await http().patch(`/api/payroll/adjustments/${pt}`).set(hr).send({ amountPaise: 25_000 })).body, worker.jobs.ATPL).netPayPaise).toBe(2_825_000);
    expect(itemOf((await http().delete(`/api/payroll/adjustments/${bonus}`).set(hr)).body, worker.jobs.ATPL).netPayPaise).toBe(2_775_000);
    const tooMuch = await add({ kind: 'deduction', label: 'Advance', amountPaise: 9_000_000 });
    expect([tooMuch.status, tooMuch.body.code]).toEqual([409, 'PAYROLL_NET_NEGATIVE']);

    const again = await http().post(`/api/payroll/runs/${runId}/recalculate`).set(preparer);
    expect(itemOf(again.body, worker.jobs.ATPL)).toMatchObject({ netPayPaise: 2_775_000, adjustments: [expect.objectContaining({ label: 'PT', amountPaise: 25_000 })] });
    expect(again.body.preparedBy.publicId).not.toBe(DEMO.hr.publicId);
  });

  it('nobody approves a run they prepared; once approved nothing can change; paid needs a date and a reference', async () => {
    const self = await http().post(`/api/payroll/runs/${runId}/approve`).set(preparer);
    expect([self.status, self.body.code]).toEqual([403, 'PAYROLL_SELF_APPROVAL']);
    expect((await http().post(`/api/payroll/runs/${runId}/approve`).set(hr)).status).toBe(403); // HR has no approve permission

    const approved = await http().post(`/api/payroll/runs/${runId}/approve`).set(ceo);
    expect(approved.body).toMatchObject({ status: 'approved', approvedBy: { publicId: DEMO.ceo.publicId } });

    const item = itemOf(approved.body, worker.jobs.ATPL);
    const late = await http().post(`/api/payroll/items/${item.publicId}/adjustments`).set(hr).send({ kind: 'addition', label: 'Bonus', amountPaise: 1_000 });
    expect([late.status, late.body.code]).toEqual([409, 'PAYROLL_RUN_NOT_DRAFT']);
    expect((await http().post(`/api/payroll/runs/${runId}/recalculate`).set(hr)).body.code).toBe('PAYROLL_RUN_NOT_DRAFT');
    expect((await http().delete(`/api/payroll/adjustments/${item.adjustments[0].publicId}`).set(hr)).body.code).toBe('PAYROLL_RUN_NOT_DRAFT');
    await expect(db.query('UPDATE payroll.payroll_items SET net_pay_paise = net_pay_paise WHERE public_id = $1', [item.publicId])).rejects.toThrow(/PAYROLL_RUN_FROZEN/);

    expect((await http().post(`/api/payroll/runs/${runId}/mark-paid`).set(hr).send({ paidAt: '2025-12-01T10:00:00+05:30' })).status).toBe(400);
    const paid = await http().post(`/api/payroll/runs/${runId}/mark-paid`).set(hr).send({ paidAt: '2025-12-01T10:00:00+05:30', bankRef: 'NEFT-TEST-0001' });
    expect(paid.body).toMatchObject({ status: 'paid', bankRef: 'NEFT-TEST-0001' });
    await expect(db.query(`UPDATE payroll.payroll_runs SET bank_ref = 'X' WHERE public_id = $1`, [runId])).rejects.toThrow(/PAYROLL_RUN_FROZEN/);
  });

  it('register and bank files show company, month, status and when produced; totals match the run', async () => {
    const r = await run();
    const register = parseCsv((await http().get(`/api/payroll/runs/${runId}/register`).set(hr)).text);
    expect(register.about).toMatchObject({ Report: 'Salary register', Company: 'ATPL', Month: 'November 2025', Status: 'paid' });
    expect(register.about['Produced at']).toBeTruthy();
    const total = register.rows.find((x) => x[0] === 'TOTAL')!;
    expect(total[register.header.indexOf('Net pay')]).toBe(((r.totals.netPaise as number) / 100).toFixed(2));
    expect(r.totals.netPaise).toBe(2_775_000 + 1_500_000);

    const bankFile = await http().get(`/api/payroll/runs/${runId}/bank-file`).set(ceo);
    const bank = parseCsv(bankFile.text);
    expect(bank.rows).toEqual([['Test Worker', '000011112222', 'TEST0001234', '27750.00', itemOf(r, worker.jobs.ATPL).employment.employeeCode, 'Salary November 2025']]);
    expect(bank.about['Without bank details']).toBe(itemOf(r, joinerJob).employment.employeeCode);
    const masked = (await http().get('/api/payroll/bank-accounts').query({ company: 'ATPL' }).set(hr)).body;
    expect(masked.find((b: { employment: { publicId: string } }) => b.employment.publicId === worker.jobs.ATPL).accountNumberMasked).toBe('XXXXXXXX2222');
  });

  it('an employee sees only their own payslip', async () => {
    const mine = await http().get('/api/payroll/payslips/mine').set(worker.auth);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0]).toMatchObject({ run: { company: 'ATPL', month: 11, status: 'paid' }, item: { netPayPaise: 2_775_000 } });

    const pdf = await http().get(`/api/payroll/payslips/${mine.body[0].item.publicId}/pdf`).set(worker.auth).buffer(true);
    expect([pdf.status, pdf.headers['content-type']]).toEqual([200, 'application/pdf']);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    const others = itemOf(await run(), joinerJob).publicId;
    expect((await http().get(`/api/payroll/payslips/${others}/pdf`).set(worker.auth)).status).toBe(403);
    expect((await http().get(`/api/payroll/payslips/${others}/pdf`).set(hr)).status).toBe(200);
  });

  it('salaries and runs are only for the payroll roles: a manager, a supervisor or an employee sees nothing', async () => {
    for (const path of ['/api/payroll/salaries', '/api/payroll/runs', '/api/payroll/bank-accounts', `/api/payroll/runs/${runId}`, `/api/payroll/runs/${runId}/register`]) {
      for (const who of [mgr, sup, worker.auth]) expect((await http().get(path).set(who)).status).toBe(403);
    }
    for (const who of [mgr, sup]) {
      expect((await http().post('/api/payroll/salaries').set(who).send({ employmentPublicId: worker.jobs.ATPL, monthlyAmountPaise: 1, effectiveFrom: '2026-01-01' })).status).toBe(403);
    }
    const list = (await http().get('/api/payroll/salaries').query({ employment: worker.jobs.ATPL }).set(ceo)).body;
    expect(list).toEqual([expect.objectContaining({ monthlyAmountPaise: MONTHLY, effectiveFrom: '2025-04-01' })]);
    await expect(db.query('UPDATE payroll.salaries SET monthly_amount_paise = 1 WHERE public_id = $1', [list[0].publicId])).rejects.toThrow(/PAYROLL_APPEND_ONLY/);
  });
});
