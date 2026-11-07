import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { addDays, todayIst } from '../../../platform/time';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff, Staff } from '../../../test/staff';
import { ApprovalsInboxService } from './application/approvals-inbox.service';

type Auth = Record<string, string>;

/** A Monday at least `days` ahead (working days, far from other tests' leave). */
function mondayAfter(days: number): string {
  let d = addDays(todayIst(), days);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}

describe('Sending requests to the CEO (forward, or automatically after waiting)', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth, ceo: Auth, tech: Auth;
  let monday = mondayAfter(120);
  const http = () => request(app.getHttpServer());
  /** A fresh employee's leave on the next free Monday; with no manager its approver is HR. */
  const leave = async (s?: Staff) => {
    const who = s ?? await newStaff(app, hr, admin, ['ATPL']);
    const res = await http().post('/api/hrms/leave/requests').set(who.auth)
      .send({ employmentPublicId: who.jobs.ATPL, leaveTypeCode: 'GL', fromDate: monday, toDate: monday });
    expect(res.status).toBe(201);
    monday = addDays(monday, 7);
    return { staff: who, id: res.body.publicId as string };
  };
  const forward = (auth: Auth, id: string, reason = 'Over my limit, needs the CEO') =>
    http().post(`/api/hrms/leave/requests/${id}/forward`).set(auth).send({ reason });
  const inbox = (auth: Auth, query: Record<string, string> = {}) => http().get('/api/hrms/approvals/mine').query(query).set(auth);

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo, tech] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo, DEMO.technician].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('the approver forwards with a reason; it shows for the CEO as sent to the CEO; sent twice, stored once', async () => {
    const { id } = await leave();
    const res = await forward(hr, id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'submitted', escalation: { reason: 'Over my limit, needs the CEO', by: { publicId: DEMO.hr.publicId }, at: expect.any(String) } });

    const again = await forward(hr, id, 'Another reason');
    expect([again.status, again.body.escalation]).toEqual([200, res.body.escalation]);

    const sent = (await inbox(ceo, { escalated: 'true', company: 'ATPL' })).body;
    expect(sent.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'leave', publicId: id, company: 'ATPL', escalation: res.body.escalation })]));
    expect(sent.items.every((i: any) => i.escalation !== null && i.company === 'ATPL')).toBe(true);
    expect(sent.counts.total).toBe(sent.items.length);
    const notSent = (await inbox(ceo, { escalated: 'false' })).body;
    expect(notSent.items.some((i: any) => i.publicId === id)).toBe(false);
  });

  it('only someone who may decide it can forward it; never your own; a reason is required', async () => {
    const { staff, id } = await leave();
    expect((await forward(tech, id)).status).toBe(403);
    expect((await forward(staff.auth, id)).status).toBe(403);
    const short = await forward(hr, id, 'no');
    expect([short.status, short.body.code]).toEqual([400, 'VALIDATION']);
    expect((await forward(hr, randomUUID())).status).toBe(404);
  });

  it('after forwarding, both the approver and the CEO may decide it; the first decision wins', async () => {
    const { id } = await leave();
    await forward(hr, id).expect(200);
    const first = await http().post(`/api/hrms/leave/requests/${id}/approve`).set(ceo).send({});
    expect([first.status, first.body.status, first.body.decidedAs]).toEqual([200, 'approved', 'management']);
    const second = await http().post(`/api/hrms/leave/requests/${id}/reject`).set(hr).send({ reason: 'Too late' });
    expect([second.status, second.body.code]).toEqual([409, 'HRMS_LEAVE_NOT_PENDING']);
    expect((await forward(hr, id)).status).toBe(409);   // decided: nothing left to forward
  });

  it('the daily job sends requests waiting 5 days (policy default) to the CEO, with no forwarder', async () => {
    const old = await leave();
    const recent = await leave();
    const backdate = (id: string, days: number) =>
      db.query(`UPDATE hrms.leave_requests SET created_at = now() - make_interval(days => $2) WHERE public_id = $1`, [id, days]);
    await backdate(old.id, 6);
    await backdate(recent.id, 3);

    const sent = await app.get(ApprovalsInboxService, { strict: false }).escalateWaiting();
    expect(sent).toBeGreaterThanOrEqual(1);
    const view = async (s: Staff, id: string) => (await http().get('/api/hrms/leave/requests/mine').set(s.auth)).body.find((r: any) => r.publicId === id);
    expect((await view(old.staff, old.id)).escalation).toEqual({ at: expect.any(String), by: null, reason: 'No decision in 5 days' });
    expect((await view(recent.staff, recent.id)).escalation).toBeNull();

    // running again changes nothing for what was already sent
    await app.get(ApprovalsInboxService, { strict: false }).escalateWaiting();
    expect((await view(old.staff, old.id)).escalation.reason).toBe('No decision in 5 days');
  });

  it('every request type has a forward endpoint', async () => {
    for (const path of ['/api/hrms/expenses', '/api/hrms/attendance/corrections', '/api/hrms/attendance/overtime']) {
      const res = await http().post(`${path}/${randomUUID()}/forward`).set(hr).send({ reason: 'Needs the CEO' });
      expect([path, res.status]).toEqual([path, 404]);
    }
  });
});
