import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ExternalAttendance, ExternalStaff } from '@ageless/shared';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff, Staff } from '../../test/staff';
import { tag } from '../../test/people';
import { addDays, todayIst } from '../../platform/time';

type Auth = Record<string, string>;
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
const today = todayIst();
const day = (n: number) => addDays(today, n);
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+05:30`).toISOString();

describe('Attendance of external staff on a ticket\'s site', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, ceo: Auth;
  let head: Staff, site: Staff, otherSite: Staff, crew: Staff;
  let dept: string, siteWork: string;
  let ticket: string;
  let ravi: string;    // added by the on-site supervisor, on site since 20 days ago
  let sunil: string;   // added by the department head, on site from 3 days ago until yesterday
  const http = () => request(app.getHttpServer());
  const grant = (personId: string, roleCode: string) =>
    http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode, scope: 'team' }).expect(201);
  const newTicket = async () => (await http().post('/api/tickets').set(head.auth).send({ company: 'AE', typePublicId: siteWork, title: `Site ${tag()}`,
    departmentPublicId: dept, supervisorPublicId: site.personId, scheduledAt: new Date().toISOString(), details: { site: 'Goa' } }).expect(201)).body.publicId as string;
  const addWorker = async (auth: Auth, ticketId: string, name: string, fromDate: string, toDate?: string) => {
    const id = randomUUID();
    const req = http().post(`/api/tickets/${ticketId}/external-staff`).set(auth).field('publicId', id).field('name', name).field('fromDate', fromDate);
    await (toDate ? req.field('toDate', toDate) : req).expect(201);
    return id;
  };
  const mark = (auth: Auth, staffId: string, body: Record<string, unknown>, ticketId = ticket) =>
    http().put(`/api/tickets/${ticketId}/external-staff/${staffId}/attendance`).set(auth).send({ publicId: randomUUID(), ...body });
  const list = async (auth: Auth, query: Record<string, string> = {}) => {
    const res = await http().get(`/api/tickets/${ticket}/external-staff/attendance`).query(query).set(auth).expect(200);
    return ExternalAttendance.array().parse(res.body);
  };
  const staffList = async (auth: Auth, ticketId = ticket) =>
    ExternalStaff.array().parse((await http().get(`/api/tickets/${ticketId}/external-staff`).set(auth).expect(200)).body);
  const timeline = async (action: string) =>
    ((await http().get(`/api/tickets/${ticket}`).set(head.auth).expect(200)).body.timeline as { action: string; details: any }[]).filter((e) => e.action === action);

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo].map((d) => signIn(app, d.login)));
    [head, site, otherSite, crew] = await Promise.all(Array.from({ length: 4 }, () => newStaff(app, hr, admin, ['AE'])));
    await grant(head.personId, 'manager');
    await grant(site.personId, 'supervisor');
    await grant(otherSite.personId, 'supervisor');
    dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Crew ${tag()}`, codePrefix: letters() }).expect(201)).body.publicId;
    await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: head.personId }).expect(200);
    siteWork = (await http().get('/api/tickets/types').query({ company: 'AE' }).set(hr)).body.find((t: any) => t.code === 'site_work').publicId;
    ticket = await newTicket();
    // another on-site supervisor and a plain employee work on the ticket, but added nobody
    await http().put(`/api/tickets/${ticket}/assignees`).set(head.auth)
      .send({ assignees: [{ employmentPublicId: otherSite.jobs.AE, isPrimary: true }, { employmentPublicId: crew.jobs.AE }] }).expect(200);
    ravi = await addWorker(site.auth, ticket, 'Ravi Welder', day(-20));
    sunil = await addWorker(head.auth, ticket, 'Sunil Helper', day(-3), day(-1));
  }, 120_000);
  afterAll(async () => { await app?.close(); });

  it('the supervisor who added the worker records present with times, a half day and an absent day', async () => {
    const present = await mark(site.auth, ravi, { workDate: day(-1), status: 'present', timeIn: '09:00', timeOut: '17:30', note: 'Welding bay 2' });
    expect(present.status).toBe(200);
    expect(ExternalAttendance.parse(present.body)).toMatchObject({
      staff: { publicId: ravi, name: 'Ravi Welder' }, workDate: day(-1), status: 'present', timeIn: at(day(-1), '09:00'), timeOut: at(day(-1), '17:30'),
      minutes: 510, note: 'Welding bay 2', recordedBy: { publicId: site.personId }, updatedBy: null, updatedAt: null,
    });
    const half = await mark(site.auth, ravi, { workDate: day(-2), status: 'half_day', timeIn: '09:00' });
    expect([half.status, half.body.status, half.body.timeOut, half.body.minutes]).toEqual([200, 'half_day', null, null]);
    const absent = await mark(site.auth, ravi, { workDate: day(-3), status: 'absent', timeIn: '', note: 'Unwell' });
    expect([absent.status, absent.body.status, absent.body.timeIn, absent.body.note]).toEqual([200, 'absent', null, 'Unwell']);
    expect((await timeline('external_attendance_recorded')).length).toBe(3);
  }, 60_000);

  it('the same request sent twice is stored once; a publicId of another day is refused', async () => {
    const body = { publicId: randomUUID(), workDate: day(0), status: 'present', timeIn: '08:30' };
    const first = await mark(site.auth, ravi, body);
    const again = await mark(site.auth, ravi, body);
    expect([first.status, again.status, again.body.publicId]).toEqual([200, 200, body.publicId]);
    expect((await list(site.auth)).filter((a) => a.staff.publicId === ravi && a.workDate === day(0))).toHaveLength(1);
    expect((await timeline('external_attendance_recorded')).filter((e) => e.details.workDate === day(0))).toHaveLength(1);
    const clash = await mark(site.auth, ravi, { ...body, workDate: day(-4) });
    expect([clash.status, clash.body.code]).toEqual([409, 'TICKETS_DUPLICATE_ID']);
  }, 60_000);

  it('correcting a day updates the same record and logs what it was', async () => {
    const before = (await list(site.auth)).find((a) => a.staff.publicId === ravi && a.workDate === day(-1))!;
    const fixed = await mark(site.auth, ravi, { workDate: day(-1), status: 'half_day', timeIn: '09:00', timeOut: '13:00' });
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ publicId: before.publicId, status: 'half_day', minutes: 240, note: null,
      recordedBy: { publicId: site.personId }, updatedBy: { publicId: site.personId } });
    expect(fixed.body.updatedAt).not.toBeNull();
    const changed = await timeline('external_attendance_changed');
    expect(changed[changed.length - 1].details).toMatchObject({ externalStaff: ravi, attendance: before.publicId, workDate: day(-1),
      from: { status: 'present', timeIn: at(day(-1), '09:00'), timeOut: at(day(-1), '17:30') }, to: { status: 'half_day', timeOut: at(day(-1), '13:00') } });
    expect(JSON.stringify(changed)).not.toContain('Welding');   // notes stay in the record, not the timeline
  }, 60_000);

  it('another supervisor or an assignee who did not add the worker cannot record; nor the supervisor for a worker the head added', async () => {
    const other = await mark(otherSite.auth, ravi, { workDate: day(-1), status: 'present' });
    expect([other.status, other.body.code, other.body.message])
      .toEqual([403, 'TICKETS_FORBIDDEN', "Only the person who added this worker, or the ticket's manager, can record their attendance"]);
    expect((await mark(crew.auth, ravi, { workDate: day(-1), status: 'present' })).status).toBe(403);    // no tickets.site or tickets.manage at all
    const notTheirs = await mark(site.auth, sunil, { workDate: day(-2), status: 'present' });
    expect([notTheirs.status, notTheirs.body.code]).toEqual([403, 'TICKETS_FORBIDDEN']);
  }, 60_000);

  it('the department head (a manager of the ticket) and Management record and correct any worker', async () => {
    const byHead = await mark(head.auth, ravi, { workDate: day(-2), status: 'present', timeIn: '09:00', timeOut: '18:00' });
    expect(byHead.body).toMatchObject({ status: 'present', minutes: 540, recordedBy: { publicId: site.personId }, updatedBy: { publicId: head.personId } });
    const headsOwn = await mark(head.auth, sunil, { workDate: day(-2), status: 'present' });
    expect([headsOwn.status, headsOwn.body.recordedBy.publicId]).toEqual([200, head.personId]);
    const byCeo = await mark(ceo, sunil, { workDate: day(-1), status: 'absent' });
    expect([byCeo.status, byCeo.body.recordedBy.publicId]).toEqual([200, DEMO.ceo.publicId]);
  }, 60_000);

  it('anyone who may see the ticket lists the attendance: newest day first, within the asked dates', async () => {
    const all = await list(hr);
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.map((a) => a.workDate)).toEqual([...all.map((a) => a.workDate)].sort().reverse());
    expect(await list(crew.auth)).toHaveLength(all.length);
    const two = await list(hr, { from: day(-2), to: day(-1) });
    expect(new Set(two.map((a) => a.workDate))).toEqual(new Set([day(-2), day(-1)]));
    const reversed = await http().get(`/api/tickets/${ticket}/external-staff/attendance`).query({ from: day(0), to: day(-1) }).set(hr);
    expect([reversed.status, reversed.body.code]).toEqual([400, 'VALIDATION']);
    const tooLong = await http().get(`/api/tickets/${ticket}/external-staff/attendance`).query({ from: day(-100) }).set(hr);
    expect([tooLong.status, tooLong.body.code]).toEqual([400, 'TICKETS_EXTERNAL_ATTENDANCE_RANGE']);
  }, 60_000);

  it('refuses days outside the rules and inconsistent times', async () => {
    const refused = async (staffId: string, body: Record<string, unknown>) => {
      const res = await mark(site.auth, staffId, body);
      return [res.status, res.body.code];
    };
    expect(await refused(ravi, { workDate: day(1), status: 'present' })).toEqual([400, 'TICKETS_EXTERNAL_ATTENDANCE_FUTURE']);
    expect(await refused(ravi, { workDate: day(-8), status: 'present' })).toEqual([400, 'TICKETS_EXTERNAL_ATTENDANCE_TOO_OLD']);   // default window: 7 days
    expect(await refused(ravi, { workDate: day(-21), status: 'present' })).toEqual([400, 'TICKETS_EXTERNAL_ATTENDANCE_BEFORE_START']);
    expect(await refused(ravi, { workDate: day(-1), status: 'absent', timeIn: '09:00' })).toEqual([400, 'VALIDATION']);
    expect(await refused(ravi, { workDate: day(-1), status: 'present', timeIn: '17:00', timeOut: '17:00' })).toEqual([400, 'VALIDATION']);
    expect(await refused(ravi, { workDate: day(-1), status: 'present', timeIn: '9am' })).toEqual([400, 'VALIDATION']);
    expect(await refused(ravi, { workDate: day(-1), status: 'present', note: 'x'.repeat(201) })).toEqual([400, 'VALIDATION']);
    const head2 = (b: Record<string, unknown>) => mark(head.auth, sunil, b).then((r) => [r.status, r.body.code]);
    expect(await head2({ workDate: day(-4), status: 'present' })).toEqual([400, 'TICKETS_EXTERNAL_ATTENDANCE_BEFORE_START']);
    expect(await head2({ workDate: day(0), status: 'present' })).toEqual([400, 'TICKETS_EXTERNAL_ATTENDANCE_AFTER_END']);
  }, 60_000);

  it('tells each caller whether they may record a worker\'s attendance', async () => {
    const flags = async (auth: Auth) => Object.fromEntries((await staffList(auth)).map((s) => [s.name, s.canRecordAttendance]));
    expect(await flags(site.auth)).toEqual({ 'Ravi Welder': true, 'Sunil Helper': false });
    expect(await flags(head.auth)).toEqual({ 'Ravi Welder': true, 'Sunil Helper': true });
    expect(await flags(ceo)).toEqual({ 'Ravi Welder': true, 'Sunil Helper': true });
    expect(await flags(otherSite.auth)).toEqual({ 'Ravi Welder': false, 'Sunil Helper': false });
    expect(await flags(crew.auth)).toEqual({ 'Ravi Welder': false, 'Sunil Helper': false });
    expect(await flags(hr)).toEqual({ 'Ravi Welder': false, 'Sunil Helper': false });
  }, 60_000);

  it('a cancelled ticket takes no more attendance', async () => {
    const other = await newTicket();
    const mohan = await addWorker(site.auth, other, 'Mohan Fitter', day(-2));
    expect((await mark(site.auth, mohan, { workDate: day(0), status: 'present' }, other)).status).toBe(200);
    await http().post(`/api/tickets/${other}/cancel`).set(head.auth).send({ reason: 'Customer postponed' }).expect(200);
    const late = await mark(site.auth, mohan, { workDate: day(-1), status: 'present' }, other);
    expect([late.status, late.body.code]).toEqual([409, 'TICKETS_EXTERNAL_ATTENDANCE_TICKET_CANCELLED']);
    expect((await staffList(site.auth, other))[0].canRecordAttendance).toBe(false);
    expect((await staffList(head.auth, other))[0].canRecordAttendance).toBe(false);
  }, 60_000);

  it('the person who added a worker may no longer record once they stop running the site', async () => {
    await http().patch(`/api/tickets/${ticket}`).set(head.auth).send({ supervisorPublicId: otherSite.personId }).expect(200);
    expect((await mark(site.auth, ravi, { workDate: day(0), status: 'half_day' })).status).toBe(404);   // no longer sees the ticket
    const newSupervisor = await mark(otherSite.auth, ravi, { workDate: day(0), status: 'half_day' });
    expect([newSupervisor.status, newSupervisor.body.code]).toEqual([403, 'TICKETS_FORBIDDEN']);       // runs the site, but did not add Ravi
  }, 60_000);
});
