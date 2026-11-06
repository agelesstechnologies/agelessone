import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff, Staff } from '../../test/staff';
import { tag } from '../../test/people';

type Auth = Record<string, string>;
const H = 3_600_000;
const DAY = '2026-10-20';                 // no other test uses this date
const at = (hours: number) => new Date(Date.UTC(2026, 9, 20, 3, 30) + hours * H).toISOString();
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

/** The table part of a CSV report and its "about" lines. */
function parseCsv(text: string) {
  const lines = text.replace(/^﻿/, '').trimEnd().split('\r\n');
  const blank = lines.indexOf('');
  const split = (l: string) => l.split(',');
  return { about: Object.fromEntries(lines.slice(0, blank).map((l) => [split(l)[0], split(l).slice(1).join(',')])),
    header: split(lines[blank + 1]), rows: lines.slice(blank + 2).map(split) };
}

describe('Ticket reports and dashboard', () => {
  let app: INestApplication;
  let hr: Auth, admin: Auth, ceo: Auth, adminUser: Auth;
  let head: Staff, otherHead: Staff, s1: Staff, s2: Staff;
  let deptA: string, deptB: string;
  let a1: any, a2: any, b1: any, overdue: any;
  const types: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const get = (who: Auth, path: string, query: Record<string, string> = {}) => http().get(`/api/tickets/${path}`).query(query).set(who);
  const period = { from: DAY, to: DAY };

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo].map((d) => signIn(app, d.login)));
    const grant = (personId: string, roleCode: string, scope: string) =>
      http().post('/api/core/role-assignments').set(admin).send({ personPublicId: personId, roleCode, scope }).expect(201);
    [head, otherHead, s1, s2] = await Promise.all(Array.from({ length: 4 }, () => newStaff(app, hr, admin, ['AE'])));
    await grant(head.personId, 'supervisor', 'team');
    await grant(otherHead.personId, 'supervisor', 'team');
    const a = await newStaff(app, hr, admin, ['AE']);
    await grant(a.personId, 'admin_user', 'all');
    adminUser = a.auth;
    const dept = async (headId: string, member: Staff) => {
      const prefix = letters();
      const d = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Reports ${tag()}`, codePrefix: prefix }).expect(201)).body.publicId;
      await http().patch(`/api/hrms/departments/${d}`).set(hr).send({ headPublicId: headId }).expect(200);
      await http().patch(`/api/hrms/employments/${member.jobs.AE}`).set(hr).send({ departmentCode: prefix }).expect(200);
      return d;
    };
    deptA = await dept(head.personId, s1);
    deptB = await dept(otherHead.personId, s2);
    for (const t of (await http().get('/api/tickets/types').query({ company: 'AE' }).set(hr)).body) types[t.code] = t.publicId;

    const ticket = async (code: string, department: string, s: Staff | null, details: object, over: object = {}) => {
      const t = (await http().post('/api/tickets').set(adminUser).send({ company: 'AE', typePublicId: types[code], title: `Report ${tag()}`,
        departmentPublicId: department, scheduledAt: at(0), details, ...over }).expect(201)).body;
      if (s) await http().put(`/api/tickets/${t.publicId}/assignees`).set(adminUser).send({ assignees: [{ employmentPublicId: s.jobs.AE }] }).expect(200);
      return t;
    };
    a1 = await ticket('sales_visit', deptA, s1, { customer: 'Wonder Park' });
    a2 = await ticket('site_work', deptA, s1, { site: 'Goa' });
    b1 = await ticket('site_work', deptB, s2, { site: 'Pune' });
    overdue = await ticket('site_work', deptA, null, { site: 'Goa' }, { dueDate: '2026-10-01', priority: 1 });

    const punch = (s: Staff, kind: 'in' | 'out', occurredAt: string) => http().post('/api/hrms/attendance/punches').set(s.auth)
      .send({ publicId: randomUUID(), employmentPublicId: s.jobs.AE, kind, occurredAt }).expect(201);
    const ticketIn = (s: Staff, ids: string[], occurredAt: string) => http().post('/api/tickets/punch-in').set(s.auth)
      .send({ occurredAt, items: ids.map((t) => ({ publicId: randomUUID(), ticketPublicId: t })) }).expect(201);
    // s1: attended 6 h; A1 and A2 together 1 h, then A2 alone 4 h (30 + 270 min), 1 h on no ticket
    await punch(s1, 'in', at(0));
    await ticketIn(s1, [a1.publicId, a2.publicId], at(1));
    await http().post('/api/tickets/punch-out').set(s1.auth).send({ tickets: [a1.publicId], occurredAt: at(2) }).expect(200);
    await punch(s1, 'out', at(6));
    // s2: B1 for all 4 attended hours
    await punch(s2, 'in', at(0));
    await ticketIn(s2, [b1.publicId], at(0));
    await punch(s2, 'out', at(4));
    // Management moves 10 minutes from A2 to A1
    await http().post('/api/tickets/time/adjustments').set(ceo).send({ personPublicId: s1.personId, date: DAY, reason: 'Visit ran longer',
      changes: [{ ticketPublicId: a1.publicId, minutes: 10 }, { ticketPublicId: a2.publicId, minutes: -10 }] }).expect(201);
  }, 60_000); // heavy setup: give it time when the whole suite runs in parallel
  afterAll(async () => { await app?.close(); });

  it('hours come from allocated time (with adjustments) and add up to the allocations', async () => {
    const r = (await get(adminUser, 'reports/hours', { ...period, by: 'ticket', company: 'AE' })).body;
    expect(r).toMatchObject({ report: 'hours', company: 'AE', from: DAY, to: DAY, by: 'ticket', producedAt: expect.any(String) });
    expect(Object.fromEntries(r.rows.map((x: any) => [x.key, x.minutes]))).toEqual({ [a1.publicId]: 40, [a2.publicId]: 260, [b1.publicId]: 240 });
    expect(r.rows.find((x: any) => x.key === a2.publicId).hours).toBe(4.33);
    const days = await Promise.all([s1, s2].map((s) => get(adminUser, 'time/allocations', { person: s.personId, date: DAY })));
    expect(r.totals).toEqual({ minutes: days[0].body.totalMinutes + days[1].body.totalMinutes, hours: 9 });
    expect(r.totals.minutes).toBe(540);

    const by = async (dimension: string) => Object.fromEntries((await get(hr, 'reports/hours', { ...period, by: dimension })).body.rows.map((x: any) => [x.label, x.minutes]));
    expect(await by('type')).toEqual({ 'Sales visit': 40, 'Site work': 500 });
    expect(await by('customer')).toEqual({ 'Wonder Park': 40, '(no customer)': 500 });
    const people = await by('person');
    expect([people[(await get(hr, `${a1.publicId}`)).body.primaryAssignee.person.displayName], Object.values(people).sort()]).toEqual([300, [240, 300]]);
    const depts = (await get(hr, 'reports/hours', { ...period, by: 'department' })).body.rows;
    expect(Object.fromEntries(depts.map((x: any) => [x.key, x.minutes]))).toEqual({ [deptA]: 300, [deptB]: 240 });
  });

  it('utilisation = ticket time / attendance; unallocated = attendance minus ticket time', async () => {
    const r = (await get(hr, 'reports/utilisation', period)).body;
    const row = (s: Staff) => r.rows.find((x: any) => x.person.publicId === s.personId);
    expect(row(s1)).toMatchObject({ attendanceMinutes: 360, ticketMinutes: 300, unallocatedMinutes: 60, utilisationPercent: 83.3 });
    expect(row(s2)).toMatchObject({ attendanceMinutes: 240, ticketMinutes: 240, unallocatedMinutes: 0, utilisationPercent: 100 });
    const sum = (k: string) => r.rows.reduce((t: number, x: any) => t + x[k], 0);
    expect([r.totals.attendanceMinutes, r.totals.ticketMinutes, r.totals.unallocatedMinutes]).toEqual([sum('attendanceMinutes'), sum('ticketMinutes'), sum('unallocatedMinutes')]);
    // the head's view holds only s1, so its totals are exact
    expect((await get(head.auth, 'reports/utilisation', period)).body.totals)
      .toEqual({ attendanceMinutes: 360, ticketMinutes: 300, unallocatedMinutes: 60, utilisationPercent: 83.3 });
  });

  it('a department head sees only their department; staff see no reports', async () => {
    const hours = (await get(head.auth, 'reports/hours', { ...period, by: 'ticket' })).body;
    expect(hours.rows.map((x: any) => x.key).sort()).toEqual([a1.publicId, a2.publicId].sort());
    expect(hours.totals.minutes).toBe(300);
    expect((await get(otherHead.auth, 'reports/hours', { ...period, by: 'department' })).body.rows).toEqual([expect.objectContaining({ key: deptB, minutes: 240 })]);
    const util = (await get(head.auth, 'reports/utilisation', period)).body;
    expect(util.rows.map((x: any) => x.person.publicId)).toEqual([s1.personId]);
    const missing = (await get(head.auth, 'reports/missing-updates', period)).body;
    expect(missing.rows).toEqual([{ person: expect.objectContaining({ publicId: s1.personId }), missingUpdates: 2, tickets: 2, minutes: 300 }]);
    expect((await get(head.auth, 'reports/overdue')).body.rows.map((x: any) => x.ticket.publicId)).toEqual([overdue.publicId]);
    expect((await get(otherHead.auth, 'reports/overdue')).body.rows).toEqual([]);
    expect((await get(s1.auth, 'reports/hours', period)).body.code).toBe('TICKETS_FORBIDDEN');
    expect((await get(s1.auth, 'dashboard')).status).toBe(403);
  });

  it('the CSV has the same rows and totals as the screen, and says period, company and when produced', async () => {
    for (const [path, query, total] of [
      ['reports/hours', { ...period, by: 'ticket', company: 'AE' }, (r: any) => [String(r.totals.minutes), (r.totals.minutes / 60).toFixed(2)]],
      ['reports/utilisation', { ...period }, (r: any) => [String(r.totals.attendanceMinutes), (r.totals.attendanceMinutes / 60).toFixed(2), String(r.totals.ticketMinutes)]],
    ] as const) {
      const screen = (await get(hr, path, query)).body;
      const res = await get(hr, path, { ...query, format: 'csv' });
      expect(res.headers['content-type']).toContain('text/csv');
      const csv = parseCsv(res.text);
      expect(csv.about).toMatchObject({ Company: screen.company ?? 'All companies', Period: `${DAY} to ${DAY}`, 'Produced at': expect.any(String) });
      expect(csv.rows).toHaveLength(screen.rows.length + 1);
      const totalLine = csv.rows.at(-1)!;
      expect(totalLine[0]).toBe('TOTAL');
      expect(totalLine.slice(1, 1 + total(screen).length)).toEqual(total(screen));
      expect(csv.rows.slice(0, -1).reduce((a: number, r: string[]) => a + Number(r[1]), 0)).toBe(Number(totalLine[1]));
    }
  });

  it('on hold with reasons, created vs completed per week, and the dashboard numbers', async () => {
    await http().post(`/api/tickets/${a2.publicId}/hold`).set(head.auth).send({ reason: 'Waiting for the crane' }).expect(200);
    const held = (await get(head.auth, 'reports/on-hold')).body;
    expect(held.rows).toEqual([expect.objectContaining({ ticket: expect.objectContaining({ publicId: a2.publicId }), holdReason: 'Waiting for the crane',
      heldSince: expect.any(String), status: 'on_hold', primaryAssignee: expect.objectContaining({ publicId: s1.personId }) })]);

    const done = (await http().post('/api/tickets').set(adminUser).send({ company: 'AE', typePublicId: types.packing_transport, title: `Dispatch ${tag()}`,
      departmentPublicId: deptA, scheduledAt: at(0), details: { items: 'Frame', vehicle_number: 'GA-01-0000', dispatch_date: DAY } }).expect(201)).body;
    await http().put(`/api/tickets/${done.publicId}/assignees`).set(adminUser).send({ assignees: [{ employmentPublicId: s1.jobs.AE }] }).expect(200);
    await http().post(`/api/tickets/${done.publicId}/start`).set(s1.auth).expect(200);
    await http().post(`/api/tickets/${done.publicId}/complete`).set(s1.auth).expect(200);

    const today = new Date().toISOString().slice(0, 10);
    const weekly = (await get(head.auth, 'reports/weekly', { from: '2026-01-01', to: today < '2026-01-02' ? '2026-12-31' : today })).body;
    expect(weekly.totals).toEqual({ created: 4, completed: 1 });          // A1, A2, the overdue one, the dispatch
    expect(weekly.rows.find((x: any) => x.type.code === 'packing_transport')).toMatchObject({ created: 1, completed: 1 });

    const dash = (await get(head.auth, 'dashboard')).body;
    expect(dash).toMatchObject({ open: 3, overdue: 1, completedThisMonth: 1, completedLastMonth: 0 });
    expect(dash.openByType).toEqual(expect.arrayContaining([{ type: { code: 'site_work', name: 'Site work' }, count: 2 }, { type: { code: 'sales_visit', name: 'Sales visit' }, count: 1 }]));
    expect(dash.openByPriority).toEqual([{ priority: 1, count: 1 }, { priority: 3, count: 2 }]);
    expect(dash.openByTypeAndPriority).toEqual(expect.arrayContaining([{ type: { code: 'site_work', name: 'Site work' }, priority: 1, count: 1 }]));
    const all = (await get(ceo, 'dashboard', { company: 'AE' })).body;
    expect(all.open).toBeGreaterThanOrEqual(dash.open);
    expect(all.overdue).toBeGreaterThanOrEqual(1);
  });
});
