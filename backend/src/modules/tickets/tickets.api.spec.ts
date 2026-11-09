import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff } from '../../test/staff';
import { tag } from '../../test/people';
import { TicketTypesService } from './application/ticket-types.service';

type Auth = Record<string, string>;
const STANDARD = ['sales_visit', 'survey', 'design', 'budgeting', 'purchase', 'production', 'workshop', 'qc', 'packing_transport', 'site_work',
  'installation', 'training_handover', 'service'];
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

describe('Ticket types API', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, ceo: Auth, head: Auth, adminUser: Auth, staff: Auth;
  let headPersonId: string;
  // Two AE departments made here (the head heads the first), and a seeded ATPL department: the tests stay out of ATPL's department list.
  let deptOwn: string, deptOther: string, deptAtpl: string;
  let db: pg.Client;
  const http = () => request(app.getHttpServer());
  const body = (over: Record<string, unknown> = {}) => ({
    company: 'AE', code: `t_${tag().toLowerCase()}`, name: `Test type ${tag()}`, ownerDepartmentPublicId: deptOwn,
    fields: [{ key: 'site', label: 'Site', type: 'text', required: true }], ...over,
  });
  const standard = async (company: string, code: string) =>
    (await http().get('/api/tickets/types').query({ company }).set(hr)).body.find((t: any) => t.code === code);
  const audit = async (publicId: string) =>
    (await db.query('SELECT action, actor_person_id IS NOT NULL AS has_actor FROM core.audit_log WHERE entity_public_id = $1 ORDER BY id', [publicId])).rows;

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();

    const grant = async (personId: string, roleCode: string, scope: string) =>
      http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode, scope }).expect(201);
    const h = await newStaff(app, hr, admin, ['ATPL']);
    headPersonId = h.personId;
    await grant(h.personId, 'manager', 'team');
    head = h.auth;
    const a = await newStaff(app, hr, admin, ['ATPL']);
    await grant(a.personId, 'admin_user', 'all');
    adminUser = a.auth;
    staff = (await newStaff(app, hr, admin, ['ATPL'])).auth;

    const dept = async (company: string) => (await http().post('/api/hrms/departments').set(hr).send({ company, name: `Dept ${tag()}`, codePrefix: letters() }).expect(201)).body.publicId;
    [deptOwn, deptOther] = [await dept('AE'), await dept('AE')];
    deptAtpl = (await http().get('/api/hrms/departments').query({ company: 'ATPL' }).set(hr)).body[0].publicId;
    await http().patch(`/api/hrms/departments/${deptOwn}`).set(hr).send({ headPublicId: headPersonId }).expect(200);
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('every company has the 13 standard types, all active', async () => {
    for (const company of ['AE', 'ATPL']) {
      const res = await http().get('/api/tickets/types').query({ company, active: 'true' }).set(hr);
      expect(res.status).toBe(200);
      const standards = res.body.filter((t: any) => t.isStandard);
      expect(standards.map((t: any) => t.code).sort()).toEqual([...STANDARD].sort());
      expect(standards.every((t: any) => t.active && t.version === 1 && t.company === company)).toBe(true);
    }
  });

  it('the standard types carry their fields, completion rules and checklists', async () => {
    const qc = await standard('ATPL', 'qc');
    expect(qc).toMatchObject({ name: 'QC', ownerDepartment: null,
      fields: [{ key: 'checked_item', label: 'Checked item', type: 'text', required: true }],
      completionRules: { checklist_required: true, photo_required: false },
      checklistItems: ['Dimensions as per drawing', 'Finish quality', 'Fixings and safety', 'Function test'] });
    const purchase = await standard('AE', 'purchase');
    expect(purchase.fields.map((f: any) => [f.key, f.type, f.required])).toEqual([['vendor', 'text', true], ['items', 'text', true], ['amount', 'money', true]]);
    expect(purchase.completionRules).toMatchObject({ head_approval_required: true, file_required: true, photo_required: false });
    expect((await standard('ATPL', 'installation')).completionRules).toMatchObject({ checklist_required: true, photo_required: true });
    expect((await standard('ATPL', 'training_handover')).completionRules.customer_signoff_required).toBe(true);
  });

  it('a department head creates a type for their own department, and it is audited', async () => {
    const res = await http().post('/api/tickets/types').set(head).send(body({ name: 'Fabrication check', checklistItems: ['Welds clean'], completionRules: { checklist_required: true } }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ version: 1, company: 'AE', name: 'Fabrication check', isStandard: false, active: true,
      ownerDepartment: { publicId: deptOwn }, completionRules: { checklist_required: true, photo_required: false }, checklistItems: ['Welds clean'] });
    expect(res.body.versions).toHaveLength(1);
    expect(await audit(res.body.publicId)).toEqual([{ action: 'tickets.type.created', has_actor: true }]);
    expect((await http().get('/api/tickets/types').query({ department: deptOwn }).set(staff)).body.map((t: any) => t.publicId)).toContain(res.body.publicId);
  });

  it('a head cannot create for another department, company-wide, or with a department of another company', async () => {
    const other = await http().post('/api/tickets/types').set(head).send(body({ ownerDepartmentPublicId: deptOther }));
    expect([other.status, other.body.code]).toEqual([403, 'TICKETS_TYPE_FORBIDDEN']);
    const wide = await http().post('/api/tickets/types').set(head).send(body({ ownerDepartmentPublicId: undefined }));
    expect([wide.status, wide.body.code]).toEqual([403, 'TICKETS_TYPE_FORBIDDEN']);
    const crossed = await http().post('/api/tickets/types').set(adminUser).send(body({ company: 'ATPL', ownerDepartmentPublicId: deptOwn }));
    expect([crossed.status, crossed.body.code]).toEqual([400, 'TICKETS_UNKNOWN_DEPARTMENT']);
  });

  it('the database refuses a department from another company too (composite key)', async () => {
    const err = await db.query(
      `INSERT INTO tickets.ticket_types (tenant_id, legal_entity_id, code, name, owner_department_id, created_by)
       SELECT 1, le.id, 'fk_check', 'FK check', d.id, p.id
         FROM core.legal_entities le, hrms.departments d, core.persons p
        WHERE le.tenant_id = 1 AND le.code = 'ATPL' AND d.public_id = $1 AND p.public_id = $2`, [deptOwn, DEMO.admin.publicId]).catch((e) => e);
    expect(err.constraint).toBe('ticket_types_department_company_fk');
  });

  it('a head cannot change another department\'s type or a standard type', async () => {
    const theirs = (await http().post('/api/tickets/types').set(adminUser).send(body({ ownerDepartmentPublicId: deptOther }))).body;
    for (const [method, path, payload] of [['patch', '', { name: 'Hijacked' }], ['post', '/deactivate', undefined]] as const) {
      const res = await http()[method](`/api/tickets/types/${theirs.publicId}${path}`).set(head).send(payload);
      expect([res.status, res.body.code]).toEqual([403, 'TICKETS_TYPE_FORBIDDEN']);
    }
    const workshop = await standard('ATPL', 'workshop');
    for (const [method, path, payload] of [['patch', '', { name: 'Renamed' }], ['patch', '', { sortOrder: 5 }], ['post', '/deactivate', undefined]] as const) {
      const res = await http()[method](`/api/tickets/types/${workshop.publicId}${path}`).set(head).send(payload);
      expect([res.status, res.body.code]).toEqual([403, 'TICKETS_STANDARD_TYPE_LOCKED']);
    }
    expect(await standard('ATPL', 'workshop')).toMatchObject({ name: 'Workshop', version: 1, active: true });
    // a head's own type that is standard-owned stays locked, and a head cannot move a type between departments
    const mine = (await http().post('/api/tickets/types').set(head).send(body())).body;
    const moved = await http().patch(`/api/tickets/types/${mine.publicId}`).set(head).send({ ownerDepartmentPublicId: deptOther });
    expect([moved.status, moved.body.code]).toEqual([403, 'TICKETS_TYPE_FORBIDDEN']);
  });

  it('a duplicate name (any letter case) or code in the same company is refused', async () => {
    const first = (await http().post('/api/tickets/types').set(head).send(body({ name: 'Paint Shop Visit' }))).body;
    const sameName = await http().post('/api/tickets/types').set(head).send(body({ name: 'paint SHOP visit' }));
    expect([sameName.status, sameName.body.code]).toEqual([409, 'TICKETS_DUPLICATE_NAME']);
    const sameCode = await http().post('/api/tickets/types').set(head).send(body({ code: 'qc' }));
    expect([sameCode.status, sameCode.body.code]).toEqual([409, 'TICKETS_DUPLICATE_CODE']);
    const standardName = await http().post('/api/tickets/types').set(head).send(body({ name: 'qc' }));
    expect(standardName.body.code).toBe('TICKETS_DUPLICATE_NAME');
    const rename = await http().patch(`/api/tickets/types/${first.publicId}`).set(head).send({ name: 'service' });
    expect([rename.status, rename.body.code]).toEqual([409, 'TICKETS_DUPLICATE_NAME']);
    // another company may use the name
    const ae = await http().post('/api/tickets/types').set(adminUser).send(body({ company: 'ATPL', ownerDepartmentPublicId: undefined, name: 'Paint Shop Visit' }));
    expect(ae.status).toBe(201);
  });

  it('editing saves a new version and keeps the old one; sending the same values saves nothing', async () => {
    const made = (await http().post('/api/tickets/types').set(head).send(body({ name: 'Cable pulling' }))).body;
    const url = `/api/tickets/types/${made.publicId}`;
    const edited = await http().patch(url).set(head).send({ expectedVersion: 1, name: 'Cable pulling and testing', fields: [
      { key: 'site', label: 'Site', type: 'text', required: true }, { key: 'length_m', label: 'Length (m)', type: 'number' }] });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ publicId: made.publicId, version: 2, name: 'Cable pulling and testing' });
    expect(edited.body.fields).toHaveLength(2);
    expect(edited.body.versions.map((v: any) => [v.version, v.isCurrent, v.name, v.fields.length])).toEqual([[2, true, 'Cable pulling and testing', 2], [1, false, 'Cable pulling', 1]]);

    const same = await http().patch(url).set(head).send({ name: 'Cable pulling and testing' });
    expect(same.body.version).toBe(2);
    const stale = await http().patch(url).set(head).send({ expectedVersion: 1, sortOrder: 7 });
    expect([stale.status, stale.body.code]).toEqual([409, 'TICKETS_TYPE_VERSION_CONFLICT']);
    expect((await http().get(url).set(staff)).body.versions).toHaveLength(2);
    expect((await audit(made.publicId)).map((a) => a.action)).toEqual(['tickets.type.created', 'tickets.type.updated']);

    // the old name is free again; saved versions can be neither deleted nor edited in the database
    expect((await http().post('/api/tickets/types').set(head).send(body({ name: 'Cable pulling' }))).status).toBe(201);
    const del = await db.query('DELETE FROM tickets.ticket_types WHERE public_id = $1', [made.publicId]).catch((e) => e);
    expect(String(del.message)).toContain('TICKETS_TYPE_VERSIONS_KEPT');
    const edit = await db.query(`UPDATE tickets.ticket_types SET name = 'x' WHERE public_id = $1 AND version = 1`, [made.publicId]).catch((e) => e);
    expect(String(edit.message)).toContain('TICKETS_TYPE_VERSIONS_KEPT');
  });

  it('a checklist rule needs checklist items, and field keys must differ', async () => {
    const noItems = await http().post('/api/tickets/types').set(head).send(body({ completionRules: { checklist_required: true } }));
    expect([noItems.status, noItems.body.code]).toEqual([400, 'VALIDATION']);
    const twice = await http().post('/api/tickets/types').set(head).send(body({ fields: [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'date' }] }));
    expect(twice.status).toBe(400);
    const badType = await http().post('/api/tickets/types').set(head).send(body({ fields: [{ key: 'a', label: 'A', type: 'photo' }] }));
    expect(badType.status).toBe(400);
    const made = (await http().post('/api/tickets/types').set(head).send(body())).body;
    const emptied = await http().patch(`/api/tickets/types/${made.publicId}`).set(head).send({ completionRules: { checklist_required: true } });
    expect([emptied.status, emptied.body.code]).toEqual([400, 'TICKETS_CHECKLIST_EMPTY']);
  });

  it('a deactivated type cannot be used for new tickets until it is reactivated; every step is audited', async () => {
    const made = (await http().post('/api/tickets/types').set(head).send(body())).body;
    const tickets = app.get(TicketTypesService);
    expect((await tickets.requireActiveType(1, made.publicId)).publicId).toBe(made.publicId);

    const off = await http().post(`/api/tickets/types/${made.publicId}/deactivate`).set(head);
    expect([off.status, off.body.active, off.body.version]).toEqual([200, false, 1]);
    await expect(tickets.requireActiveType(1, made.publicId)).rejects.toMatchObject({ code: 'TICKETS_TYPE_INACTIVE', status: 409 });
    expect((await http().get('/api/tickets/types').query({ active: 'false', department: deptOwn }).set(staff)).body.map((t: any) => t.publicId)).toContain(made.publicId);
    expect((await http().get('/api/tickets/types').query({ active: 'true', department: deptOwn }).set(staff)).body.map((t: any) => t.publicId)).not.toContain(made.publicId);
    await http().post(`/api/tickets/types/${made.publicId}/deactivate`).set(head).expect(200); // again: no second audit entry

    const on = await http().post(`/api/tickets/types/${made.publicId}/reactivate`).set(head);
    expect([on.status, on.body.active]).toEqual([200, true]);
    expect((await tickets.requireActiveType(1, made.publicId)).active).toBe(true);
    expect((await audit(made.publicId)).map((a) => a.action)).toEqual(['tickets.type.created', 'tickets.type.deactivated', 'tickets.type.reactivated']);
    await expect(tickets.requireActiveType(1, randomUUID())).rejects.toMatchObject({ code: 'TICKETS_TYPE_NOT_FOUND' });
  });

  it('staff and HR can read types but not create or change them', async () => {
    const some = await standard('ATPL', 'survey');
    for (const who of [staff, hr]) {
      expect((await http().get('/api/tickets/types').set(who)).status).toBe(200);
      expect((await http().get(`/api/tickets/types/${some.publicId}`).set(who)).status).toBe(200);
      expect((await http().post('/api/tickets/types').set(who).send(body())).status).toBe(403);
      expect((await http().patch(`/api/tickets/types/${some.publicId}`).set(who).send({ sortOrder: 1 })).status).toBe(403);
      expect((await http().post(`/api/tickets/types/${some.publicId}/deactivate`).set(who)).status).toBe(403);
      expect((await http().post(`/api/tickets/types/${some.publicId}/reactivate`).set(who)).status).toBe(403);
    }
    expect((await http().get('/api/tickets/types')).status).toBe(401);
  });

  it('admin user and Management manage every type, standard ones included', async () => {
    const design = await standard('AE', 'design');
    const url = `/api/tickets/types/${design.publicId}`;
    const byAdmin = await http().patch(url).set(adminUser).send({ sortOrder: design.sortOrder + 1 });
    expect([byAdmin.status, byAdmin.body.version]).toEqual([200, 2]);
    const byCeo = await http().patch(url).set(ceo).send({ sortOrder: design.sortOrder });
    expect([byCeo.status, byCeo.body.version]).toEqual([200, 3]);          // the CEO holds Management (scope all)
    expect(byCeo.body.versions.map((v: any) => v.createdBy.publicId)).toEqual([DEMO.ceo.publicId, expect.any(String), DEMO.admin.publicId]);

    const owned = await http().patch(url).set(adminUser).send({ ownerDepartmentPublicId: deptOther });
    expect(owned.body.ownerDepartment.publicId).toBe(deptOther);
    expect((await http().patch(url).set(adminUser).send({ ownerDepartmentPublicId: deptAtpl })).body.code).toBe('TICKETS_UNKNOWN_DEPARTMENT');
    await http().patch(url).set(adminUser).send({ ownerDepartmentPublicId: null }).expect(200);
    expect((await http().post(`${url}/deactivate`).set(adminUser)).body.active).toBe(false);
    expect((await http().post(`${url}/reactivate`).set(ceo)).body.active).toBe(true);
    const wide = await http().post('/api/tickets/types').set(adminUser).send(body({ ownerDepartmentPublicId: undefined }));
    expect([wide.status, wide.body.ownerDepartment]).toEqual([201, null]);
  });

  it('sending the same publicId twice stores one type', async () => {
    const payload = { ...body(), publicId: randomUUID() };
    expect((await http().post('/api/tickets/types').set(head).send(payload)).status).toBe(201);
    const again = await http().post('/api/tickets/types').set(head).send(payload);
    expect([again.status, again.body.publicId]).toEqual([200, payload.publicId]);
    expect((await http().get('/api/tickets/types').query({ department: deptOwn }).set(head)).body.filter((t: any) => t.publicId === payload.publicId)).toHaveLength(1);
  });
});
