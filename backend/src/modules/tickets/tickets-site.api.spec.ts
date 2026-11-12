import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff, Staff } from '../../test/staff';
import { tag } from '../../test/people';

type Auth = Record<string, string>;
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const AT = '2026-12-14T04:30:00.000Z';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('On-site supervisors (requirements, external staff, hold/resume) and managers (create, assign)', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth;
  let head: Staff, site: Staff, otherSite: Staff;
  let dept: string, siteWork: string;
  let ticket: any;
  const http = () => request(app.getHttpServer());
  const grant = (personId: string, roleCode: string) =>
    http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode, scope: 'team' }).expect(201);
  const body = (over: Record<string, unknown> = {}) => ({ company: 'AE', typePublicId: siteWork, title: `Site ${tag()}`, departmentPublicId: dept,
    scheduledAt: AT, details: { site: 'Goa' }, ...over });

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    [head, site, otherSite] = await Promise.all(Array.from({ length: 3 }, () => newStaff(app, hr, admin, ['AE'])));
    await grant(head.personId, 'manager');
    await grant(site.personId, 'supervisor');
    await grant(otherSite.personId, 'supervisor');
    dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Site ${tag()}`, codePrefix: letters() }).expect(201)).body.publicId;
    await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: head.personId }).expect(200);
    siteWork = (await http().get('/api/tickets/types').query({ company: 'AE' }).set(hr)).body.find((t: any) => t.code === 'site_work').publicId;
    ticket = (await http().post('/api/tickets').set(head.auth).send(body({ supervisorPublicId: site.personId })).expect(201)).body;
  }, 60_000);
  afterAll(async () => { await app?.close(); });

  it('a manager / head creates the ticket; an on-site supervisor cannot create or assign', async () => {
    expect(ticket.supervisor.publicId).toBe(site.personId);
    const mine = (await http().get('/api/tickets/mine').set(site.auth).expect(200)).body;     // the supervisor finds it under My tickets
    expect(mine.map((t: any) => t.publicId)).toContain(ticket.publicId);
    expect((await http().get('/api/tickets/mine').set(otherSite.auth)).body.map((t: any) => t.publicId)).not.toContain(ticket.publicId);
    const listed = (await http().get('/api/tickets').set(head.auth).expect(200)).body;           // and the manager who raised it lists it
    expect(listed.map((t: any) => t.publicId)).toContain(ticket.publicId);
    expect((await http().post('/api/tickets').set(site.auth).send(body())).status).toBe(403);
    const assign = await http().put(`/api/tickets/${ticket.publicId}/assignees`).set(site.auth).send({ assignees: [{ employmentPublicId: otherSite.jobs.AE, isPrimary: true }] });
    expect(assign.status).toBe(403);
    expect((await http().post(`/api/tickets/${ticket.publicId}/cancel`).set(site.auth).send({ reason: 'Not needed' })).status).toBe(403);
  });

  it('the on-site supervisor edits the requirements, not the title or priority', async () => {
    const ok = await http().patch(`/api/tickets/${ticket.publicId}`).set(site.auth).send({ description: 'Bring the 6 m ladder', site: 'Panjim, block B' });
    expect([ok.status, ok.body.description, ok.body.site]).toEqual([200, 'Bring the 6 m ladder', 'Panjim, block B']);
    const no = await http().patch(`/api/tickets/${ticket.publicId}`).set(site.auth).send({ priority: 1 });
    expect([no.status, no.body.code]).toEqual([403, 'TICKETS_FORBIDDEN']);
  });

  it('records external staff with a photo (stored once), and their last day; only on their own tickets', async () => {
    const id = randomUUID();
    const add = () => http().post(`/api/tickets/${ticket.publicId}/external-staff`).set(site.auth)
      .field('publicId', id).field('name', 'Ravi Contractor').field('phone', '+91 00000 12345').field('agency', 'Goa Labour Co')
      .field('trade', 'Welder').field('fromDate', '2026-12-14').attach('photo', PNG, 'ravi.png');
    const first = await add();
    expect(first.status).toBe(201);
    expect(first.body).toEqual([expect.objectContaining({ publicId: id, name: 'Ravi Contractor', agency: 'Goa Labour Co', trade: 'Welder',
      fromDate: '2026-12-14', toDate: null, hasPhoto: true, addedBy: expect.objectContaining({ publicId: site.personId }) })]);
    expect((await add()).body).toHaveLength(1);                                   // sent twice: stored once
    const photo = await http().get(`/api/tickets/${ticket.publicId}/external-staff/${id}/photo`).set(head.auth);
    expect([photo.status, photo.headers['content-type']]).toEqual([200, 'image/png']);
    const ended = await http().post(`/api/tickets/${ticket.publicId}/external-staff/${id}/end`).set(site.auth).send({ toDate: '2026-12-16' });
    expect(ended.body[0].toDate).toBe('2026-12-16');
    const notTheirs = await http().post(`/api/tickets/${ticket.publicId}/external-staff`).set(otherSite.auth).field('name', 'X Y').field('fromDate', '2026-12-14');
    expect(notTheirs.status).toBe(404);                                           // another supervisor does not even see it
  });

  it('the on-site supervisor holds and resumes the ticket', async () => {
    await http().put(`/api/tickets/${ticket.publicId}/assignees`).set(head.auth).send({ assignees: [{ employmentPublicId: otherSite.jobs.AE, isPrimary: true }] }).expect(200);
    await http().post(`/api/tickets/${ticket.publicId}/start`).set(site.auth).send({}).expect(200);    // the supervisor may start the work too
    const held = await http().post(`/api/tickets/${ticket.publicId}/hold`).set(site.auth).send({ reason: 'Waiting for material' });
    expect([held.status, held.body.status]).toEqual([200, 'on_hold']);
    const resumed = await http().post(`/api/tickets/${ticket.publicId}/resume`).set(site.auth).send({});
    expect(resumed.status).toBe(200);
  });
});
