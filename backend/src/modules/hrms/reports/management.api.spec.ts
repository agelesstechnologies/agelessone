import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { addDays, todayIst } from '../../../platform/time';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';

type Auth = Record<string, string>;
const CEO_JOB = '00000000-0000-4000-8000-000000000106'; // Demo CEO's job in AE (seed)

/** A Wednesday at least `days` ahead (dates no other test file uses). */
function wednesdayAfter(days: number): string {
  let d = addDays(todayIst(), days);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 3) d = addDays(d, 1);
  return d;
}
const DAY = wednesdayAfter(150);
const letters = (n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

describe('HRMS management access, approvals inbox and dashboard', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, sup: Auth, ceo: Auth;
  let db: pg.Client;
  const http = () => request(app.getHttpServer());
  const staff = (companies?: string[]) => newStaff(app, hr, admin, companies);
  const managedBySupervisor = async (s: Staff, company = 'AE') =>
    http().patch(`/api/hrms/employments/${s.jobs[company]}`).set(hr).send({ managerPublicId: DEMO.supervisor.publicId }).expect(200);
  const applyLeave = (auth: Auth, employmentPublicId: string, date: string, extra: Record<string, unknown> = {}) =>
    http().post('/api/hrms/leave/requests').set(auth).send({ employmentPublicId, leaveTypeCode: 'GL', fromDate: date, toDate: date, ...extra });
  const leaveAct = (auth: Auth, id: string, action: 'approve' | 'reject', body: Record<string, unknown> = {}) =>
    http().post(`/api/hrms/leave/requests/${id}/${action}`).set(auth).send(body);
  const claim = (auth: Auth, employmentPublicId: string, amountPaise: number) =>
    http().post('/api/hrms/expenses').set(auth).field('employmentPublicId', employmentPublicId).field('categoryCode', 'food')
      .field('amountPaise', String(amountPaise)).field('spentOn', '2026-02-10');
  const glBalance = async (auth: Auth) => (await http().get('/api/hrms/leave/balances/mine').set(auth)).body
    .find((b: { employment: { company: string }; leaveType: { code: string } }) => b.employment.company === 'AE' && b.leaveType.code === 'GL')?.balance ?? 0;
  const audit = async (action: string, entityPublicId: string) =>
    (await db.query('SELECT * FROM core.audit_log WHERE action = $1 AND entity_public_id = $2', [action, entityPublicId])).rows;

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, sup, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.supervisor, DEMO.ceo].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  describe('requests by the CEO need no approval', () => {
    it("the CEO's own leave is approved on submit with no decider, the balance changes and the day becomes leave", async () => {
      const before = await glBalance(ceo);
      const res = await applyLeave(ceo, CEO_JOB, DAY);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'approved', approver: null, decidedBy: null, decidedAs: 'no_approval_required', days: 1 });
      expect(await glBalance(ceo)).toBe(before - 1);
      const history = (await http().get('/api/hrms/attendance/history').query({ from: DAY, to: DAY }).set(ceo)).body;
      expect(history.find((r: { employment: { company: string } }) => r.employment.company === 'AE')).toMatchObject({ status: 'leave', leaveDays: 1 });
      const [entry] = await audit('leave.auto_approved', res.body.publicId);
      expect(entry).toMatchObject({ actor_person_id: expect.anything(), summary: expect.stringContaining('no approval required') });
    });

    it("the CEO's own expense is approved on submit for the full amount and still waits for payment", async () => {
      const res = await claim(ceo, CEO_JOB, 45000);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'approved', approvedBy: null, decidedAs: 'no_approval_required', approvedAmountPaise: 45000, paidAt: null });
      const paid = await http().post(`/api/hrms/expenses/${res.body.publicId}/mark-paid`).set(hr).send({ paymentRef: 'UTR-TEST-MGMT-1' });
      expect([paid.status, paid.body.status]).toEqual([200, 'paid']);
      expect(await audit('expense.auto_approved', res.body.publicId)).toHaveLength(1);
    });

    it("a non-CEO's request still waits for an approver, whatever the request body says", async () => {
      const s = await staff();
      const res = await applyLeave(s.auth, s.jobs.AE, DAY, { status: 'approved', decidedAs: 'no_approval_required', decidedBy: null });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'submitted', decidedAs: null, decidedBy: null, approver: { publicId: DEMO.hr.publicId } });
      // a decision body cannot choose how it is recorded either
      const approved = await leaveAct(hr, res.body.publicId, 'approve', { decidedAs: 'no_approval_required' });
      expect(approved.body).toMatchObject({ status: 'approved', decidedAs: 'approver', decidedBy: { publicId: DEMO.hr.publicId } });
    });

    it('the database allows no decider only for no_approval_required, and no_approval_required only without one', async () => {
      const s = await staff();
      const res = await applyLeave(s.auth, s.jobs.AE, addDays(DAY, 7));
      const { rows: [r] } = await db.query('SELECT id FROM hrms.leave_requests WHERE public_id = $1', [res.body.publicId]);
      await expect(db.query(`UPDATE hrms.leave_requests SET status = 'approved', decided_at = now(), decided_as = 'approver' WHERE id = $1`, [r.id]))
        .rejects.toThrow(/leave_requests_decider_required/);
      await expect(db.query(`UPDATE hrms.leave_requests SET status = 'approved', decided_at = now(), decided_as = 'no_approval_required',
        decided_by = (SELECT id FROM core.persons WHERE public_id = $2) WHERE id = $1`, [r.id, DEMO.hr.publicId]))
        .rejects.toThrow(/leave_requests_decider_required/);
      const { rows: [c] } = await db.query('SELECT id FROM hrms.expense_claims WHERE public_id = $1', [(await claim(s.auth, s.jobs.AE, 1000)).body.publicId]);
      await expect(db.query(`UPDATE hrms.expense_claims SET status = 'approved', approved_at = now(), approved_amount_paise = 1000, decided_as = 'hr' WHERE id = $1`, [c.id]))
        .rejects.toThrow(/expense_claims_decider_required/);
    });
  });

  describe('Management decisions', () => {
    it('Management approves any pending request; it is recorded as management and shows in their inbox', async () => {
      const s = await staff();
      await managedBySupervisor(s);
      const leave = await applyLeave(s.auth, s.jobs.AE, addDays(DAY, 14));
      expect(leave.body.approver.publicId).toBe(DEMO.supervisor.publicId); // named approver: the supervisor
      const expense = await claim(s.auth, s.jobs.AE, 2500);

      const inbox = await http().get('/api/hrms/approvals/mine').set(ceo);
      expect(inbox.status).toBe(200);
      expect(inbox.body.counts).toMatchObject({ ticketReassignment: null });
      expect(inbox.body.counts.total).toBe(inbox.body.items.length);
      const ids = inbox.body.items.map((i: { publicId: string }) => i.publicId);
      expect(ids).toEqual(expect.arrayContaining([leave.body.publicId, expense.body.publicId]));
      expect(inbox.body.items.find((i: { publicId: string }) => i.publicId === expense.body.publicId))
        .toMatchObject({ type: 'expense', person: { publicId: s.personId }, company: 'AE', amountPaise: 2500, currency: 'INR', ageDays: 0 });

      const approved = await leaveAct(ceo, leave.body.publicId, 'approve');
      expect(approved.body).toMatchObject({ status: 'approved', decidedAs: 'management', decidedBy: { publicId: DEMO.ceo.publicId } });
      const rejected = await http().post(`/api/hrms/expenses/${expense.body.publicId}/reject`).set(ceo).send({ reason: 'Not a work expense' });
      expect(rejected.body).toMatchObject({ status: 'rejected', decidedAs: 'management', rejectedBy: { publicId: DEMO.ceo.publicId } });
      expect(await audit('leave.approved', leave.body.publicId)).toHaveLength(1);

      // the named approver is recorded as approver
      const next = await applyLeave(s.auth, s.jobs.AE, addDays(DAY, 15));
      expect((await leaveAct(sup, next.body.publicId, 'approve')).body.decidedAs).toBe('approver');
    });

    it("Management (not the CEO role) can't approve their own request, which waits for an approver", async () => {
      const m = await staff();
      await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: m.personId, roleCode: 'management', scope: 'all' }).expect(201);
      const own = await applyLeave(m.auth, m.jobs.AE, addDays(DAY, 21));
      expect(own.body).toMatchObject({ status: 'submitted', approver: { publicId: DEMO.hr.publicId } });
      const self = await leaveAct(m.auth, own.body.publicId, 'approve');
      expect([self.status, self.body.code]).toEqual([403, 'HRMS_SELF_APPROVAL']);
      const mine = (await http().get('/api/hrms/approvals/mine').set(m.auth)).body.items.map((i: { publicId: string }) => i.publicId);
      expect(mine).not.toContain(own.body.publicId);
    });
  });

  describe('private details', () => {
    it('are masked for HR and Management, hidden from others, and shown in full only by an audited reveal', async () => {
      const s = await staff();
      await managedBySupervisor(s);
      const set = await http().put(`/api/hrms/people/${s.personId}/private`).set(hr).send({ aadhaar: '9999 8888 7777', pan: 'abcde1234f' });
      expect(set.status).toBe(200);
      expect(set.body).toEqual({ masked: true, aadhaar: 'XXXX XXXX 7777', pan: 'XXXXXX234F', bankAccounts: [] });
      expect((await http().put(`/api/hrms/people/${s.personId}/private`).set(hr).send({ aadhaar: '1234' })).status).toBe(400);

      expect((await http().get(`/api/hrms/people/${s.personId}`).set(hr)).body.private).toMatchObject({ masked: true, aadhaar: 'XXXX XXXX 7777' });
      expect((await http().get(`/api/hrms/people/${s.personId}`).set(ceo)).body.private).toMatchObject({ masked: true, pan: 'XXXXXX234F' });
      expect((await http().get(`/api/hrms/people/${s.personId}`).set(sup)).body.private).toBeNull(); // their manager, but no private access

      expect((await http().post(`/api/hrms/people/${s.personId}/private/reveal`).set(hr)).status).toBe(403);
      expect(await audit('private.revealed', s.personId)).toHaveLength(0);

      const revealed = await http().post(`/api/hrms/people/${s.personId}/private/reveal`).set(ceo);
      expect(revealed.status).toBe(200);
      expect(revealed.body).toEqual({ masked: false, aadhaar: '999988887777', pan: 'ABCDE1234F', bankAccounts: [] });
      const entries = await audit('private.revealed', s.personId);
      expect(entries).toHaveLength(1);
      const { rows: [actor] } = await db.query('SELECT id FROM core.persons WHERE public_id = $1', [DEMO.ceo.publicId]);
      expect(Number(entries[0].actor_person_id)).toBe(Number(actor.id));
      // the audit log never holds the values
      const written = JSON.stringify([...entries, ...await audit('private.updated', s.personId)]);
      expect(written).not.toContain('7777');
      expect(written).not.toContain('1234F');
    });
  });

  describe('dashboard', () => {
    it('a supervisor sees only their team; HR sees everyone', async () => {
      // a fresh department with one of the supervisor's people and one other person
      const prefix = letters(5);
      await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Dashboard test ${prefix}`, codePrefix: prefix }).expect(201);
      const [mine, other] = await Promise.all([staff(), staff()]);
      await managedBySupervisor(mine);
      for (const s of [mine, other]) await http().patch(`/api/hrms/employments/${s.jobs.AE}`).set(hr).send({ departmentCode: prefix }).expect(200);

      const supView = await http().get('/api/hrms/dashboard').set(sup);
      expect(supView.status).toBe(200);
      expect(supView.body.scope).toMatchObject({ visibility: 'team', company: 'all' });
      expect(supView.body.totals).toMatchObject({ openPositions: null, openTickets: null, documentsExpiring: null });
      expect(supView.body.departments.find((d: { code: string }) => d.code === prefix)).toMatchObject({ company: 'AE', headcount: 1 });

      const hrView = await http().get('/api/hrms/dashboard').query({ company: 'AE' }).set(hr);
      expect(hrView.body.scope).toEqual({ visibility: 'all', company: 'AE', companies: ['AE'] });
      expect(hrView.body.departments.find((d: { code: string }) => d.code === prefix)).toMatchObject({ headcount: 2 });
      expect(hrView.body.totals.employees).toBeGreaterThan(supView.body.totals.employees);

      const tech = await staff();
      expect((await http().get('/api/hrms/dashboard').set(tech.auth)).status).toBe(403);
      expect((await http().get('/api/hrms/dashboard').query({ company: 'NOPE' }).set(hr)).status).toBe(400);
    });

    it('Management sees both companies, with the month, as-of time and every section', async () => {
      const month = todayIst().slice(0, 7);
      const res = await http().get('/api/hrms/dashboard').query({ company: 'all', month }).set(ceo);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ month, scope: { visibility: 'all', company: 'all' } });
      expect(res.body.scope.companies).toEqual(expect.arrayContaining(['AE', 'ATPL']));
      expect(Date.parse(res.body.asOf)).not.toBeNaN();
      expect(typeof res.body.totals.openPositions).toBe('number');
      expect(res.body.totals).toMatchObject({ openTickets: null, documentsExpiring: null });
      expect(res.body.myApprovals.ticketReassignment).toBeNull();
      expect(res.body.attendance.daily.length).toBe(Number(todayIst().slice(8, 10)));
      expect(res.body.comparison.lastMonth.month).not.toBe(month);
      expect(res.body.recentActivity.length).toBeLessThanOrEqual(20);
      expect((await http().get('/api/hrms/dashboard').query({ month: '2026-13' }).set(ceo)).status).toBe(400);
    });
  });
});
