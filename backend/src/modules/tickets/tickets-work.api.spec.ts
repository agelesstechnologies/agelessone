import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff, Staff } from '../../test/staff';
import { tag } from '../../test/people';

type Auth = Record<string, string>;
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const DAY = '2026-12-10';
const AT = `${DAY}T04:30:00.000Z`;   // 10:00 IST
const PDF = Buffer.from('%PDF-1.4\n% test\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('Tickets API', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth, ceo: Auth, adminUser: Auth;
  let head: Staff, otherHead: Staff, s1: Staff, s2: Staff, s3: Staff, onLeave: Staff, atplStaff: Staff;
  let dept: string, otherDept: string, atplDept: string;
  const types: Record<string, Record<string, string>> = { AE: {}, ATPL: {} };
  const http = () => request(app.getHttpServer());
  const actions = async (id: string, who: Auth = adminUser) => (await http().get(`/api/tickets/${id}`).set(who)).body.timeline.map((e: any) => e.action);
  /** A ticket in the head's department (made by admin user). */
  const ticket = async (code: string, details: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    const res = await http().post('/api/tickets').set(adminUser).send({ company: 'AE', typePublicId: types.AE[code], title: `Test ${code} ${tag()}`,
      departmentPublicId: dept, scheduledAt: AT, details, ...over });
    if (res.status !== 201) throw new Error(`create ticket failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const assign = (id: string, ...jobs: string[]) => http().put(`/api/tickets/${id}/assignees`).set(head.auth)
    .send({ assignees: jobs.map((j, i) => ({ employmentPublicId: j, isPrimary: i === 0 })) });

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const grant = (personId: string, roleCode: string, scope: string) =>
      http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode, scope }).expect(201);
    const makeDept = async (company: string, headId?: string) => {
      const d = (await http().post('/api/hrms/departments').set(hr).send({ company, name: `Tickets ${tag()}`, codePrefix: letters() }).expect(201)).body.publicId;
      if (headId) await http().patch(`/api/hrms/departments/${d}`).set(hr).send({ headPublicId: headId }).expect(200);
      return d;
    };
    [head, otherHead, s1, s2, s3, onLeave] = await Promise.all(Array.from({ length: 6 }, () => newStaff(app, hr, admin, ['AE'])));
    atplStaff = await newStaff(app, hr, admin, ['ATPL']);
    await grant(head.personId, 'supervisor', 'team');
    await grant(otherHead.personId, 'supervisor', 'team');
    const a = await newStaff(app, hr, admin, ['AE']);
    await grant(a.personId, 'admin_user', 'all');
    adminUser = a.auth;
    dept = await makeDept('AE', head.personId);
    otherDept = await makeDept('AE', otherHead.personId);
    atplDept = (await http().get('/api/hrms/departments').query({ company: 'ATPL' }).set(hr)).body[0].publicId;
    for (const company of ['AE', 'ATPL']) {
      for (const t of (await http().get('/api/tickets/types').query({ company }).set(hr)).body) types[company][t.code] = t.publicId;
    }
    await db.query(
      `INSERT INTO hrms.leave_requests (tenant_id, person_id, employment_id, legal_entity_id, leave_type_id, from_date, to_date, days, status, decided_by, decided_at, decided_as)
       SELECT 1, e.person_id, e.id, e.legal_entity_id, lt.id, $2, $2, 1, 'approved', hr.id, now(), 'hr'
         FROM hrms.employments e, hrms.leave_types lt, core.persons hr
        WHERE e.public_id = $1 AND lt.tenant_id = 1 AND lt.code = 'GL' AND hr.public_id = $3`, [onLeave.jobs.AE, DAY, DEMO.hr.publicId]);
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('type details are checked against the type version\'s fields', async () => {
    const bad = await http().post('/api/tickets').set(adminUser).send({ company: 'AE', typePublicId: types.AE.purchase, title: 'Buy bolts',
      departmentPublicId: dept, scheduledAt: AT, details: { items: 'M8 bolts', amount: 10.5, colour: 'red' } });
    expect([bad.status, bad.body.code]).toEqual([400, 'TICKETS_INVALID_DETAILS']);
    expect(bad.body.details.errors).toEqual(['colour: not a field of this ticket type', 'vendor: required', 'amount: must be whole paise, 0 or more']);
    const person = await http().post('/api/tickets').set(adminUser).send({ company: 'AE', typePublicId: types.AE.production, title: 'Frame',
      departmentPublicId: dept, scheduledAt: AT, details: { item: 'Frame', quantity: 'many' } });
    expect(person.body.details.errors).toEqual(['quantity: must be a number']);

    const ok = await ticket('purchase', { vendor: ' Acme ', items: 'M8 bolts', amount: 150000 });
    expect(ok).toMatchObject({ status: 'open', company: 'AE', details: { vendor: 'Acme', items: 'M8 bolts', amount: 150000 },
      type: { code: 'purchase', version: 1 }, supervisor: { publicId: head.personId }, department: { publicId: dept }, primaryAssignee: null });
    expect(ok.number).toMatch(/^AE-\d{4,}$/);
    expect(ok.missingForCompletion).toEqual(['file', 'head_approval']);
    const edit = await http().patch(`/api/tickets/${ok.publicId}`).set(head.auth).send({ details: { vendor: 'Acme', items: 'M8', amount: -1 } });
    expect([edit.status, edit.body.code]).toEqual([400, 'TICKETS_INVALID_DETAILS']);
  });

  it('HR sets the number series so imported tickets keep their numbers', async () => {
    expect((await http().put('/api/tickets/number-series/ATPL').set(adminUser).send({ prefix: 'ATX', nextNumber: 558 })).status).toBe(403);
    const set = await http().put('/api/tickets/number-series/ATPL').set(hr).send({ prefix: 'ATX', nextNumber: 558 });
    expect(set.body).toEqual({ company: 'ATPL', prefix: 'ATX', nextNumber: 558, example: 'ATX-0558' });
    const make = () => http().post('/api/tickets').set(adminUser).send({ company: 'ATPL', typePublicId: types.ATPL.site_work, title: 'Imported series',
      departmentPublicId: atplDept, supervisorPublicId: DEMO.engineer.publicId, scheduledAt: AT, details: { site: 'Pune' } });
    const first = await make();
    expect(first.body.number).toBe('ATX-0558');
    expect((await make()).body.number).toBe('ATX-0559');
    expect((await http().get('/api/tickets/number-series').set(hr)).body.find((s: any) => s.company === 'ATPL')).toMatchObject({ nextNumber: 560 });
  });

  it('company consistency: type, department, assignees and links stay within one company', async () => {
    const base = { company: 'AE', title: 'Mixed', scheduledAt: AT, departmentPublicId: dept, details: { site: 'Goa' } };
    const otherType = await http().post('/api/tickets').set(adminUser).send({ ...base, typePublicId: types.ATPL.site_work });
    expect(otherType.body.code).toBe('TICKETS_TYPE_OTHER_COMPANY');
    const otherDeptRes = await http().post('/api/tickets').set(adminUser).send({ ...base, typePublicId: types.AE.site_work, departmentPublicId: atplDept });
    expect(otherDeptRes.body.code).toBe('TICKETS_UNKNOWN_DEPARTMENT');
    const t = await ticket('site_work', { site: 'Goa' });
    const res = await assign(t.publicId, atplStaff.jobs.ATPL);
    expect([res.status, res.body.code]).toEqual([400, 'TICKETS_ASSIGNEE_OTHER_COMPANY']);
    const atplTicket = (await http().get('/api/tickets').query({ company: 'ATPL' }).set(adminUser)).body[0];
    const link = await http().post(`/api/tickets/${t.publicId}/links`).set(adminUser).send({ toTicketPublicId: atplTicket.publicId });
    expect([link.status, link.body.code]).toEqual([400, 'TICKETS_LINK_OTHER_COMPANY']);
    // and in the database: an ATPL job on an AE ticket breaks the composite key
    const err = await db.query(`INSERT INTO tickets.ticket_assignees (tenant_id, ticket_id, employment_id, legal_entity_id, is_primary, assigned_by)
      SELECT 1, t.id, e.id, t.legal_entity_id, true, t.created_by FROM tickets.tickets t, hrms.employments e WHERE t.public_id = $1 AND e.public_id = $2`,
    [t.publicId, atplStaff.jobs.ATPL]).catch((e) => e);
    expect(err.constraint).toBe('ticket_assignees_employment_company_fk');
  });

  it('assigning someone on approved leave on the scheduled date is refused', async () => {
    const t = await ticket('site_work', { site: 'Goa' });
    const res = await assign(t.publicId, onLeave.jobs.AE);
    expect([res.status, res.body.code, res.body.details]).toEqual([409, 'TICKETS_ASSIGNEE_ON_LEAVE', { employmentPublicId: onLeave.jobs.AE, date: DAY }]);
    const later = await ticket('site_work', { site: 'Goa' }, { scheduledAt: '2026-12-11T04:30:00.000Z' });
    expect((await assign(later.publicId, onLeave.jobs.AE)).status).toBe(200);
  });

  it('exactly one primary assignee', async () => {
    const t = await ticket('site_work', { site: 'Goa' });
    const send = (assignees: unknown) => http().put(`/api/tickets/${t.publicId}/assignees`).set(head.auth).send({ assignees });
    expect((await send([{ employmentPublicId: s1.jobs.AE, isPrimary: true }, { employmentPublicId: s2.jobs.AE, isPrimary: true }])).status).toBe(400);
    expect((await send([{ employmentPublicId: s1.jobs.AE }, { employmentPublicId: s2.jobs.AE }])).status).toBe(400);
    const single = await send([{ employmentPublicId: s1.jobs.AE }]);
    expect([single.body.status, single.body.assignees.map((a: any) => a.isPrimary)]).toEqual(['assigned', [true]]);
    const swapped = await send([{ employmentPublicId: s1.jobs.AE }, { employmentPublicId: s2.jobs.AE, isPrimary: true }]);
    expect(swapped.body.assignees.map((a: any) => [a.employmentPublicId, a.isPrimary])).toEqual([[s2.jobs.AE, true], [s1.jobs.AE, false]]);
    const dropped = await send([{ employmentPublicId: s1.jobs.AE }]);
    expect(dropped.body.assignees.map((a: any) => [a.employmentPublicId, a.isPrimary])).toEqual([[s1.jobs.AE, true]]);
    // the database keeps it so too: no second primary, and never none while someone is assigned
    const two = await db.query(`UPDATE tickets.ticket_assignees SET is_primary = true WHERE ticket_id = (SELECT id FROM tickets.tickets WHERE public_id = $1)`, [t.publicId])
      .then(() => db.query(`INSERT INTO tickets.ticket_assignees (tenant_id, ticket_id, employment_id, legal_entity_id, is_primary, assigned_by)
        SELECT 1, t.id, e.id, t.legal_entity_id, true, t.created_by FROM tickets.tickets t, hrms.employments e WHERE t.public_id = $1 AND e.public_id = $2`, [t.publicId, s2.jobs.AE]))
      .catch((e) => e);
    expect(two.constraint).toBe('ticket_assignees_one_primary');
    const none = await db.query(`UPDATE tickets.ticket_assignees SET is_primary = false WHERE ticket_id = (SELECT id FROM tickets.tickets WHERE public_id = $1)`, [t.publicId]).catch((e) => e);
    expect(String(none.message)).toContain('TICKETS_ONE_PRIMARY');
    expect((await db.query('DELETE FROM tickets.tickets WHERE public_id = $1', [t.publicId]).catch((e) => e)).message).toContain('TICKETS_NEVER_DELETED');
  });

  it('staff see only their own tickets; HR views but cannot change anything', async () => {
    const mine = await ticket('site_work', { site: 'Goa' });
    const notMine = await ticket('site_work', { site: 'Goa' });
    await assign(mine.publicId, s3.jobs.AE).expect(200);
    const list = (await http().get('/api/tickets').set(s3.auth)).body.map((t: any) => t.publicId);
    expect(list).toEqual([mine.publicId]);
    expect((await http().get('/api/tickets/mine').set(s3.auth)).body.map((t: any) => t.publicId)).toEqual([mine.publicId]);
    expect((await http().get(`/api/tickets/${notMine.publicId}`).set(s3.auth)).body.code).toBe('TICKETS_NOT_FOUND');
    expect((await http().get('/api/tickets').query({ assignee: s3.personId }).set(hr)).body.map((t: any) => t.publicId)).toEqual([mine.publicId]);
    expect((await http().get(`/api/tickets/${notMine.publicId}`).set(hr)).status).toBe(200);
    expect((await http().post(`/api/tickets/${mine.publicId}/hold`).set(hr).send({ reason: 'Waiting' })).status).toBe(403);
    expect((await http().post('/api/tickets').set(s3.auth).send({})).status).toBe(403);
    expect((await http().post(`/api/tickets/${mine.publicId}/cancel`).set(s3.auth).send({ reason: 'Not needed' })).status).toBe(403);
  });

  it('a head runs only their own department\'s tickets', async () => {
    const res = await http().post('/api/tickets').set(head.auth).send({ company: 'AE', typePublicId: types.AE.site_work, title: 'Elsewhere',
      departmentPublicId: otherDept, scheduledAt: AT, details: { site: 'Goa' } });
    expect([res.status, res.body.code]).toEqual([403, 'TICKETS_FORBIDDEN']);
    const own = await http().post('/api/tickets').set(head.auth).send({ company: 'AE', typePublicId: types.AE.site_work, title: 'Mine',
      departmentPublicId: dept, scheduledAt: AT, details: { site: 'Goa' } });
    expect([own.status, own.body.supervisor.publicId]).toEqual([201, head.personId]);
    const theirs = await http().post('/api/tickets').set(otherHead.auth).send({ company: 'AE', typePublicId: types.AE.site_work, title: 'Theirs',
      departmentPublicId: otherDept, scheduledAt: AT, details: { site: 'Goa' } });
    expect((await http().get(`/api/tickets/${theirs.body.publicId}`).set(head.auth)).status).toBe(404);
    expect((await http().patch(`/api/tickets/${theirs.body.publicId}`).set(head.auth).send({ title: 'Taken over' })).status).toBe(404);
    const listed = (await http().get('/api/tickets').set(head.auth)).body.map((t: any) => t.department.publicId);
    expect(new Set(listed)).toEqual(new Set([dept]));
    expect((await assign(own.body.publicId, head.jobs.AE)).body.code).toBe('TICKETS_SELF_ASSIGN');
  });

  it('hold and cancel need a reason; finished tickets do not change', async () => {
    const t = await ticket('site_work', { site: 'Goa' });
    await assign(t.publicId, s1.jobs.AE).expect(200);
    expect((await http().post(`/api/tickets/${t.publicId}/hold`).set(head.auth).send({})).body.code).toBe('VALIDATION');
    expect((await http().post(`/api/tickets/${t.publicId}/hold`).set(head.auth).send({ reason: 'Waiting' })).body.code).toBe('TICKETS_WRONG_STATUS');
    await http().post(`/api/tickets/${t.publicId}/start`).set(s1.auth).expect(200);
    const held = await http().post(`/api/tickets/${t.publicId}/hold`).set(head.auth).send({ reason: 'Waiting for parts' });
    expect([held.body.status, held.body.holdReason]).toEqual(['on_hold', 'Waiting for parts']);
    const resumed = await http().post(`/api/tickets/${t.publicId}/resume`).set(head.auth);
    expect([resumed.body.status, resumed.body.holdReason]).toEqual(['in_progress', null]);
    expect((await http().post(`/api/tickets/${t.publicId}/cancel`).set(head.auth).send({ reason: '' })).body.code).toBe('VALIDATION');
    const cancelled = await http().post(`/api/tickets/${t.publicId}/cancel`).set(head.auth).send({ reason: 'Customer cancelled' });
    expect([cancelled.body.status, cancelled.body.cancelReason]).toEqual(['cancelled', 'Customer cancelled']);
    expect((await http().patch(`/api/tickets/${t.publicId}`).set(head.auth).send({ title: 'Too late' })).body.code).toBe('TICKETS_FINISHED');
    expect((await assign(t.publicId, s2.jobs.AE)).body.code).toBe('TICKETS_WRONG_STATUS');
    expect((await http().post(`/api/tickets/${t.publicId}/reopen`).set(head.auth).send({ reason: 'Back on' })).body.code).toBe('TICKETS_WRONG_STATUS');
  });

  it('completion is refused until the type\'s rules are met; only the primary assignee (or a manager) completes', async () => {
    const t = await ticket('purchase', { vendor: 'Acme', items: 'Bolts', amount: 50000 });
    await assign(t.publicId, s1.jobs.AE, s2.jobs.AE).expect(200);
    await http().post(`/api/tickets/${t.publicId}/start`).set(s2.auth).expect(200);
    const early = await http().post(`/api/tickets/${t.publicId}/complete`).set(s1.auth);
    expect([early.status, early.body.code, early.body.details]).toEqual([409, 'TICKETS_COMPLETION_INCOMPLETE', { missing: ['file', 'head_approval'] }]);
    expect((await http().post(`/api/tickets/${t.publicId}/complete`).set(s2.auth)).body.code).toBe('TICKETS_FORBIDDEN');

    const notPdf = await http().post(`/api/tickets/${t.publicId}/attachments`).set(s1.auth).field('kind', 'file').attach('file', Buffer.from('hello'), 'bill.pdf');
    expect(notPdf.body.code).toBe('TICKETS_FILE_TYPE');
    const up = await http().post(`/api/tickets/${t.publicId}/attachments`).set(s1.auth).field('kind', 'file').attach('file', PDF, 'bill.pdf');
    expect(up.status).toBe(201);
    const file = up.body.attachments[0];
    expect(file).toMatchObject({ kind: 'file', fileType: 'pdf' });
    const dl = await http().get(`/api/tickets/${t.publicId}/attachments/${file.publicId}`).set(hr);
    expect([dl.status, dl.headers['content-type']]).toEqual([200, 'application/pdf']);

    expect((await http().post(`/api/tickets/${t.publicId}/head-approval`).set(s1.auth)).status).toBe(403);
    const approved = await http().post(`/api/tickets/${t.publicId}/head-approval`).set(head.auth);
    expect(approved.body.headApproval.by.publicId).toBe(head.personId);
    expect(approved.body.missingForCompletion).toEqual([]);
    const done = await http().post(`/api/tickets/${t.publicId}/complete`).set(s1.auth);
    expect([done.status, done.body.status]).toEqual([200, 'completed']);
    const reopened = await http().post(`/api/tickets/${t.publicId}/reopen`).set(head.auth).send({ reason: 'Wrong items delivered' });
    expect([reopened.body.status, reopened.body.completedAt]).toEqual(['in_progress', null]);
  });

  it('sign-off, checklist and daily update rules', async () => {
    const t = await ticket('training_handover', { customer_contact: 'Ms Rao' });
    await assign(t.publicId, s1.jobs.AE).expect(200);
    await http().post(`/api/tickets/${t.publicId}/start`).set(s1.auth).expect(200);
    expect((await http().post(`/api/tickets/${t.publicId}/complete`).set(s1.auth)).body.details.missing).toEqual(['customer_signoff']);
    expect((await http().post(`/api/tickets/${t.publicId}/signoffs`).set(s1.auth).field('signerName', 'Ms Rao')).body.code).toBe('TICKETS_PHOTO_REQUIRED');
    const signed = await http().post(`/api/tickets/${t.publicId}/signoffs`).set(s1.auth).field('signerName', 'Ms Rao').field('signerRole', 'Park manager')
      .attach('photo', PNG, 'sheet.png');
    expect(signed.body.signoffs[0]).toMatchObject({ signerName: 'Ms Rao', signerRole: 'Park manager', photoPublicId: signed.body.attachments[0].publicId });
    expect((await http().post(`/api/tickets/${t.publicId}/complete`).set(s1.auth)).body.status).toBe('completed');

    const visit = await ticket('sales_visit', { customer: 'Wonder Park' });
    await assign(visit.publicId, s1.jobs.AE).expect(200);
    await http().post(`/api/tickets/${visit.publicId}/start`).set(s1.auth).expect(200);
    expect((await http().post(`/api/tickets/${visit.publicId}/complete`).set(s1.auth)).body.details.missing).toEqual(['daily_update']);
    await http().post(`/api/tickets/${visit.publicId}/updates`).set(s1.auth).send({ note: 'Met the owner', percentComplete: 30 }).expect(201);
    expect((await http().post(`/api/tickets/${visit.publicId}/complete`).set(s1.auth)).body.status).toBe('completed');

    const install = await ticket('installation', { site: 'Goa' });
    await assign(install.publicId, s1.jobs.AE).expect(200);
    expect((await http().post(`/api/tickets/${install.publicId}/checklist`).set(s1.auth).send({ item: 'Paint', result: 'pass' })).body.code).toBe('TICKETS_UNKNOWN_CHECKLIST_ITEM');
    await http().post(`/api/tickets/${install.publicId}/checklist`).set(s1.auth).send({ item: 'Test run passed', result: 'pass' }).expect(200);
    const view = (await http().get(`/api/tickets/${install.publicId}`).set(s1.auth)).body;
    expect(view.missingForCompletion).toEqual(['photo', 'checklist:Positioned as per layout', 'checklist:Power and wiring checked', 'checklist:Safety checks done']);
  });

  it('a QC ticket completed with a failed item creates a linked rework production ticket', async () => {
    const production = await ticket('production', { item: 'Ride frame', quantity: 2 });
    await assign(production.publicId, s2.jobs.AE).expect(200);
    const qc = await ticket('qc', { checked_item: 'Ride frame' });
    await assign(qc.publicId, s1.jobs.AE).expect(200);
    await http().post(`/api/tickets/${qc.publicId}/links`).set(head.auth).send({ toTicketPublicId: production.publicId, kind: 'follows' }).expect(201);
    expect((await http().post(`/api/tickets/${qc.publicId}/links`).set(head.auth).send({ toTicketPublicId: production.publicId })).body.code).toBe('TICKETS_DUPLICATE_LINK');
    await http().post(`/api/tickets/${qc.publicId}/start`).set(s1.auth).expect(200);
    for (const [item, result] of [['Dimensions as per drawing', 'pass'], ['Finish quality', 'fail'], ['Fixings and safety', 'pass'], ['Function test', 'na']]) {
      await http().post(`/api/tickets/${qc.publicId}/checklist`).set(s1.auth).send({ item, result, note: result === 'fail' ? 'Scratches' : undefined }).expect(200);
    }
    const done = await http().post(`/api/tickets/${qc.publicId}/complete`).set(s1.auth);
    expect(done.body.status).toBe('completed');
    const created = done.body.timeline.find((e: any) => e.action === 'rework_created');
    expect(created.details.failed).toEqual(['Finish quality']);

    const rework = (await http().get(`/api/tickets/${created.details.publicId}`).set(adminUser)).body;
    expect(rework).toMatchObject({ type: { code: 'production' }, status: 'assigned', title: `Rework: ${production.title}`,
      details: { item: 'Ride frame', quantity: 2 }, department: { publicId: dept }, supervisor: { publicId: head.personId },
      primaryAssignee: { employmentPublicId: s2.jobs.AE } });
    expect(rework.links).toEqual([{ direction: 'to', kind: 'rework_of', ticket: expect.objectContaining({ publicId: production.publicId }) }]);
    expect(rework.description).toContain('Finish quality');
    expect((await http().get('/api/tickets/mine').set(s2.auth)).body.map((t: any) => t.publicId)).toContain(rework.publicId);

    // a QC ticket without a production ticket: rework of the QC ticket, assigned to the QC ticket's supervisor
    const lone = await ticket('qc', { checked_item: 'Gate' });
    await assign(lone.publicId, s1.jobs.AE).expect(200);
    await http().post(`/api/tickets/${lone.publicId}/start`).set(s1.auth).expect(200);
    for (const item of ['Dimensions as per drawing', 'Finish quality', 'Fixings and safety', 'Function test']) {
      await http().post(`/api/tickets/${lone.publicId}/checklist`).set(s1.auth).send({ item, result: item === 'Function test' ? 'fail' : 'pass' }).expect(200);
    }
    const loneDone = (await http().post(`/api/tickets/${lone.publicId}/complete`).set(s1.auth)).body;
    const r2 = (await http().get(`/api/tickets/${loneDone.timeline.find((e: any) => e.action === 'rework_created').details.publicId}`).set(adminUser)).body;
    expect(r2).toMatchObject({ details: { item: 'Gate' }, primaryAssignee: { employmentPublicId: head.jobs.AE } });
    expect(r2.links[0]).toMatchObject({ kind: 'rework_of', ticket: { publicId: lone.publicId } });

    // all passed: no rework
    const clean = await ticket('qc', { checked_item: 'Seat' });
    await assign(clean.publicId, s1.jobs.AE).expect(200);
    await http().post(`/api/tickets/${clean.publicId}/start`).set(s1.auth).expect(200);
    for (const item of ['Dimensions as per drawing', 'Finish quality', 'Fixings and safety', 'Function test']) {
      await http().post(`/api/tickets/${clean.publicId}/checklist`).set(s1.auth).send({ item, result: 'pass' }).expect(200);
    }
    expect((await http().post(`/api/tickets/${clean.publicId}/complete`).set(s1.auth)).body.timeline.map((e: any) => e.action)).not.toContain('rework_created');
  });

  it('reassignment: an assignee asks, the supervisor approves and picks someone else (never themselves)', async () => {
    const t = await ticket('site_work', { site: 'Goa' });
    await assign(t.publicId, s1.jobs.AE, s2.jobs.AE).expect(200);
    expect((await http().post(`/api/tickets/${t.publicId}/reassign-requests`).set(s3.auth).send({ reason: 'Busy' })).status).toBe(404);
    expect((await http().post(`/api/tickets/${t.publicId}/reassign-requests`).set(s1.auth).send({})).body.code).toBe('VALIDATION');
    const asked = await http().post(`/api/tickets/${t.publicId}/reassign-requests`).set(s1.auth).send({ reason: 'Needed at another site' });
    expect(asked.status).toBe(201);
    expect((await http().post(`/api/tickets/${t.publicId}/reassign-requests`).set(s1.auth).send({ reason: 'Again' })).body.code).toBe('TICKETS_REASSIGN_PENDING');
    const req = asked.body.reassignRequests[0];
    expect(req).toMatchObject({ status: 'pending', approver: { publicId: head.personId }, requestedBy: { publicId: s1.personId } });
    expect((await http().get('/api/tickets/reassign-requests').query({ status: 'pending' }).set(head.auth)).body.map((r: any) => r.publicId)).toContain(req.publicId);

    const approve = (who: Auth, job: string) => http().post(`/api/tickets/reassign-requests/${req.publicId}/approve`).set(who).send({ newEmploymentPublicId: job });
    expect((await approve(s1.auth, s3.jobs.AE)).body.code).toBe('TICKETS_SELF_APPROVAL');
    expect((await approve(otherHead.auth, s3.jobs.AE)).body.code).toBe('TICKETS_FORBIDDEN');
    expect((await approve(head.auth, head.jobs.AE)).body.code).toBe('TICKETS_SELF_REASSIGN');
    expect((await approve(head.auth, onLeave.jobs.AE)).body.code).toBe('TICKETS_ASSIGNEE_ON_LEAVE');
    const done = await approve(head.auth, s3.jobs.AE);
    expect(done.status).toBe(200);
    expect(done.body.assignees.map((a: any) => [a.employmentPublicId, a.isPrimary])).toEqual([[s3.jobs.AE, true], [s2.jobs.AE, false]]);
    expect(done.body.reassignRequests[0]).toMatchObject({ status: 'approved', decidedAs: 'approver', newAssignee: { publicId: s3.personId } });
    expect((await approve(head.auth, s1.jobs.AE)).body.code).toBe('TICKETS_REASSIGN_DECIDED');

    // Management needs nobody's approval and may take a ticket on
    const t2 = await ticket('site_work', { site: 'Goa' });
    await assign(t2.publicId, s2.jobs.AE).expect(200);
    const r2 = (await http().post(`/api/tickets/${t2.publicId}/reassign-requests`).set(s2.auth).send({ reason: 'Leaving early' })).body.reassignRequests[0];
    const ceoJob = (await db.query(`SELECT e.public_id FROM hrms.employments e JOIN core.persons p ON p.id = e.person_id WHERE p.public_id = $1`, [DEMO.ceo.publicId])).rows[0].public_id;
    const byCeo = await http().post(`/api/tickets/reassign-requests/${r2.publicId}/approve`).set(ceo).send({ newEmploymentPublicId: ceoJob });
    expect([byCeo.status, byCeo.body.reassignRequests[0].decidedAs]).toEqual([200, 'management']);
    const rejected = await http().post(`/api/tickets/${t.publicId}/reassign-requests`).set(s2.auth).send({ reason: 'Not trained' });
    const r3 = rejected.body.reassignRequests[0];
    const no = await http().post(`/api/tickets/reassign-requests/${r3.publicId}/reject`).set(head.auth).send({ reason: 'You are trained' });
    expect(no.body.reassignRequests[0]).toMatchObject({ status: 'rejected', decisionReason: 'You are trained' });
  });

  it('the timeline records every change, oldest first', async () => {
    const t = await ticket('site_work', { site: 'Goa' });
    await assign(t.publicId, s1.jobs.AE).expect(200);
    await http().patch(`/api/tickets/${t.publicId}`).set(head.auth).send({ priority: 1, details: { site: 'Goa', crew: 'Two fitters' } }).expect(200);
    await http().patch(`/api/tickets/${t.publicId}`).set(head.auth).send({ priority: 1 }).expect(200); // nothing changed: no event
    await http().post(`/api/tickets/${t.publicId}/start`).set(s1.auth).expect(200);
    await http().post(`/api/tickets/${t.publicId}/hold`).set(head.auth).send({ reason: 'Rain' }).expect(200);
    await http().post(`/api/tickets/${t.publicId}/resume`).set(head.auth).expect(200);
    await http().post(`/api/tickets/${t.publicId}/updates`).set(s1.auth).send({ note: 'Half done', percentComplete: 50 }).expect(201);
    await http().post(`/api/tickets/${t.publicId}/attachments`).set(s1.auth).field('kind', 'photo').attach('file', PNG, 'site.png').expect(201);
    await http().post(`/api/tickets/${t.publicId}/complete`).set(s1.auth).expect(200);
    await http().post(`/api/tickets/${t.publicId}/reopen`).set(head.auth).send({ reason: 'Snag found' }).expect(200);
    await http().post(`/api/tickets/${t.publicId}/cancel`).set(head.auth).send({ reason: 'Customer stopped' }).expect(200);
    const view = (await http().get(`/api/tickets/${t.publicId}`).set(s1.auth)).body;
    expect(view.timeline.map((e: any) => e.action)).toEqual(['created', 'assignees_changed', 'details_updated', 'started', 'held', 'resumed',
      'daily_update', 'attachment_added', 'completed', 'reopened', 'cancelled']);
    expect(view.timeline[2].details.changed.sort()).toEqual(['priority', 'typeDetails']);
    expect(view.timeline[4]).toMatchObject({ actor: { publicId: head.personId }, details: { from: 'in_progress', to: 'on_hold', reason: 'Rain' } });
    expect(await actions(t.publicId)).toHaveLength(11);
    const edit = await db.query(`UPDATE tickets.ticket_events SET action = 'x' WHERE ticket_id = (SELECT id FROM tickets.tickets WHERE public_id = $1)`, [t.publicId]).catch((e) => e);
    expect(String(edit.message)).toContain('TICKETS_APPEND_ONLY');
  });
});
