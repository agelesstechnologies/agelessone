import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';
import { newStaff } from '../../../test/staff';
import { tag } from '../../../test/people';
import { addDays, todayIst } from '../../../platform/time';

type Auth = Record<string, string>;
type Alert = { title: string; body: string | null; alertCode: string; link: string | null };
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

/** Alerts made at the moment of the change, inside its transaction: leave and ticket assignment. */
describe('Instant alerts', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth;
  let pgc: pg.Client;
  const http = () => request(app.getHttpServer());
  const alertsOf = async (auth: Auth) => (await http().get('/api/core/notifications?limit=100').set(auth).expect(200)).body.items as Alert[];

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    pgc = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgc.connect();
  });
  afterAll(async () => { await pgc?.end(); await app?.close(); });

  it('leave: the approver is alerted when it is submitted, the person when it is decided; never the person about their own request', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const body = { employmentPublicId: s.jobs.AE, leaveTypeCode: 'EL', fromDate: '2030-03-12', toDate: '2030-03-12' };
    const applied = await http().post('/api/hrms/leave/requests').set(s.auth).send(body).expect(201);
    const key = `hrms.leave_submitted:${applied.body.publicId}`;
    const rows = await pgc.query('SELECT p.public_id FROM core.notifications n JOIN core.persons p ON p.id = n.recipient_person_id WHERE n.dedupe_key = $1', [key]);
    expect(rows.rowCount).toBe(1);                                              // the one approver
    expect(rows.rows[0].public_id).not.toBe(s.personId);
    expect((await alertsOf(s.auth)).some((a) => a.alertCode === 'hrms.leave_submitted')).toBe(false);

    // sent again with the same publicId: stored once, no second alert
    await http().post('/api/hrms/leave/requests').set(s.auth).send({ ...body, publicId: applied.body.publicId });
    expect((await pgc.query('SELECT 1 FROM core.notifications WHERE dedupe_key = $1', [key])).rowCount).toBe(1);

    await http().post(`/api/hrms/leave/requests/${applied.body.publicId}/approve`).set(hr).send({}).expect(200);
    expect(await alertsOf(s.auth)).toContainEqual(expect.objectContaining({ alertCode: 'hrms.leave_decided', title: 'Your leave was approved', link: 'leave' }));

    const second = await http().post('/api/hrms/leave/requests').set(s.auth).send({ ...body, fromDate: '2030-03-14', toDate: '2030-03-14' }).expect(201);
    await http().post(`/api/hrms/leave/requests/${second.body.publicId}/reject`).set(hr).send({ reason: 'Busy week' }).expect(200);
    const rejected = (await alertsOf(s.auth)).find((a) => a.title === 'Your leave was rejected');
    expect(rejected?.body).toContain('Busy week');
  });

  it('expenses: the manager of the job is alerted when a claim is submitted, the person when it is decided', async () => {
    const [s, manager] = await Promise.all([newStaff(app, hr, admin, ['AE']), signIn(app, DEMO.manager.login)]);
    await http().patch(`/api/hrms/employments/${s.jobs.AE}`).set(hr).send({ managerPublicId: DEMO.manager.publicId }).expect(200);
    const submit = (spentOn: string) => http().post('/api/hrms/expenses').set(s.auth)
      .field('employmentPublicId', s.jobs.AE).field('categoryCode', 'food').field('amountPaise', '50000').field('spentOn', spentOn).field('description', 'Lunch on site');
    const claim = (await submit('2026-01-10').expect(201)).body;
    const forManager = (await alertsOf(manager)).filter((a) => a.alertCode === 'hrms.expense_submitted');
    expect(forManager.length).toBeGreaterThanOrEqual(1);
    expect((await pgc.query('SELECT 1 FROM core.notifications WHERE dedupe_key = $1', [`hrms.expense_submitted:${claim.publicId}`])).rowCount).toBe(1);
    expect((await alertsOf(s.auth)).some((a) => a.alertCode === 'hrms.expense_submitted')).toBe(false);

    await http().post(`/api/hrms/expenses/${claim.publicId}/approve`).set(manager).send({}).expect(200);
    expect(await alertsOf(s.auth)).toContainEqual(expect.objectContaining({ alertCode: 'hrms.expense_decided', title: 'Your expense claim was approved' }));

    const second = (await submit('2026-01-11').expect(201)).body;
    await http().post(`/api/hrms/expenses/${second.publicId}/reject`).set(manager).send({ reason: 'No bill' }).expect(200);
    expect((await alertsOf(s.auth)).find((a) => a.title === 'Your expense claim was rejected')?.body).toContain('No bill');
  });

  it('tickets: a person added to a ticket is alerted; the one who assigned them is not; assigning again alerts nobody', async () => {
    const [head, worker] = await Promise.all([newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE'])]);
    const grant = (personId: string, roleCode: string, scope: string) =>
      http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode, scope }).expect(201);
    await grant(head.personId, 'admin_user', 'all');
    await grant(head.personId, 'manager', 'team');
    const dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Instant ${tag()}`, codePrefix: letters() }).expect(201)).body.publicId;
    const siteWork = (await http().get('/api/tickets/types').query({ company: 'AE' }).set(hr)).body.find((t: { code: string }) => t.code === 'site_work').publicId;
    const ticket = (await http().post('/api/tickets').set(head.auth).send({ company: 'AE', typePublicId: siteWork, title: `Instant ${tag()}`, departmentPublicId: dept,
      scheduledAt: new Date(`${addDays(todayIst(), 1)}T09:00:00+05:30`).toISOString(), details: { site: 'Goa' } }).expect(201)).body;

    const assign = () => http().put(`/api/tickets/${ticket.publicId}/assignees`).set(head.auth).send({ assignees: [{ employmentPublicId: worker.jobs.AE }] }).expect(200);
    await assign();
    const mine = (await alertsOf(worker.auth)).filter((a) => a.alertCode === 'tickets.assigned');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: `You were assigned ticket ${ticket.number}`, link: `tickets/${ticket.publicId}` });
    await assign();                                                              // nothing changed: no second alert
    expect((await alertsOf(worker.auth)).filter((a) => a.alertCode === 'tickets.assigned')).toHaveLength(1);
    expect((await alertsOf(head.auth)).some((a) => a.alertCode === 'tickets.assigned')).toBe(false);
  });
});
