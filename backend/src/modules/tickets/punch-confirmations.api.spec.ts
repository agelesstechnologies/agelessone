import { randomUUID } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff, Staff } from '../../test/staff';
import { tag } from '../../test/people';
import { CoreFacade } from '../core/core.facade';

type Auth = Record<string, string>;
const H = 3_600_000;
const at = (day: number, hours: number) => new Date(Date.UTC(2026, 9, day, 3, 30) + hours * H).toISOString();
const SPOT = { latitude: 15.4909, longitude: 73.8278, accuracyM: 12 };   // a made-up spot (never a real person's location)
const ADDRESS = 'Test Road 1, Test Town, Goa';

describe('Punch confirmations and addresses', () => {
  let app: INestApplication;
  let db: pg.Client;
  let server: Server;
  /** what the fake geocoding provider does: answer an address, or fail */
  let mode: 'answer' | 'fail' = 'answer';
  let calls = 0;
  let hr: Auth, admin: Auth, adminUser: Auth;
  let head: Staff;
  let dept: string;
  const http = () => request(app.getHttpServer());
  const punch = (s: Staff, kind: 'in' | 'out', occurredAt: string, where: object = SPOT, publicId = randomUUID()) =>
    http().post('/api/hrms/attendance/punches').set(s.auth).send({ publicId, employmentPublicId: s.jobs.AE, kind, occurredAt, ...where });
  const placeOf = async (punchId: string) => (await db.query(
    'SELECT p.status, p.address, p.attempts FROM hrms.attendance_events e JOIN core.places p ON p.id = e.place_id WHERE e.public_id = $1', [punchId])).rows[0];

  beforeAll(async () => {
    server = createServer((req, res) => {
      calls++;
      if (mode === 'fail' || !req.url?.startsWith('/reverse?')) { res.writeHead(503).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ display_name: ADDRESS }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    process.env.GEOCODING_PROVIDER = 'nominatim';
    process.env.GEOCODING_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    head = await newStaff(app, hr, admin, ['AE']);
    await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: head.personId, roleCode: 'supervisor', scope: 'team' }).expect(201);
    const a = await newStaff(app, hr, admin, ['AE']);
    await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: a.personId, roleCode: 'admin_user', scope: 'all' }).expect(201);
    // admin user no longer creates tickets: a supervisor of the company does
    await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: a.personId, roleCode: 'supervisor', scope: 'team' }).expect(201);
    adminUser = a.auth;
    const prefix = Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
    dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Confirm ${tag()}`, codePrefix: prefix }).expect(201)).body.publicId;
    await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: head.personId }).expect(200);
  }, 60_000); // heavy setup: give it time when the whole suite runs in parallel
  afterAll(async () => {
    process.env.GEOCODING_PROVIDER = 'none';
    delete process.env.GEOCODING_URL;
    await db?.end(); await app?.close();
    await new Promise((done) => server?.close(done));
  });

  it('the daily punch-in answers time and address when the provider answers; the address is stored with the punch', async () => {
    mode = 'answer';
    const s = await newStaff(app, hr, admin, ['AE']);
    const id = randomUUID();
    const res = await punch(s, 'in', at(22, 0), SPOT, id);
    expect(res.status).toBe(201);
    expect(res.body.confirmation).toEqual({ message: `Punched in at 09:00 IST on 22 Oct 2026, ${ADDRESS}`, at: at(22, 0),
      address: ADDRESS, latitude: SPOT.latitude, longitude: SPOT.longitude });
    expect(await placeOf(id)).toEqual({ status: 'resolved', address: ADDRESS, attempts: 1 });
  });

  it('when the lookup fails only coordinates are stored, and the background job fills in the address later', async () => {
    const s = await newStaff(app, hr, admin, ['AE']);
    await punch(s, 'in', at(23, 0)).expect(201);
    mode = 'fail';
    const id = randomUUID();
    const out = await punch(s, 'out', at(23, 8), SPOT, id);
    expect(out.body.confirmation).toMatchObject({ address: null, latitude: SPOT.latitude, longitude: SPOT.longitude });
    expect(out.body.confirmation.message).toBe('Punched out at 17:00 IST on 23 Oct 2026, location 15.490900, 73.827800 (address to follow)');
    expect(await placeOf(id)).toEqual({ status: 'pending', address: null, attempts: 1 });

    const core = app.get(CoreFacade);
    expect((await core.retryAddresses()).resolved).toBe(0);           // still failing: tried again, still pending
    expect((await placeOf(id)).attempts).toBe(2);
    mode = 'answer';
    expect((await core.retryAddresses()).resolved).toBeGreaterThanOrEqual(1);
    expect(await placeOf(id)).toEqual({ status: 'resolved', address: ADDRESS, attempts: 3 });
    // the stored punch now confirms with the address (a resend answers the stored punch)
    const again = await punch(s, 'out', at(23, 8), SPOT, id);
    expect([again.status, again.body.confirmation.address]).toEqual([200, ADDRESS]);
  });

  it('without a provider: coordinates only, nothing is called, and the job waits', async () => {
    process.env.GEOCODING_PROVIDER = 'none';
    try {
      const s = await newStaff(app, hr, admin, ['AE']);
      const before = calls;
      const id = randomUUID();
      const res = await punch(s, 'in', at(24, 0), SPOT, id);
      expect(res.body.confirmation.address).toBeNull();
      expect(await placeOf(id)).toEqual({ status: 'pending', address: null, attempts: 0 });
      expect(await app.get(CoreFacade).retryAddresses()).toEqual({ resolved: 0, stillPending: 0, gaveUp: 0 });
      expect(calls).toBe(before);
      const noLocation = await punch(s, 'out', at(24, 1), {});
      expect(noLocation.body.confirmation).toMatchObject({ address: null, latitude: null, message: 'Punched out at 10:00 IST on 24 Oct 2026, no location sent' });
    } finally {
      process.env.GEOCODING_PROVIDER = 'nominatim';
    }
  });

  it('bulk ticket punch-in confirms each ticket (number, customer, description) with time and address', async () => {
    mode = 'answer';
    const s = await newStaff(app, hr, admin, ['AE']);
    const types = (await http().get('/api/tickets/types').query({ company: 'AE' }).set(hr)).body;
    const make = async (code: string, details: object, description: string) => {
      const t = (await http().post('/api/tickets').set(adminUser).send({ company: 'AE', typePublicId: types.find((x: any) => x.code === code).publicId,
        title: `Confirm ${tag()}`, description, departmentPublicId: dept, scheduledAt: at(25, 0), details }).expect(201)).body;
      await http().put(`/api/tickets/${t.publicId}/assignees`).set(head.auth).send({ assignees: [{ employmentPublicId: s.jobs.AE }] }).expect(200);
      return t;
    };
    const visit = await make('sales_visit', { customer: 'Wonder Park' }, 'Demo of the new ride');
    const site = await make('site_work', { site: 'Goa' }, 'Fix the gate');
    await punch(s, 'in', at(25, 0)).expect(201);
    const ids = [randomUUID(), randomUUID()];
    const res = await http().post('/api/tickets/punch-in').set(s.auth).send({ occurredAt: at(25, 0.5), ...SPOT,
      items: [{ publicId: ids[0], ticketPublicId: visit.publicId }, { publicId: ids[1], ticketPublicId: site.publicId }] });
    expect(res.status).toBe(201);
    expect(res.body.confirmation).toMatchObject({ at: at(25, 0.5), address: ADDRESS, message: `Ticket punch-in (2 tickets) at 09:30 IST on 25 Oct 2026, ${ADDRESS}` });
    expect(res.body.confirmation.tickets).toEqual(expect.arrayContaining([
      { publicId: visit.publicId, number: visit.number, customer: 'Wonder Park', description: 'Demo of the new ride' },
      { publicId: site.publicId, number: site.number, customer: null, description: 'Fix the gate' },
    ]));
    const resent = await http().post('/api/tickets/punch-in').set(s.auth).send({ occurredAt: at(25, 0.5), ...SPOT,
      items: [{ publicId: ids[0], ticketPublicId: visit.publicId }, { publicId: ids[1], ticketPublicId: site.publicId }] });
    expect([resent.status, resent.body.confirmation.tickets.length, resent.body.confirmation.address]).toEqual([200, 2, ADDRESS]);
  });
});
