import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { addDays, todayIst } from '../../../platform/time';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';
import { LeaveService } from './application/leave.service';

type Auth = Record<string, string>;

/** A Monday at least `days` ahead, so the week is all working days. */
function mondayAfter(days: number): string {
  let d = addDays(todayIst(), days);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}

describe('Leave: 1 sick + 1 earned day a month; days beyond the balance are loss of pay; sick leave lapses at year end', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth;
  let s: Staff;
  let service: LeaveService;
  const http = () => request(app.getHttpServer());
  const balances = async () => Object.fromEntries((await http().get('/api/hrms/leave/balances/mine').set(s.auth)).body
    .filter((b: any) => b.employment.company === 'AE').map((b: any) => [b.leaveType.code, b.balance]));

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    s = await newStaff(app, hr, admin, ['AE']);     // joined 2025-04-01
    service = app.get(LeaveService, { strict: false });
  });
  afterAll(async () => { await app?.close(); });

  it('the monthly entitlement adds 1 SL + 1 EL for each month of the year so far, once', async () => {
    expect(await service.runMonthlyLeave('2026-03-15', [s.jobs.AE])).toEqual({ granted: 6, lapsed: 0 });
    expect(await balances()).toMatchObject({ SL: 3, EL: 3 });
    expect(await service.runMonthlyLeave('2026-03-20', [s.jobs.AE])).toEqual({ granted: 0, lapsed: 0 });   // already added
    expect(await balances()).toMatchObject({ SL: 3, EL: 3 });
  });

  it('5 days of earned leave with 3 left: 3 paid, the last 2 are loss of pay for payroll', async () => {
    const monday = mondayAfter(21);
    const applied = await http().post('/api/hrms/leave/requests').set(s.auth)
      .send({ employmentPublicId: s.jobs.AE, leaveTypeCode: 'EL', fromDate: monday, toDate: addDays(monday, 4) });
    expect([applied.status, applied.body.days]).toEqual([201, 5]);
    const approved = await http().post(`/api/hrms/leave/requests/${applied.body.publicId}/approve`).set(hr).send({});
    expect([approved.status, approved.body.unpaidDays]).toEqual([200, 2]);
    expect((await balances()).EL).toBe(0);

    const unpaid = (from: string, to: string) => service.unpaidDaysIn(1, 'AE', from, to).then((m) => m.get(s.jobs.AE) ?? 0);
    expect(await unpaid(monday, addDays(monday, 4))).toBe(2);           // the whole week
    expect(await unpaid(monday, addDays(monday, 2))).toBe(0);           // Mon–Wed are paid
    expect(await unpaid(addDays(monday, 3), addDays(monday, 4))).toBe(2); // Thu–Fri are not
  });

  it('in a new year unused sick leave lapses and earned leave carries forward', async () => {
    expect(await service.runMonthlyLeave('2027-01-05', [s.jobs.AE])).toEqual({ granted: 2, lapsed: 1 });
    expect(await balances()).toMatchObject({ SL: 1, EL: 1 });   // SL: 3 lapsed, +1 for January; EL: 0 carried, +1
  });

  it('the old General leave can no longer be applied for', async () => {
    const res = await http().post('/api/hrms/leave/requests').set(s.auth)
      .send({ employmentPublicId: s.jobs.AE, leaveTypeCode: 'GL', fromDate: mondayAfter(90), toDate: mondayAfter(90) });
    expect([res.status, res.body.code]).toEqual([400, 'HRMS_LEAVE_TYPE_INACTIVE']);
  });
});
