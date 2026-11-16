import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff, Staff } from '../../test/staff';
import { tag } from '../../test/people';
import { addDays, todayIst } from '../../platform/time';

type Auth = Record<string, string>;
const H = 3_600_000;
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
/** a recent IST date (suggestions reach only a few days back): 1 = yesterday */
const daysAgo = (n: number) => addDays(todayIst(), -n);
/** hours after 09:00 IST on that date */
const at = (date: string, hours: number) => new Date(new Date(`${date}T09:00:00+05:30`).getTime() + hours * H).toISOString();

describe('Ticket time split suggestions API', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, adminUser: Auth;
  let head: Staff, otherHead: Staff;
  let dept: string, siteWork: string;
  const http = () => request(app.getHttpServer());

  const ticket = async () => (await http().post('/api/tickets').set(adminUser).send({ company: 'AE', typePublicId: siteWork,
    title: `Split ${tag()}`, departmentPublicId: dept, scheduledAt: at(daysAgo(5), 0), details: { site: 'Goa' } }).expect(201)).body;
  const assignedTicket = async (s: Staff) => {
    const t = await ticket();
    await http().put(`/api/tickets/${t.publicId}/assignees`).set(head.auth).send({ assignees: [{ employmentPublicId: s.jobs.AE }] }).expect(200);
    return t;
  };
  const punch = async (s: Staff, kind: 'in' | 'out', occurredAt: string) => {
    const res = await http().post('/api/hrms/attendance/punches').set(s.auth).send({ publicId: randomUUID(), employmentPublicId: s.jobs.AE, kind, occurredAt });
    if (res.status !== 201) throw new Error(`punch failed: ${res.status} ${JSON.stringify(res.body)}`);
  };
  /** A finished day: punched in 6 h with every ticket running together, so each gets an equal share (days in time order per person). */
  const workDay = async (s: Staff, date: string, tickets: { publicId: string }[]) => {
    await punch(s, 'in', at(date, 0));
    await http().post('/api/tickets/punch-in').set(s.auth)
      .send({ occurredAt: at(date, 0), items: tickets.map((t) => ({ publicId: randomUUID(), ticketPublicId: t.publicId })) }).expect(201);
    await punch(s, 'out', at(date, 6));   // stops the timers; the day's split is calculated
  };
  const minutes = async (who: Auth, s: Staff, date: string) => {
    const view = (await http().get('/api/tickets/time/allocations').query({ person: s.personId, date }).set(who).expect(200)).body;
    return Object.fromEntries(view.rows.map((r: { ticket: { publicId: string }; minutes: number }) => [r.ticket.publicId, r.minutes]));
  };
  const suggest = (s: Staff, date: string, split: [{ publicId: string }, number][], extra: Record<string, unknown> = {}) =>
    http().post('/api/tickets/time/suggestions').set(s.auth)
      .send({ publicId: randomUUID(), date, tickets: split.map(([t, m]) => ({ ticketPublicId: t.publicId, minutes: m })), ...extra });

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    const grant = (personId: string, roleCode: string, scope: string) =>
      http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode, scope }).expect(201);
    [head, otherHead] = await Promise.all([newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE'])]);
    await grant(head.personId, 'manager', 'team');
    await grant(otherHead.personId, 'manager', 'team');
    const a = await newStaff(app, hr, admin, ['AE']);
    await grant(a.personId, 'admin_user', 'all');
    await grant(a.personId, 'manager', 'team');
    adminUser = a.auth;
    dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Split ${tag()}`, codePrefix: letters() }).expect(201)).body.publicId;
    await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: head.personId }).expect(200);
    siteWork = (await http().get('/api/tickets/types').query({ company: 'AE' }).set(hr)).body.find((t: { code: string }) => t.code === 'site_work').publicId;
  }, 60_000);
  afterAll(async () => { await app?.close(); });

  it('the person suggests 4 h / 1 h 20 / 40 min; nothing changes until the head approves, then it is the head\'s adjustment', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const [a, b, c] = [await assignedTicket(s), await assignedTicket(s), await assignedTicket(s)];
    const date = daysAgo(1);
    await workDay(s, date, [a, b, c]);
    expect(await minutes(s.auth, s, date)).toEqual({ [a.publicId]: 120, [b.publicId]: 120, [c.publicId]: 120 });   // the equal split

    const publicId = randomUUID();
    const body = { publicId, date, note: 'Most of the day on the first site', tickets: [
      { ticketPublicId: a.publicId, minutes: 240 }, { ticketPublicId: b.publicId, minutes: 80 }, { ticketPublicId: c.publicId, minutes: 40 }] };
    const made = await http().post('/api/tickets/time/suggestions').set(s.auth).send(body);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ publicId, date, status: 'pending', note: 'Most of the day on the first site', canDecide: false, decidedBy: null });
    expect(made.body.rows.map((r: any) => [r.beforeMinutes, r.suggestedMinutes, r.approvedMinutes]).sort())
      .toEqual([[120, 240, null], [120, 40, null], [120, 80, null]].sort());
    const again = await http().post('/api/tickets/time/suggestions').set(s.auth).send(body);   // a resend is stored once
    expect([again.status, again.body.publicId]).toEqual([200, publicId]);
    expect(await minutes(s.auth, s, date)).toEqual({ [a.publicId]: 120, [b.publicId]: 120, [c.publicId]: 120 });   // nothing changed yet

    // the person cannot decide it, nor a head of another department
    expect((await http().post(`/api/tickets/time/suggestions/${publicId}/approve`).set(s.auth).send({})).status).toBe(403);
    const other = await http().post(`/api/tickets/time/suggestions/${publicId}/approve`).set(otherHead.auth).send({});
    expect([other.status, other.body.code]).toEqual([403, 'TICKETS_FORBIDDEN']);

    const waiting = (await http().get('/api/tickets/time/suggestions').query({ status: 'pending' }).set(head.auth).expect(200)).body;
    expect(waiting.find((x: any) => x.publicId === publicId)).toMatchObject({ canDecide: true, person: { publicId: s.personId } });
    expect((await http().get('/api/tickets/time/suggestions').set(otherHead.auth).expect(200)).body.some((x: any) => x.publicId === publicId)).toBe(false);

    const ok = await http().post(`/api/tickets/time/suggestions/${publicId}/approve`).set(head.auth).send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', decidedBy: { publicId: head.personId }, decidedAs: 'head', canDecide: false });
    expect(await minutes(s.auth, s, date)).toEqual({ [a.publicId]: 240, [b.publicId]: 80, [c.publicId]: 40 });
    const view = (await http().get('/api/tickets/time/allocations').query({ person: s.personId, date }).set(head.auth)).body;
    expect(view.totalMinutes).toBe(360);                                                    // time only moved
    expect(view.adjustments[0]).toMatchObject({ adjustedBy: { publicId: head.personId }, adjustedAs: 'head' });
    expect(view.adjustments[0].reason).toContain('Split suggested by');
    expect(view.adjustments[0].reason).toContain('Most of the day on the first site');

    const twice = await http().post(`/api/tickets/time/suggestions/${publicId}/approve`).set(head.auth).send({});
    expect([twice.status, twice.body.code]).toEqual([409, 'TICKETS_SPLIT_DECIDED']);
  });

  it('the head changes the split (with a reason) or rejects it', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const [a, b, c] = [await assignedTicket(s), await assignedTicket(s), await assignedTicket(s)];
    const older = daysAgo(2), newer = daysAgo(1);
    await workDay(s, older, [a, b, c]);
    await workDay(s, newer, [a, b, c]);

    const first = (await suggest(s, newer, [[a, 240], [b, 80], [c, 40]]).expect(201)).body.publicId;
    const changed = [{ ticketPublicId: a.publicId, minutes: 200 }, { ticketPublicId: b.publicId, minutes: 100 }, { ticketPublicId: c.publicId, minutes: 60 }];
    const noReason = await http().post(`/api/tickets/time/suggestions/${first}/approve`).set(head.auth).send({ tickets: changed });
    expect([noReason.status, noReason.body.code]).toEqual([400, 'VALIDATION']);
    const wrongTotal = await http().post(`/api/tickets/time/suggestions/${first}/approve`).set(head.auth)
      .send({ reason: 'Site visit was shorter', tickets: [{ ...changed[0], minutes: 300 }, changed[1], changed[2]] });
    expect([wrongTotal.status, wrongTotal.body.code]).toEqual([400, 'TICKETS_SPLIT_TOTAL']);
    const ok = await http().post(`/api/tickets/time/suggestions/${first}/approve`).set(head.auth).send({ reason: 'Site visit was shorter', tickets: changed });
    expect(ok.status).toBe(200);
    expect(ok.body.decisionReason).toBe('Site visit was shorter');
    expect(await minutes(s.auth, s, newer)).toEqual({ [a.publicId]: 200, [b.publicId]: 100, [c.publicId]: 60 });

    const second = (await suggest(s, older, [[a, 300], [b, 30], [c, 30]]).expect(201)).body.publicId;
    expect((await http().post(`/api/tickets/time/suggestions/${second}/reject`).set(head.auth).send({})).status).toBe(400);   // a reason is needed
    const no = await http().post(`/api/tickets/time/suggestions/${second}/reject`).set(head.auth).send({ reason: 'All three ran the whole day' });
    expect(no.body).toMatchObject({ status: 'rejected', decisionReason: 'All three ran the whole day' });
    expect(await minutes(s.auth, s, older)).toEqual({ [a.publicId]: 120, [b.publicId]: 120, [c.publicId]: 120 });   // the equal split stands
  });

  it('refuses a split that does not add up, an unchanged one, a ticket without time, a second pending one, an old day, and today before the punch-out', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    const [a, b] = [await assignedTicket(s), await assignedTicket(s)];
    const idle = await assignedTicket(s);
    const date = daysAgo(2);
    await workDay(s, date, [a, b]);                                     // 180 / 180

    const total = await suggest(s, date, [[a, 300], [b, 100]]);
    expect([total.status, total.body.code, total.body.details]).toEqual([400, 'TICKETS_SPLIT_TOTAL', { totalMinutes: 360, givenMinutes: 400 }]);
    expect((await suggest(s, date, [[a, 180], [b, 180]])).body.code).toBe('TICKETS_SPLIT_UNCHANGED');
    expect((await suggest(s, date, [[a, 360], [idle, 0]])).body.code).toBe('TICKETS_SPLIT_UNKNOWN_TICKET');
    expect((await suggest(s, date, [[a, 360]])).status).toBe(400);   // one ticket is no split

    const first = (await suggest(s, date, [[a, 300], [b, 60]]).expect(201)).body.publicId;
    const second = await suggest(s, date, [[a, 240], [b, 120]]);
    expect([second.status, second.body.code]).toEqual([409, 'TICKETS_SPLIT_PENDING']);
    const cancelled = await http().post(`/api/tickets/time/suggestions/${first}/cancel`).set(s.auth).send({});
    expect([cancelled.status, cancelled.body.status]).toEqual([200, 'cancelled']);
    expect((await http().post(`/api/tickets/time/suggestions/${first}/cancel`).set(head.auth).send({})).status).toBe(404);   // only the person's own
    expect((await suggest(s, date, [[a, 240], [b, 120]])).status).toBe(201);

    expect((await suggest(s, daysAgo(10), [[a, 240], [b, 120]])).body.code).toBe('TICKETS_SPLIT_TOO_OLD');   // tickets.time.suggest_days: 7

    await punch(s, 'in', new Date(Date.now() - 60_000).toISOString());  // still working today
    const today = await suggest(s, todayIst(), [[a, 240], [b, 120]]);
    expect([today.status, today.body.code]).toEqual([409, 'TICKETS_DAY_NOT_FINISHED']);
  });
});
