import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff, Staff } from '../../test/staff';
import { tag } from '../../test/people';
import { JPEG, pdfText, png } from '../../test/images';
import { todayIst } from '../../platform/time';
import { uploadRoot } from '../../platform/storage';

type Auth = Record<string, string>;
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
/** 29 Oct 2026 (no other test punches on it), hours after 09:00 IST */
const at = (hours: number) => new Date(Date.UTC(2026, 9, 29, 3, 30) + hours * 3_600_000).toISOString();
const PDF_FILE = Buffer.from('%PDF-1.4\n% a made-up test file\n%%EOF\n');

describe('Full ticket report (PDF)', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, ceo: Auth, adminUser: Auth;
  let head: Staff, creator: Staff, site: Staff, worker: Staff, managerOnTicket: Staff, otherManager: Staff;
  let dept: string, installation: string;
  let ticket: { publicId: string; number: string };
  const http = () => request(app.getHttpServer());
  const grant = (personId: string, roleCode: string, scope = 'team') =>
    http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode, scope }).expect(201);
  /** the report as bytes (a successful download) */
  const download = (auth: Auth, id = ticket.publicId) => http().get(`/api/tickets/${id}/report.pdf`).set(auth).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  /** the answer as JSON (a refusal) */
  const refused = (auth: Auth, id = ticket.publicId) => http().get(`/api/tickets/${id}/report.pdf`).set(auth);
  const detail = async (auth: Auth, id = ticket.publicId) => (await http().get(`/api/tickets/${id}`).set(auth).expect(200)).body;

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo].map((d) => signIn(app, d.login)));
    let a: Staff;
    [head, creator, site, worker, managerOnTicket, otherManager, a] = await Promise.all(Array.from({ length: 7 }, () => newStaff(app, hr, admin, ['AE'])));
    for (const s of [head, creator, managerOnTicket, otherManager]) await grant(s.personId, 'manager');
    await grant(site.personId, 'supervisor');
    await grant(a.personId, 'admin_user', 'all');
    adminUser = a.auth;
    dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Report ${tag()}`, codePrefix: letters() }).expect(201)).body.publicId;
    await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: head.personId }).expect(200);
    installation = (await http().get('/api/tickets/types').query({ company: 'AE' }).set(hr)).body.find((t: any) => t.code === 'installation').publicId;

    // a Manager raises the ticket for the head's department; the on-site supervisor runs it; two people work on it
    ticket = (await http().post('/api/tickets').set(creator.auth).send({ company: 'AE', typePublicId: installation, title: `Install ${tag()}`,
      description: 'Install the two new rides', departmentPublicId: dept, supervisorPublicId: site.personId, scheduledAt: at(0),
      details: { site: 'Test Park, gate 2', machines_installed: 'Two rides' } }).expect(201)).body;
    await http().put(`/api/tickets/${ticket.publicId}/assignees`).set(head.auth)
      .send({ assignees: [{ employmentPublicId: worker.jobs.AE, isPrimary: true }, { employmentPublicId: managerOnTicket.jobs.AE }] }).expect(200);

    // time: daily punch-in, ticket punch-in, daily punch-out (stops the timer)
    const punch = (kind: 'in' | 'out', occurredAt: string) => http().post('/api/hrms/attendance/punches').set(worker.auth)
      .send({ publicId: randomUUID(), employmentPublicId: worker.jobs.AE, kind, occurredAt }).expect(201);
    await punch('in', at(0));
    await http().post('/api/tickets/punch-in').set(worker.auth).send({ occurredAt: at(0.5), items: [{ publicId: randomUUID(), ticketPublicId: ticket.publicId }] }).expect(201);
    await punch('out', at(8));

    // work: checklist, photos (RGB, transparent PNG, JPEG), a PDF file, a daily update, the customer's sign-off
    await http().post(`/api/tickets/${ticket.publicId}/checklist`).set(worker.auth).send({ item: 'Positioned as per layout', result: 'pass', note: 'Checked twice' }).expect(200);
    const attach = (kind: 'photo' | 'file', bytes: Buffer, name: string) =>
      http().post(`/api/tickets/${ticket.publicId}/attachments`).set(worker.auth).field('kind', kind).attach('file', bytes, name).expect(201);
    await attach('photo', png(64, 48), 'one.png');
    await attach('photo', png(40, 40, true), 'two.png');
    await attach('photo', JPEG, 'three.jpg');
    await attach('file', PDF_FILE, 'manual.pdf');
    await http().post(`/api/tickets/${ticket.publicId}/updates`).set(worker.auth).send({ note: 'Base frames fixed', percentComplete: 60, workDate: '2026-10-29' }).expect(201);
    await http().post(`/api/tickets/${ticket.publicId}/signoffs`).set(worker.auth).field('signerName', 'Cora Customer').field('signerRole', 'Park manager')
      .attach('photo', png(80, 50), 'sheet.png').expect(201);

    // an outside worker with a photo and today's attendance
    const ravi = randomUUID();
    await http().post(`/api/tickets/${ticket.publicId}/external-staff`).set(site.auth).field('publicId', ravi).field('name', 'Ravi Welder')
      .field('phone', '+91 00000 12345').field('agency', 'Goa Labour Co').field('trade', 'Welder').field('fromDate', todayIst()).attach('photo', png(30, 40), 'ravi.png').expect(201);
    await http().put(`/api/tickets/${ticket.publicId}/external-staff/${ravi}/attendance`).set(site.auth)
      .send({ publicId: randomUUID(), workDate: todayIst(), status: 'present', timeIn: '09:00', timeOut: '17:30', note: 'Welding bay 2' }).expect(200);
  }, 120_000);
  afterAll(async () => { await app?.close(); });

  it('the department head gets the whole ticket as a PDF: header, people, details, checklist, time, files with photos, sign-off, staff, history', async () => {
    const res = await download(head.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${ticket.number}-report.pdf"`);
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
    const text = pdfText(pdf);
    for (const s of [`Ticket report ${ticket.number}`, 'Ageless Entertainments (AE)', 'Installation (version', 'Assignees and reassignments', 'Primary',
      'Details (Installation)', 'Test Park, gate 2', 'Checklist', 'Positioned as per layout', 'Checked twice', 'Time', 'Ticket punches (timelogs)',
      'Stopped by the daily punch-out', 'Daily updates and notes', 'Base frames fixed', 'Files and photos', 'listed only', 'Customer sign-off and approval',
      'Cora Customer', 'Signed sheet', 'External staff', 'Ravi Welder', 'Goa Labour Co', 'Welding bay 2', 'Photo of Ravi Welder', 'History',
      `Ticket ${ticket.number} - page 1 of`]) {
      expect(text, s).toContain(s);
    }
    expect(text).toMatch(/#1 photo, uploaded by /);
    expect(text).not.toMatch(/could not be shown|file not found/);
  }, 60_000);

  it('the Manager who created it and Management (the CEO) get it too; the history logs every download', async () => {
    for (const auth of [creator.auth, ceo]) {
      const res = await download(auth);
      expect([res.status, (res.body as Buffer).subarray(0, 5).toString()]).toEqual([200, '%PDF-']);
    }
    const events = (await detail(head.auth)).timeline.filter((e: any) => e.action === 'report_downloaded');
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.map((e: any) => e.actor.publicId)).toEqual(expect.arrayContaining([head.personId, creator.personId, DEMO.ceo.publicId]));
    // the next report lists the earlier downloads in its history
    expect(pdfText((await download(head.auth)).body)).toContain('Downloaded the full report (PDF)');
  }, 60_000);

  it('assignees, the on-site supervisor, HR and the admin user may not; a Manager who only works on it neither; unknown ticket 404', async () => {
    for (const auth of [worker.auth, site.auth, hr, adminUser]) {
      const res = await refused(auth);
      expect([res.status, res.body.code]).toEqual([403, 'FORBIDDEN']);       // they do not hold tickets.report
    }
    const onTicket = await refused(managerOnTicket.auth);
    expect([onTicket.status, onTicket.body.code]).toEqual([403, 'TICKETS_FORBIDDEN']);
    expect(onTicket.body.message).toContain('department head');
    expect((await refused(otherManager.auth)).status).toBe(404);          // a Manager who cannot see the ticket
    const unknown = await refused(head.auth, randomUUID());
    expect([unknown.status, unknown.body.code]).toEqual([404, 'TICKETS_NOT_FOUND']);
  }, 60_000);

  it('the ticket tells the web who may download the report', async () => {
    for (const auth of [head.auth, creator.auth, ceo]) expect((await detail(auth)).canDownloadReport).toBe(true);
    for (const auth of [worker.auth, site.auth, hr, adminUser, managerOnTicket.auth]) expect((await detail(auth)).canDownloadReport).toBe(false);
    // actions answer the detail with the flag too
    const answered = await http().post(`/api/tickets/${ticket.publicId}/checklist`).set(head.auth).send({ item: 'Safety checks done', result: 'pass' }).expect(200);
    expect(answered.body.canDownloadReport).toBe(true);
  }, 60_000);

  it('a damaged photo or a file missing on disk does not stop the report', async () => {
    const t = (await http().post('/api/tickets').set(head.auth).send({ company: 'AE', typePublicId: installation, title: `Broken ${tag()}`,
      departmentPublicId: dept, scheduledAt: at(0), details: { site: 'Test Park' } }).expect(201)).body;
    const attach = (bytes: Buffer) => http().post(`/api/tickets/${t.publicId}/attachments`).set(head.auth).field('kind', 'photo').attach('file', bytes, 'x.png').expect(201);
    await attach(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));       // only the PNG signature
    await attach(png(20, 20));
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      const { rows } = await db.query(`SELECT a.file_path FROM tickets.ticket_attachments a JOIN tickets.tickets t ON t.id = a.ticket_id
        WHERE t.public_id = $1 ORDER BY a.id DESC LIMIT 1`, [t.publicId]);
      await rm(join(uploadRoot(), rows[0].file_path));                                                 // the second photo is gone from disk
    } finally { await db.end(); }
    const res = await download(head.auth, t.publicId);
    expect([res.status, (res.body as Buffer).subarray(0, 5).toString()]).toEqual([200, '%PDF-']);
    const text = pdfText(res.body);
    expect(text).toContain('the image could not be shown (the PNG file is incomplete)');
    expect(text).toMatch(/#2 photo, uploaded by .* - file not found/);
  }, 60_000);
});
