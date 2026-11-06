import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff, Staff } from '../../test/staff';
import { tag } from '../../test/people';
import { TicketTimeService } from './application/ticket-time.service';

type Auth = Record<string, string>;
const H = 3_600_000;
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
/** hours after 09:00 IST on an October 2026 day (no other test uses these dates) */
const at = (day: number, hours: number) => new Date(Date.UTC(2026, 9, day, 3, 30) + hours * H).toISOString();
const date = (day: number) => `2026-10-${String(day).padStart(2, '0')}`;

describe('Ticket time API', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth, ceo: Auth, adminUser: Auth;
  let head: Staff, otherHead: Staff;
  let dept: string, siteWork: string;
  const http = () => request(app.getHttpServer());

  const ticket = async (title = `Time ${tag()}`) => (await http().post('/api/tickets').set(adminUser).send({ company: 'AE', typePublicId: siteWork,
    title, departmentPublicId: dept, scheduledAt: at(1, 0), details: { site: 'Goa' } }).expect(201)).body;
  const assignedTicket = async (s: Staff) => {
    const t = await ticket();
    await http().put(`/api/tickets/${t.publicId}/assignees`).set(head.auth).send({ assignees: [{ employmentPublicId: s.jobs.AE }] }).expect(200);
    return t;
  };
  const punch = async (s: Staff, kind: 'in' | 'out', occurredAt: string) => {
    const publicId = randomUUID();
    const res = await http().post('/api/hrms/attendance/punches').set(s.auth).send({ publicId, employmentPublicId: s.jobs.AE, kind, occurredAt });
    if (res.status !== 201) throw new Error(`punch failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { publicId, body: res.body };
  };
  const ticketIn = (s: Staff, tickets: string[], occurredAt: string, ids = tickets.map(() => randomUUID())) =>
    http().post('/api/tickets/punch-in').set(s.auth).send({ occurredAt, items: tickets.map((t, i) => ({ publicId: ids[i], ticketPublicId: t })) });
  const ticketOut = (s: Staff, body: Record<string, unknown>) => http().post('/api/tickets/punch-out').set(s.auth).send(body);
  const day = async (who: Auth, s: Staff, d: number) => (await http().get('/api/tickets/time/allocations').query({ person: s.personId, date: date(d) }).set(who)).body;
  const minutesOf = (view: any) => Object.fromEntries(view.rows.map((r: any) => [r.ticket.number, r.minutes]));

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const grant = (personId: string, roleCode: string, scope: string) =>
      http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode, scope }).expect(201);
    [head, otherHead] = await Promise.all([newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE'])]);
    await grant(head.personId, 'supervisor', 'team');
    await grant(otherHead.personId, 'supervisor', 'team');
    const a = await newStaff(app, hr, admin, ['AE']);
    await grant(a.personId, 'admin_user', 'all');
    adminUser = a.auth;
    dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Time ${tag()}`, codePrefix: letters() }).expect(201)).body.publicId;
    await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: head.personId }).expect(200);
    siteWork = (await http().get('/api/tickets/types').query({ company: 'AE' }).set(hr)).body.find((t: any) => t.code === 'site_work').publicId;
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  describe('a shared day', () => {
    let s: Staff;
    let a: any, b: any, c: any;
    beforeAll(async () => {
      s = await newStaff(app, hr, admin, ['AE']);
      [a, b, c] = [await assignedTicket(s), await assignedTicket(s), await assignedTicket(s)];
    });

    it('three tickets for 3 h, then two for 5 h: 1 h / 3.5 h / 3.5 h, within attendance', async () => {
      await punch(s, 'in', at(5, 0));
      const started = await ticketIn(s, [a.publicId, b.publicId, c.publicId], at(5, 0));
      expect([started.status, started.body.started, started.body.running.length]).toEqual([201, 3, 3]);
      expect(started.body.running[0].ticket.status).toBe('in_progress');               // the first punch-in starts the ticket
      const out = await ticketOut(s, { tickets: [a.publicId], occurredAt: at(5, 3) });
      expect([out.body.stopped, out.body.running.length]).toEqual([1, 2]);
      const dayOut = await punch(s, 'out', at(5, 8));                                     // stops B and C
      expect(dayOut.body.notices).toEqual([{ code: 'TICKETS_DAILY_UPDATE_MISSING', message: expect.any(String),
        items: expect.arrayContaining([a, b, c].map((t) => ({ publicId: t.publicId, label: `${t.number} ${t.title}` }))) }]);

      const view = await day(s.auth, s, 5);
      expect(minutesOf(view)).toEqual({ [a.number]: 60, [b.number]: 210, [c.number]: 210 });
      expect([view.totalMinutes, view.attendanceMinutes]).toEqual([480, 480]);
      expect(view.timelogs.map((l: any) => l.endReason).sort()).toEqual(['day_punch_out', 'day_punch_out', 'manual']);
      expect((await http().get(`/api/tickets/${a.publicId}`).set(s.auth)).body.timeline.map((e: any) => e.action))
        .toEqual(expect.arrayContaining(['started', 'time_started', 'time_stopped']));
    });

    it('a head adjusts between tickets with a reason; the originals stay and the total stays within attendance', async () => {
      const before = await day(head.auth, s, 5);
      const send = (who: Auth, body: Record<string, unknown>) => http().post('/api/tickets/time/adjustments').set(who)
        .send({ personPublicId: s.personId, date: date(5), ...body });
      expect((await send(head.auth, { changes: [{ ticketPublicId: a.publicId, minutes: 30 }, { ticketPublicId: b.publicId, minutes: -30 }] })).body.code).toBe('VALIDATION');
      const moved = await send(head.auth, { reason: 'Most of the morning was on the first site', changes: [
        { ticketPublicId: a.publicId, minutes: 30 }, { ticketPublicId: b.publicId, minutes: -30 }] });
      expect(moved.status).toBe(201);
      expect(moved.body.rows.find((r: any) => r.ticket.publicId === a.publicId)).toMatchObject({ calculatedMinutes: 60, adjustedMinutes: 30, minutes: 90 });
      expect(moved.body.rows.find((r: any) => r.ticket.publicId === b.publicId)).toMatchObject({ calculatedMinutes: 210, adjustedMinutes: -30, minutes: 180 });
      expect(moved.body.totalMinutes).toBe(480);
      expect(moved.body.timelogs).toEqual(before.timelogs);
      expect(moved.body.adjustments[0]).toMatchObject({ adjustedBy: { publicId: head.personId }, adjustedAs: 'head', reason: 'Most of the morning was on the first site' });

      const over = await send(head.auth, { reason: 'Add travel time', changes: [{ ticketPublicId: c.publicId, minutes: 10 }] });
      expect([over.status, over.body.code, over.body.details]).toEqual([400, 'TICKETS_ADJUST_OVER_ATTENDANCE', { totalMinutes: 490, attendanceMinutes: 480 }]);
      expect((await send(head.auth, { reason: 'Too much', changes: [{ ticketPublicId: b.publicId, minutes: -500 }] })).body.code).toBe('TICKETS_ADJUST_NEGATIVE');
      expect((await send(otherHead.auth, { reason: 'Not my team', changes: [{ ticketPublicId: c.publicId, minutes: -10 }] })).body.code).toBe('TICKETS_FORBIDDEN');
      const byCeo = await send(ceo, { reason: 'Rebalance after review', changes: [{ ticketPublicId: c.publicId, minutes: -10 }, { ticketPublicId: a.publicId, minutes: 10 }] });
      expect(byCeo.body.adjustments.at(-1)).toMatchObject({ adjustedAs: 'management' });
    });

    it('nobody adjusts their own time, and staff cannot change any time', async () => {
      const own = (who: Auth, personId: string) => http().post('/api/tickets/time/adjustments').set(who)
        .send({ personPublicId: personId, date: date(5), reason: 'My own time', changes: [{ ticketPublicId: a.publicId, minutes: 5 }] });
      expect((await own(head.auth, head.personId)).body.code).toBe('TICKETS_SELF_ADJUST');
      expect((await own(ceo, DEMO.ceo.publicId)).body.code).toBe('TICKETS_SELF_ADJUST');
      expect((await own(s.auth, s.personId)).status).toBe(403);                             // staff have no tickets.time.adjust
      const other = await newStaff(app, hr, admin, ['AE']);
      expect((await http().get('/api/tickets/time/allocations').query({ person: s.personId, date: date(5) }).set(other.auth)).status).toBe(403);
      const edit = await db.query(`UPDATE tickets.ticket_timelogs SET ended_at = ended_at + interval '1 hour' WHERE ticket_id = (SELECT id FROM tickets.tickets WHERE public_id = $1)`, [a.publicId])
        .catch((e) => e);
      expect(String(edit.message)).toContain('TICKETS_TIME_NOT_EDITABLE');
      const del = await db.query(`DELETE FROM tickets.ticket_time_adjustments WHERE person_id = (SELECT id FROM core.persons WHERE public_id = $1)`, [s.personId]).catch((e) => e);
      expect(String(del.message)).toContain('TICKETS_APPEND_ONLY');
    });

    it('daily updates: one per ticket per day with percent and files; missing ones are listed for the head next day', async () => {
      const add = await http().post(`/api/tickets/${a.publicId}/updates`).set(s.auth).field('note', 'Frame fixed').field('percentComplete', '60')
        .field('workDate', date(5)).attach('files', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'site.png');
      expect(add.status).toBe(201);
      expect(add.body).toMatchObject({ workDate: date(5), percentComplete: 60, note: 'Frame fixed', attachments: [{ kind: 'photo', fileType: 'png' }] });
      const again = await http().post(`/api/tickets/${a.publicId}/updates`).set(s.auth).send({ note: 'Again', percentComplete: 70, workDate: date(5) });
      expect(again.body.code).toBe('TICKETS_UPDATE_EXISTS');
      expect((await http().post(`/api/tickets/${a.publicId}/updates`).set(s.auth).send({ note: 'Too much', percentComplete: 120 })).body.code).toBe('VALIDATION');
      expect((await http().get(`/api/tickets/${a.publicId}/updates`).set(hr)).body).toHaveLength(1);

      const missing = (await http().get('/api/tickets/daily-updates/missing').query({ date: date(5) }).set(head.auth)).body;
      const mine = missing.filter((m: any) => m.person.publicId === s.personId);
      expect(mine.map((m: any) => m.ticket.publicId).sort()).toEqual([b.publicId, c.publicId].sort());
      expect(mine.every((m: any) => m.minutes > 0)).toBe(true);
      expect((await http().get('/api/tickets/daily-updates/missing').query({ date: date(5) }).set(otherHead.auth)).body).toEqual([]);
    });
  });

  it('no ticket punch-in without the daily punch-in', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const t = await assignedTicket(s);
    expect((await ticketIn(s, [t.publicId], at(6, 1))).body.code).toBe('TICKETS_NOT_PUNCHED_IN');
    await punch(s, 'in', at(6, 2));
    expect((await ticketIn(s, [t.publicId], at(6, 1))).body.code).toBe('TICKETS_NOT_PUNCHED_IN');   // before the punch-in
    await punch(s, 'out', at(6, 3));
    expect((await ticketIn(s, [t.publicId], at(6, 4))).body.code).toBe('TICKETS_NOT_PUNCHED_IN');   // after the punch-out
    expect((await http().get('/api/tickets/time/running').set(s.auth)).body).toEqual([]);
    const notMine = await ticket();
    await punch(s, 'in', at(6, 5));
    expect((await ticketIn(s, [notMine.publicId], at(6, 5))).status).toBe(404);
  });

  it('the daily punch-out stops every running timer; a resend is stored once', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const [t1, t2] = [await assignedTicket(s), await assignedTicket(s)];
    await punch(s, 'in', at(7, 0));
    const ids = [randomUUID(), randomUUID()];
    expect((await ticketIn(s, [t1.publicId, t2.publicId], at(7, 1), ids)).status).toBe(201);
    const resent = await ticketIn(s, [t1.publicId, t2.publicId], at(7, 1), ids);
    expect([resent.status, resent.body.started, resent.body.running.length]).toEqual([200, 0, 2]);
    expect((await ticketIn(s, [t1.publicId], at(7, 2))).body.code).toBe('TICKETS_ALREADY_RUNNING');
    const other = await newStaff(app, hr, admin, ['AE']);
    expect((await http().post('/api/tickets/punch-in').set(other.auth).send({ items: [{ publicId: ids[0], ticketPublicId: t1.publicId }] })).body.code).toBe('TICKETS_DUPLICATE_ID');
    expect((await ticketOut(s, { tickets: [t1.publicId], occurredAt: at(7, 0) })).body.code).toBe('TICKETS_PUNCH_OUT_BEFORE_START');

    await punch(s, 'out', at(7, 5));
    expect((await http().get('/api/tickets/time/running').set(s.auth)).body).toEqual([]);
    const view = await day(s.auth, s, 7);
    expect(view.timelogs.map((l: any) => [l.endReason, l.endedAt])).toEqual([['day_punch_out', at(7, 5)], ['day_punch_out', at(7, 5)]]);
    expect(minutesOf(view)).toEqual({ [t1.number]: 120, [t2.number]: 120 });
    expect((await ticketOut(s, { all: true })).body.stopped).toBe(0);
  });

  it('an overnight open timer adds no hours (automatic punch-out, or the open-punch limit)', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const t = await assignedTicket(s);
    await punch(s, 'in', at(8, 0));
    await ticketIn(s, [t.publicId], at(8, 0.5)).expect(201);
    await punch(s, 'in', at(9, 0));               // forgot to punch out: the day is closed automatically (missed punch)
    expect((await http().get('/api/tickets/time/running').set(s.auth)).body).toEqual([]);
    const view = await day(s.auth, s, 8);
    expect(view.timelogs).toEqual([expect.objectContaining({ endReason: 'unfinished', startedAt: at(8, 0.5), endedAt: at(8, 0.5) })]);
    expect([view.totalMinutes, view.rows]).toEqual([0, []]);

    // no next punch at all: the daily check closes the timer once the punch-in is older than the limit (16 h)
    const s2 = await newStaff(app, hr, admin, ['AE']);
    const t2 = await assignedTicket(s2);
    await punch(s2, 'in', at(10, 0));
    await ticketIn(s2, [t2.publicId], at(10, 1)).expect(201);
    const time = app.get(TicketTimeService);
    await time.closeForgotten(new Date(at(10, 15)));
    expect((await http().get('/api/tickets/time/running').set(s2.auth)).body).toHaveLength(1);    // still inside 16 h
    expect(await time.closeForgotten(new Date(at(10, 17)))).toBeGreaterThanOrEqual(1);
    const after = await day(s2.auth, s2, 10);
    expect([after.timelogs[0].endReason, after.totalMinutes]).toEqual(['unfinished', 0]);
  });

  it('ticket time never exceeds attendance, also after a correction shortens the day', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const [t1, t2] = [await assignedTicket(s), await assignedTicket(s)];
    await punch(s, 'in', at(12, 0));
    await ticketIn(s, [t1.publicId, t2.publicId], at(12, 0)).expect(201);
    const out = await punch(s, 'out', at(12, 8));
    expect(minutesOf(await day(s.auth, s, 12))).toEqual({ [t1.number]: 240, [t2.number]: 240 });

    const corr = await http().post('/api/hrms/attendance/corrections').set(s.auth).send({ employmentPublicId: s.jobs.AE, workDate: date(12), kind: 'wrong_time',
      requestedOut: at(12, 4), punchIdsToExclude: [out.publicId], reason: 'I left at 13:00, punched out late from home' });
    expect(corr.status).toBe(201);
    await http().post(`/api/hrms/attendance/corrections/${corr.body.publicId}/approve`).set(hr).send({}).expect(200);
    const view = await day(s.auth, s, 12);
    expect([view.attendanceMinutes, view.totalMinutes]).toEqual([240, 240]);
    expect(minutesOf(view)).toEqual({ [t1.number]: 120, [t2.number]: 120 });
    expect(view.timelogs.map((l: any) => l.endedAt)).toEqual([at(12, 8), at(12, 8)]);   // the timelogs themselves never change
  });
});
