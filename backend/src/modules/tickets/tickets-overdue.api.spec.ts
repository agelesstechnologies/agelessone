import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff, Staff } from '../../test/staff';
import { tag } from '../../test/people';
import { addDays, todayIst } from '../../platform/time';
import { TicketOverdueService } from './application/ticket-overdue.service';

type Auth = Record<string, string>;
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
/** today + n days (IST): -1 = yesterday */
const day = (n: number) => addDays(todayIst(), n);

describe('Overdue ticket escalation', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, ceo: Auth, adminUser: Auth;
  let head: Staff, otherHead: Staff;
  let dept: string, siteWork: string;
  let job: TicketOverdueService;
  const http = () => request(app.getHttpServer());

  const ticket = async (dueDate: string) => (await http().post('/api/tickets').set(adminUser).send({ company: 'AE', typePublicId: siteWork,
    title: `Overdue ${tag()}`, departmentPublicId: dept, scheduledAt: new Date(`${day(-10)}T09:00:00+05:30`).toISOString(), dueDate,
    details: { site: 'Goa' } }).expect(201)).body;
  const alerts = async (who: Auth) => (await http().get('/api/tickets/overdue-alerts').set(who).expect(200)).body as any[];
  const alertOf = async (who: Auth, t: { publicId: string }) => (await alerts(who)).find((a) => a.ticket.publicId === t.publicId);
  const events = async (t: { publicId: string }, action: string) =>
    ((await http().get(`/api/tickets/${t.publicId}`).set(hr).expect(200)).body.timeline as { action: string }[]).filter((e) => e.action === action).length;

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo].map((d) => signIn(app, d.login)));
    const grant = (personId: string, roleCode: string, scope: string) =>
      http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode, scope }).expect(201);
    [head, otherHead] = await Promise.all([newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE'])]);
    await grant(head.personId, 'manager', 'team');
    await grant(otherHead.personId, 'manager', 'team');
    const a = await newStaff(app, hr, admin, ['AE']);
    await grant(a.personId, 'admin_user', 'all');
    await grant(a.personId, 'manager', 'team');
    adminUser = a.auth;
    dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Overdue ${tag()}`, codePrefix: letters() }).expect(201)).body.publicId;
    await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: head.personId }).expect(200);
    siteWork = (await http().get('/api/tickets/types').query({ company: 'AE' }).set(hr)).body.find((t: { code: string }) => t.code === 'site_work').publicId;
    job = app.get(TicketOverdueService, { strict: false });
  }, 60_000);
  afterAll(async () => { await app?.close(); });

  it('one day overdue alerts the head; four days overdue also goes to the CEO (policy: 3); running the job again changes nothing', async () => {
    const [oneDay, fourDays, notYet] = [await ticket(day(-1)), await ticket(day(-4)), await ticket(day(1))];
    expect(await alertOf(head.auth, oneDay)).toBeUndefined();          // nothing until the daily job runs

    const run = await job.escalateOverdue();
    expect(run.alerted).toBeGreaterThanOrEqual(2);
    expect(run.sentToCeo).toBeGreaterThanOrEqual(1);

    expect(await alertOf(head.auth, oneDay)).toMatchObject({ daysOverdue: 1, dueDate: day(-1), sentToCeoAt: null, department: { publicId: dept } });
    expect((await alertOf(head.auth, fourDays))?.daysOverdue).toBe(4);
    expect((await alertOf(head.auth, fourDays))?.sentToCeoAt).not.toBeNull();
    expect(await alertOf(head.auth, notYet)).toBeUndefined();
    expect(await alertOf(otherHead.auth, oneDay)).toBeUndefined();        // a head of another department is not alerted

    expect(await alertOf(ceo, fourDays)).toBeDefined();                    // the CEO sees only what was sent to them
    expect(await alertOf(ceo, oneDay)).toBeUndefined();
    expect(await alertOf(adminUser, oneDay)).toBeDefined();               // the admin user runs every ticket

    await job.escalateOverdue();
    expect([await events(fourDays, 'overdue_head_alerted'), await events(fourDays, 'overdue_sent_to_ceo')]).toEqual([1, 1]);
    expect([await events(oneDay, 'overdue_head_alerted'), await events(oneDay, 'overdue_sent_to_ceo')]).toEqual([1, 0]);
  });

  it('a new due date starts again; a finished ticket drops out', async () => {
    const [moved, cancelled] = [await ticket(day(-5)), await ticket(day(-5))];
    await job.escalateOverdue();
    expect(await alertOf(ceo, moved)).toBeDefined();

    await http().patch(`/api/tickets/${moved.publicId}`).set(head.auth).send({ dueDate: day(2) }).expect(200);
    expect(await alertOf(head.auth, moved)).toBeUndefined();               // not overdue any more
    expect(await alertOf(ceo, moved)).toBeUndefined();

    await http().patch(`/api/tickets/${moved.publicId}`).set(head.auth).send({ dueDate: day(-1) }).expect(200);
    await job.escalateOverdue();
    expect(await alertOf(head.auth, moved)).toMatchObject({ daysOverdue: 1, sentToCeoAt: null });   // the head again, not the CEO yet
    expect(await alertOf(ceo, moved)).toBeUndefined();
    expect(await events(moved, 'overdue_head_alerted')).toBe(2);

    await http().post(`/api/tickets/${cancelled.publicId}/cancel`).set(head.auth).send({ reason: 'Customer withdrew' }).expect(200);
    expect(await alertOf(head.auth, cancelled)).toBeUndefined();
    expect(await alertOf(ceo, cancelled)).toBeUndefined();
  });
});
