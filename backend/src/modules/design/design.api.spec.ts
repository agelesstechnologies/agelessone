import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { pdfText, png } from '../../test/images';
import { tag } from '../../test/people';
import { newStaff, Staff } from '../../test/staff';
import { readZip } from '../../test/zip';
import { todayIst } from '../../platform/time';

type Auth = Record<string, string>;
const PDF = (label: string) => Buffer.from(`%PDF-1.4\n% made-up test drawing ${label}\n%%EOF\n`);
const DWG = Buffer.from('AC1032\0\0\0\0\0\x01made-up test cad', 'latin1');
const BOM = Buffer.from('Part,Qty\nBase plate,1\nM12 bolt,8\n');
// The only file that makes design jobs: one ATPL job for the client AE, run by Demo Head (head of Designing, ATD).

describe('Design API', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth, ceo: Auth, head: Auth;
  let designer: Staff, qc: Staff, qcOnJob: Staff, outsider: Staff;
  let aeCustomer: string;
  let jobId: string, jobNumber: string, ticketId: string;
  let checklist: string[];
  const d: Record<string, { id: string; number: string }> = {};
  const r: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const post = (path: string, auth: Auth, body: Record<string, unknown> = {}) => http().post(`/api/design/${path}`).set(auth).send(body);
  const upload = (rev: string, auth: Auth, kind: string, data: Buffer, filename: string) =>
    http().post(`/api/design/revisions/${rev}/files`).set(auth).field('kind', kind).attach('file', data, { filename });
  const revision = async (rev: string, auth: Auth = head) => (await http().get(`/api/design/revisions/${rev}`).set(auth).expect(200)).body;
  const allPass = () => checklist.map((item) => ({ item, passed: true }));
  /** A drawing's revision from draft to QC-approved: PDF attached, submitted by the designer, approved by QC. */
  const approvedRevision = async (drawing: string, stage: string, label: string) => {
    const rev = (await post(`drawings/${drawing}/revisions`, designer.auth, { stage, changeNote: `${label} for the test`, sheet: '1 of 1', scale: '1:20' }).expect(201)).body.publicId;
    await upload(rev, designer.auth, 'pdf', PDF(label), 'drawing.pdf').expect(201);
    await post(`revisions/${rev}/submit`, designer.auth).expect(200);
    await post(`revisions/${rev}/qc`, qc.auth, { decision: 'approved', checklist: allPass() }).expect(201);
    return rev as string;
  };

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo, head] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo, DEMO.head].map((x) => signIn(app, x.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    [designer, qc, qcOnJob, outsider] = await Promise.all([0, 1, 2, 3].map(() => newStaff(app, hr, admin, ['ATPL'])));
    for (const s of [designer, qc, qcOnJob]) {
      await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: s.personId, roleCode: 'design_qc', scope: 'own' }).expect(201);
    }
    aeCustomer = (await http().get('/api/core/customers').query({ q: 'AE' }).set(hr).expect(200)).body.find((c: { code: string }) => c.code === 'AE').publicId;
    checklist = (await http().get('/api/design/qc/checklist').query({ company: 'ATPL' }).set(qc.auth).expect(200)).body.items;
  }, 90_000);
  afterAll(async () => {
    await db?.end();
    await app?.close();
  });

  it('the group companies are customers; AE is linked to its company; adding customers needs core.customers.manage', async () => {
    const list = (await http().get('/api/core/customers').set(outsider.auth).expect(200)).body;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AE', company: 'AE' }), expect.objectContaining({ code: 'ATPL', company: 'ATPL' })]));
    const body = { publicId: randomUUID(), code: `T${tag().slice(0, 8).toUpperCase()}`, name: 'Test Cinemas Pvt Ltd' };
    expect((await http().post('/api/core/customers').set(outsider.auth).send(body)).status).toBe(403);
    expect((await http().post('/api/core/customers').set(admin).send(body)).status).toBe(201);
    expect((await http().post('/api/core/customers').set(admin).send(body)).status).toBe(200);
    expect((await http().post('/api/core/customers').set(admin).send({ ...body, publicId: randomUUID() })).body.code).toBe('CUSTOMER_DUPLICATE_CODE');
  });

  it('a design job: only the Designing head or an Admin user; numbered DJ-… per company; AE takes none (no Designing department)', async () => {
    const job = { company: 'ATPL', customerPublicId: aeCustomer, clientProjectReference: 'AE PRJ-014 Test Dome', site: 'Test park, Kochi',
      scope: 'Ride base frame and control panel layout', requirements: 'Steel frame; IP65 panel', dueDate: '2026-12-31',
      receivedFrom: { name: 'Test Client Person', contact: 'client@example.com' } };
    expect((await post('jobs', outsider.auth, job)).body.code).toBe('DESIGN_FORBIDDEN');
    expect((await post('jobs', head, { ...job, company: 'AE' })).body.code).toBe('DESIGN_NOT_ENABLED');
    const publicId = randomUUID();
    const created = await post('jobs', head, { ...job, publicId }).expect(201);
    expect(created.body).toMatchObject({ company: 'ATPL', status: 'received', customer: { code: 'AE' }, clientProjectReference: 'AE PRJ-014 Test Dome',
      clientProjectPublicId: null, receivedFrom: { name: 'Test Client Person' }, actions: { manage: true } });
    expect(created.body.number).toMatch(/^DJ-\d{3}$/);
    [jobId, jobNumber] = [created.body.publicId, created.body.number];
    const again = await post('jobs', head, { ...job, publicId }).expect(200);
    expect(again.body.number).toBe(jobNumber);

    // the contact (a phone or email) never reaches the audit log
    const audit = await db.query(`SELECT summary, details::text AS details FROM core.audit_log WHERE entity_public_id = $1`, [jobId]);
    expect(audit.rows.map((a) => a.summary + a.details).join(' ')).not.toContain('client@example.com');

    for (const status of ['accepted', 'in_design']) expect((await post(`jobs/${jobId}/status`, head, { status }).expect(200)).body.status).toBe(status);
    expect((await post(`jobs/${jobId}/status`, head, { status: 'on_hold' })).body.code).toBe('VALIDATION');
    expect((await post(`jobs/${jobId}/status`, head, { status: 'closed' }).expect(200)).body.status).toBe('closed') ;
  });

  it('a closed job no longer changes; a held job goes back to where it was', async () => {
    expect((await post(`jobs/${jobId}/status`, head, { status: 'in_design' })).body.code).toBe('DESIGN_BAD_STATUS_CHANGE');
    // the closed job above was only for the status rules: the rest of this file works on a new one
    const created = await post('jobs', head, { company: 'ATPL', customerPublicId: aeCustomer, clientProjectReference: 'AE PRJ-015 Test Wave',
      scope: 'Wave ride enclosure drawings', receivedFrom: { name: 'Test Client Person' } }).expect(201);
    [jobId, jobNumber] = [created.body.publicId, created.body.number];
    await post(`jobs/${jobId}/status`, head, { status: 'accepted' }).expect(200);
    expect((await post(`jobs/${jobId}/status`, head, { status: 'on_hold', reason: 'Waiting for site survey' }).expect(200)).body)
      .toMatchObject({ status: 'on_hold', holdReason: 'Waiting for site survey', resumeStatus: 'accepted' });
    expect((await post(`jobs/${jobId}/status`, head, { status: 'in_design' })).body.code).toBe('DESIGN_BAD_STATUS_CHANGE');
    expect((await post(`jobs/${jobId}/status`, head, { status: 'accepted' }).expect(200)).body).toMatchObject({ status: 'accepted', holdReason: null });
    await post(`jobs/${jobId}/status`, head, { status: 'in_design' }).expect(200);
  });

  it('design job tickets for AE are billable to AE (the job is the design request)', async () => {
    const atd = (await http().get('/api/hrms/departments').query({ company: 'ATPL' }).set(hr).expect(200)).body.find((x: { codePrefix: string }) => x.codePrefix === 'ATD').publicId;
    const type = (await http().get('/api/tickets/types').query({ company: 'ATPL' }).set(hr)).body.find((t: { code: string }) => t.code === 'design').publicId;
    ticketId = (await http().post('/api/tickets').set(head).send({ company: 'ATPL', typePublicId: type, title: `Wave enclosure ${tag()}`,
      departmentPublicId: atd, scheduledAt: '2026-11-02T04:00:00.000Z' }).expect(201)).body.publicId;
    await http().put(`/api/tickets/${ticketId}/assignees`).set(ceo).send({ assignees: [{ employmentPublicId: designer.jobs.ATPL, isPrimary: true },
      { employmentPublicId: qcOnJob.jobs.ATPL, isPrimary: false }] }).expect(200);

    expect((await post(`jobs/${jobId}/tickets`, outsider.auth, { ticketPublicId: ticketId })).status).toBe(404);
    const linked = await post(`jobs/${jobId}/tickets`, head, { ticketPublicId: ticketId }).expect(200);
    expect(linked.body.tickets).toEqual([expect.objectContaining({ publicId: ticketId, billableTo: 'AE' })]);
    await post(`jobs/${jobId}/tickets`, head, { ticketPublicId: ticketId }).expect(200);   // sent again: stored once
    const billing = await http().get(`/api/intercompany/tickets/${ticketId}/billing`).set(head).expect(200);
    expect(billing.body).toMatchObject({ billableTo: 'AE', billable: true, serviceType: 'design', link: { kind: 'design_request', publicId: jobId } });
    const links = await db.query(`SELECT count(*)::int AS n FROM design.job_tickets jt JOIN tickets.tickets t ON t.id = jt.ticket_id WHERE t.public_id = $1`, [ticketId]);
    expect(links.rows[0].n).toBe(1);
  });

  it('drawings are numbered <job>-<discipline>-<seq>; only the job\'s people draw; disciplines come from policy', async () => {
    expect((await post(`jobs/${jobId}/drawings`, designer.auth, { discipline: 'XYZ', title: 'Nothing' })).body.code).toBe('DESIGN_UNKNOWN_DISCIPLINE');
    expect((await post(`jobs/${jobId}/drawings`, outsider.auth, { discipline: 'MEC', title: 'Nothing' })).status).toBe(404);
    for (const [key, discipline, title] of [['base', 'MEC', 'Base frame'], ['rail', 'MEC', 'Guard rail'], ['panel', 'ELE', 'Control panel layout']]) {
      const res = await post(`jobs/${jobId}/drawings`, designer.auth, { publicId: randomUUID(), discipline, title }).expect(201);
      d[key] = { id: res.body.publicId, number: res.body.number };
    }
    expect([d.base.number, d.rail.number, d.panel.number]).toEqual([`${jobNumber}-MEC-001`, `${jobNumber}-MEC-002`, `${jobNumber}-ELE-001`]);
  });

  it('a submitted revision never changes (the API refuses, and so does the database)', async () => {
    r.baseA = (await post(`drawings/${d.base.id}/revisions`, designer.auth, { stage: 'preliminary', changeNote: 'First issue for approval', scale: '1:20', sheet: '1 of 2' }).expect(201)).body.publicId;
    const draft = await revision(r.baseA);
    expect(draft).toMatchObject({ code: 'A', stage: 'preliminary', status: 'draft', title: 'Base frame', titleBlock: { clientProjectReference: 'AE PRJ-015 Test Wave', drawnBy: { publicId: designer.personId } } });
    expect((await post(`drawings/${d.base.id}/revisions`, designer.auth, { stage: 'preliminary', changeNote: 'Too early' })).body.code).toBe('DESIGN_REVISION_OPEN');
    expect((await post(`revisions/${r.baseA}/submit`, designer.auth)).body.code).toBe('DESIGN_PDF_REQUIRED');
    expect((await upload(r.baseA, designer.auth, 'pdf', png(4, 4), 'drawing.pdf')).body.code).toBe('DESIGN_FILE_TYPE');
    await upload(r.baseA, designer.auth, 'pdf', PDF('base A'), 'drawing.pdf').expect(201);
    await upload(r.baseA, designer.auth, 'source', DWG, 'base.dwg').expect(201);
    const withBom = (await upload(r.baseA, designer.auth, 'bom', BOM, 'bom.csv').expect(201)).body;
    expect(withBom.files.map((f: { name: string }) => f.name)).toEqual([`${d.base.number}_A.pdf`, `${d.base.number}_A_source.dwg`, `${d.base.number}_A_bom.csv`]);
    await http().patch(`/api/design/revisions/${r.baseA}`).set(designer.auth).send({ changeNote: 'First issue for client approval' }).expect(200);

    expect((await post(`revisions/${r.baseA}/submit`, designer.auth).expect(200)).body).toMatchObject({ status: 'submitted', submittedBy: { publicId: designer.personId } });
    await post(`revisions/${r.baseA}/submit`, designer.auth).expect(200);   // sent again: nothing changes
    expect((await http().patch(`/api/design/revisions/${r.baseA}`).set(designer.auth).send({ changeNote: 'Changed after submit' })).body.code).toBe('DESIGN_REVISION_LOCKED');
    expect((await upload(r.baseA, designer.auth, 'source', DWG, 'late.dwg')).body.code).toBe('DESIGN_REVISION_LOCKED');
    const fileId = withBom.files[2].publicId;
    expect((await post(`revision-files/${fileId}/remove`, designer.auth)).body.code).toBe('DESIGN_REVISION_LOCKED');

    await expect(db.query(`UPDATE design.drawing_revisions SET change_note = 'Changed in the database' WHERE public_id = $1`, [r.baseA])).rejects.toThrow(/DESIGN_REVISION_LOCKED/);
    await expect(db.query(`UPDATE design.drawing_revisions SET status = 'draft', submitted_by = NULL, submitted_at = NULL WHERE public_id = $1`, [r.baseA])).rejects.toThrow(/DESIGN_REVISION_LOCKED|DESIGN_BAD_REVISION_STATUS/);
    await expect(db.query(`DELETE FROM design.drawing_revisions WHERE public_id = $1`, [r.baseA])).rejects.toThrow(/DESIGN_NO_DELETE/);
    await expect(db.query(`INSERT INTO design.revision_files (tenant_id, public_id, legal_entity_id, revision_id, kind, name, file_path, file_type, size_bytes, uploaded_by)
      SELECT 1, gen_random_uuid(), r.legal_entity_id, r.id, 'source', 'x.dwg', 'x/x.dwg', 'dwg', 1, r.created_by FROM design.drawing_revisions r WHERE r.public_id = $1`, [r.baseA]))
      .rejects.toThrow(/DESIGN_REVISION_LOCKED/);
    expect((await revision(r.baseA)).changeNote).toBe('First issue for client approval');
  });

  it('the author cannot QC, nor anyone assigned to the job\'s tickets (also refused by the database)', async () => {
    expect((await post(`revisions/${r.baseA}/qc`, designer.auth, { decision: 'approved', checklist: allPass() })).body.code).toBe('DESIGN_QC_NOT_INDEPENDENT');
    expect((await post(`revisions/${r.baseA}/qc`, qcOnJob.auth, { decision: 'approved', checklist: allPass() })).body.code).toBe('DESIGN_QC_NOT_INDEPENDENT');
    expect((await post(`revisions/${r.baseA}/qc`, outsider.auth, { decision: 'approved', checklist: allPass() })).status).toBe(404);
    const insert = (person: string) => db.query(`INSERT INTO design.qc_reviews (tenant_id, public_id, legal_entity_id, revision_id, reviewer_person_id, decision, checklist)
      SELECT 1, gen_random_uuid(), r.legal_entity_id, r.id, p.id, 'approved', '[]'::jsonb FROM design.drawing_revisions r, core.persons p WHERE r.public_id = $1 AND p.public_id = $2`, [r.baseA, person]);
    await expect(insert(designer.personId)).rejects.toThrow(/DESIGN_QC_NOT_INDEPENDENT/);
    await expect(insert(qcOnJob.personId)).rejects.toThrow(/DESIGN_QC_NOT_INDEPENDENT/);

    expect((await post(`revisions/${r.baseA}/qc`, qc.auth, { decision: 'approved', checklist: allPass().slice(1) })).body.code).toBe('DESIGN_CHECKLIST');
    const oneFails = allPass().map((a, i) => (i === 0 ? { ...a, passed: false } : a));
    expect((await post(`revisions/${r.baseA}/qc`, qc.auth, { decision: 'approved', checklist: oneFails })).body.code).toBe('DESIGN_CHECKLIST');
    expect((await post(`revisions/${r.baseA}/qc`, qc.auth, { decision: 'changes_needed', checklist: oneFails })).body.code).toBe('VALIDATION'); // comments needed
    const approved = await http().post(`/api/design/revisions/${r.baseA}/qc`).set(qc.auth).field('decision', 'approved').field('checklist', JSON.stringify(allPass()))
      .attach('files', png(6, 6), { filename: 'markup.png' }).expect(201);
    expect(approved.body).toMatchObject({ status: 'qc_approved', qc: { decision: 'approved', reviewer: { publicId: qc.personId } } });
    expect(approved.body.qc.checklist).toHaveLength(checklist.length);
    expect(approved.body.qc.files).toEqual([expect.objectContaining({ name: `${d.base.number}_A_qc-1.png` })]);
  });

  it('only QC-approved revisions are issued; for construction only construction revisions', async () => {
    r.railA = (await post(`drawings/${d.rail.id}/revisions`, designer.auth, { stage: 'preliminary', changeNote: 'Guard rail first issue' }).expect(201)).body.publicId;
    await upload(r.railA, designer.auth, 'pdf', PDF('rail A'), 'rail.pdf').expect(201);
    await post(`revisions/${r.railA}/submit`, designer.auth).expect(200);   // submitted, never reviewed
    expect((await post(`jobs/${jobId}/transmittals`, head, { purpose: 'for_approval', revisionPublicIds: [r.railA] })).body.code).toBe('DESIGN_NOT_QC_APPROVED');
    expect((await post(`jobs/${jobId}/transmittals`, head, { purpose: 'for_construction', revisionPublicIds: [r.baseA] })).body.code).toBe('DESIGN_NOT_CONSTRUCTION');
    expect((await post(`jobs/${jobId}/transmittals`, designer.auth, { purpose: 'for_approval', revisionPublicIds: [r.baseA] })).body.code).toBe('DESIGN_FORBIDDEN');

    const publicId = randomUUID();
    const tr1 = await post(`jobs/${jobId}/transmittals`, head, { publicId, purpose: 'for_approval', revisionPublicIds: [r.baseA] }).expect(201);
    expect(tr1.body.number).toMatch(/^TR-\d{4}$/);
    expect(tr1.body).toMatchObject({ purpose: 'for_approval', recipient: 'Test Client Person', items: [expect.objectContaining({ drawingNumber: d.base.number, code: 'A', status: 'issued' })] });
    expect((await post(`jobs/${jobId}/transmittals`, head, { publicId, purpose: 'for_approval', revisionPublicIds: [r.baseA] }).expect(200)).body.number).toBe(tr1.body.number);
    expect((await post(`jobs/${jobId}/transmittals`, head, { purpose: 'for_approval', revisionPublicIds: [r.baseA] })).body.code).toBe('DESIGN_NOT_QC_APPROVED');
  });

  it('the client returns a revision; the next one is issued and supersedes it; the cover sheet lists exactly the issued revisions', async () => {
    const response = { response: 'returned', comments: 'Increase the base plate thickness', respondedOn: todayIst(), responderName: 'Test Client Person' };
    expect((await post(`revisions/${r.baseA}/response`, head, { ...response, comments: undefined })).body.code).toBe('VALIDATION');
    expect((await post(`revisions/${r.baseA}/response`, head, response).expect(201)).body).toMatchObject({ status: 'returned', response: { response: 'returned' } });
    await post(`revisions/${r.baseA}/response`, head, response).expect(200);

    r.baseB = await approvedRevision(d.base.id, 'preliminary', 'base B');
    expect((await revision(r.baseB)).code).toBe('B');
    r.panel0 = await approvedRevision(d.panel.id, 'construction', 'panel 0');
    expect((await revision(r.panel0)).code).toBe('0');
    expect((await post(`drawings/${d.panel.id}/revisions`, designer.auth, { stage: 'preliminary', changeNote: 'Letters after construction' })).body.code).toBe('DESIGN_REVISION_CODE');

    const tr2 = (await post(`jobs/${jobId}/transmittals`, head, { purpose: 'for_approval', revisionPublicIds: [r.baseB, r.panel0], recipient: 'Test Client Projects Desk' }).expect(201)).body;
    // items in drawing-number order: ELE-001 before MEC-001
    expect(tr2.items.map((i: { drawingNumber: string; code: string }) => `${i.drawingNumber} ${i.code}`)).toEqual([`${d.panel.number} 0`, `${d.base.number} B`]);
    expect((await revision(r.baseA)).status).toBe('superseded');
    expect((await revision(r.baseB)).status).toBe('issued');
    expect((await revision(r.railA)).status).toBe('submitted');

    const cover = await http().get(`/api/design/transmittals/${tr2.publicId}/cover-sheet`).set(head).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(cover.headers['content-type']).toBe('application/pdf');
    const text = pdfText(cover.body as Buffer);
    for (const s of [tr2.number, d.base.number, d.panel.number, 'Test Client Projects Desk', 'AE PRJ-015 Test Wave', 'For approval']) expect(text).toContain(s);
    expect(text).not.toContain(d.rail.number);

    const zip = await http().get(`/api/design/transmittals/${tr2.publicId}/zip`).set(head).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    const files = readZip(zip.body as Buffer);
    expect([...files.keys()].sort()).toEqual([`${d.base.number}_B.pdf`, `${d.panel.number}_0.pdf`, `${tr2.number}_cover.pdf`].sort());
    expect(files.get(`${d.base.number}_B.pdf`)!.equals(PDF('base B'))).toBe(true);
  });

  it('reports: QC queue, awaiting response, QC by discipline, drawings, hours from ticket time (CSV too)', async () => {
    const report = async (name: string, query: Record<string, string> = {}) =>
      (await http().get(`/api/design/reports/${name}`).query({ company: 'ATPL', ...query }).set(head).expect(200)).body;
    expect((await report('qc-queue')).rows.map((x: { revision: { publicId: string } }) => x.revision.publicId)).toEqual([r.railA]);
    expect((await report('awaiting-response')).rows.map((x: { revision: { publicId: string } }) => x.revision.publicId).sort()).toEqual([r.baseB, r.panel0].sort());
    expect((await report('qc-by-discipline', { from: todayIst(), to: todayIst() })).rows).toEqual([
      { discipline: 'ELE', reviews: 1, approved: 1, changesNeeded: 0, passPercent: 100 },
      { discipline: 'MEC', reviews: 2, approved: 2, changesNeeded: 0, passPercent: 100 },
    ]);
    const drawings = await report('drawings', { job: jobId });
    expect(drawings.byStatus).toEqual({ issued: 2, submitted: 1 });

    await db.query(`INSERT INTO tickets.ticket_time_allocations (tenant_id, ticket_id, employment_id, legal_entity_id, person_id, work_date, minutes)
      SELECT 1, t.id, e.id, e.legal_entity_id, e.person_id, DATE '2026-11-03', 90 FROM tickets.tickets t, hrms.employments e WHERE t.public_id = $1 AND e.public_id = $2`,
      [ticketId, designer.jobs.ATPL]);
    expect((await report('hours', { job: jobId })).rows).toEqual([expect.objectContaining({ job: { publicId: jobId, number: jobNumber }, tickets: 1, minutes: 90, hours: 1.5 })]);
    const job = (await http().get(`/api/design/jobs/${jobId}`).set(designer.auth).expect(200)).body;   // the job page shows its hours to its assignees too
    expect([job.minutes, job.tickets[0].minutes]).toEqual([90, 90]);
    const csv = await http().get('/api/design/reports/hours').query({ company: 'ATPL', job: jobId, format: 'csv' }).set(head).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain(`${jobNumber},Ageless Entertainments,in_design,1,1.5`);
    expect((await http().get('/api/design/reports/hours').query({ company: 'ATPL' }).set(outsider.auth)).status).toBe(403);
  });

  it('access for the menu: the Designing head runs ATPL; AE takes no design jobs; assignees see their jobs; others nothing', async () => {
    const mine = async (auth: Auth) => (await http().get('/api/design/access').set(auth).expect(200)).body;
    const forHead = await mine(head);
    expect(forHead.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({ company: 'ATPL', enabled: true, manage: true, view: true }),
      expect.objectContaining({ company: 'AE', enabled: false, manage: false, view: false }),
    ]));
    expect(await mine(designer.auth)).toMatchObject({ assignedJobs: 1 });
    const forOutsider = await mine(outsider.auth);
    expect([forOutsider.assignedJobs, forOutsider.companies.some((c: { view: boolean }) => c.view)]).toEqual([0, false]);
    expect((await mine(qc.auth)).companies).toEqual(expect.arrayContaining([expect.objectContaining({ company: 'ATPL', qc: true, view: true, manage: false })]));
  });
});
