import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { tag } from '../../test/people';
import { newStaff, Staff } from '../../test/staff';
import { addDays, todayIst } from '../../platform/time';
import { RequestsService } from './application/requests.service';

type Auth = Record<string, string>;
// Fictional data only. AE is used here (ATPL's departments are counted by another test); codes carry a random part.
const T = tag().slice(0, 4);

describe('Inventory part requests, reservations, serials, batches, cross-company requesters', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth;
  let keeper: Staff;      // AE store in-charge (team): approves, posts
  let head: Staff;        // head of the AE department the tickets belong to (Manager role)
  let requester: Staff;   // AE Parts requester, assigned to the tickets
  let other: Staff;       // AE employee assigned to the ticket, without the Parts requester role
  let dual: Staff;        // AE store in-charge who is also a Parts requester on the ticket
  let grantee: Staff;     // ATPL person: requests for one AE ticket through a grant
  let maker: Staff;       // AE Manager + Admin user: creates and cancels tickets
  const ids: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const post = (auth: Auth, path: string, body: object) => http().post(`/api/inventory/${path}`).set(auth).send(body);
  const get = (auth: Auth, path: string) => http().get(`/api/inventory/${path}`).set(auth);
  const role = (s: Staff, roleCode: string, scope: string) =>
    http().post('/api/core/role-assignments').set(admin).send({ personPublicId: s.personId, roleCode, scope }).expect(201);
  const ask = (auth: Auth, ticket: string, lines: { item: string; quantity: number }[]) =>
    post(auth, 'requests', { ticketPublicId: ticket, lines: lines.map((l) => ({ itemPublicId: l.item, quantity: l.quantity })) });
  const stockAt = async (item: string, location: string) =>
    ((await get(keeper.auth, `stock?item=${item}&includeEmpty=true`).expect(200)).body.items as any[]).find((r) => r.location.publicId === location && r.batch === null);
  const receive = (item: string, quantity: number, cost: number, location: string, extra: object = {}) =>
    post(keeper.auth, 'receipts', { company: 'AE', supplierName: 'Fictional Supplies', reason: 'Direct purchase',
      lines: [{ itemPublicId: item, locationPublicId: location, quantity, unitCostMinor: cost, ...extra }] });

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    [keeper, head, requester, other, dual, grantee, maker] = await Promise.all([
      newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE']),
      newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['ATPL']), newStaff(app, hr, admin, ['AE'])]);
    await role(keeper, 'store_incharge', 'team');
    await role(head, 'manager', 'team');
    await role(requester, 'parts_requester', 'own');
    await role(dual, 'store_incharge', 'team');
    await role(dual, 'parts_requester', 'own');
    await role(maker, 'manager', 'team');
    await role(maker, 'admin_user', 'all');

    const letters = Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
    const dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `Workshop ${T} ${letters}`, codePrefix: letters }).expect(201)).body.publicId;
    await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: head.personId }).expect(200);
    const types = (await http().get('/api/tickets/types?company=AE').set(maker.auth).expect(200)).body as any[];
    const ticket = async (code: string, assignees: Staff[], details: object) => (await http().post('/api/tickets').set(maker.auth).send({
      company: 'AE', typePublicId: types.find((t) => t.code === code).publicId, title: `${code} ${T}`, departmentPublicId: dept, scheduledAt: new Date().toISOString(),
      details, assignees: assignees.map((s, i) => ({ employmentPublicId: s.jobs.AE, isPrimary: i === 0 })) }).expect(201)).body.publicId as string;
    ids.ticket1 = await ticket('production', [requester, other, dual], { item: 'Ride panel' });
    ids.ticket2 = await ticket('production', [requester], { item: 'Spare panel' });
    ids.ticket3 = await ticket('production', [requester], { item: 'Kiosk' });
    ids.design = await ticket('design', [requester], {});

    ids.pcs = (await post(keeper.auth, 'units', { company: 'AE', code: `pc${T}`, name: 'Pieces', decimals: 0 }).expect(201)).body.publicId;
    ids.category = (await post(keeper.auth, 'categories', { company: 'AE', name: `Spares ${T}`, codePrefix: `R${T}` }).expect(201)).body.publicId;
    const item = async (name: string, extra: object = {}) => (await post(keeper.auth, 'items', { company: 'AE', name: `${name} ${T}`, categoryPublicId: ids.category,
      baseUnitPublicId: ids.pcs, ...extra }).expect(201)).body.publicId as string;
    ids.part = await item('Limit switch');
    ids.motor = await item('Servo motor');
    ids.board = await item('Controller board', { tracking: 'serial' });
    ids.resin = await item('Resin cartridge', { tracking: 'batch' });
    const loc = async (code: string) => (await post(keeper.auth, 'locations', { company: 'AE', type: 'store', code: `${code}${T}`, name: `Store ${code}`,
      custodianPersonPublicId: keeper.personId }).expect(201)).body.publicId as string;
    ids.storeA = await loc('A');
    ids.storeB = await loc('B');
    await receive(ids.part, 10, 1000, ids.storeA).expect(201);
    await receive(ids.motor, 5, 600000, ids.storeA).expect(201);
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('a Parts requester assigned to a parts ticket asks for parts; others cannot; requesters never see values', async () => {
    const picker = await get(requester.auth, `requests/items?ticket=${ids.ticket1}&search=${encodeURIComponent(`Limit switch ${T}`)}`);
    expect(picker.status).toBe(200);
    expect(picker.body).toEqual([expect.objectContaining({ publicId: ids.part, inStock: true })]);
    expect(Object.keys(picker.body[0]).sort()).toEqual(['code', 'inStock', 'name', 'publicId', 'unit']);

    const asked = await ask(requester.auth, ids.ticket1, [{ item: ids.part, quantity: 3 }]);
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ status: 'pending', number: expect.stringMatching(/^REQ-\d{5}$/), company: 'AE', crossCompany: false, needsHeadApproval: false,
      estimatedValueMinor: null, requestedBy: { publicId: requester.personId }, canApprove: false, canCancel: true,
      lines: [{ lineNo: 1, item: { publicId: ids.part }, quantity: 3, reserved: 0, issued: 0, estimatedValueMinor: null }] });
    expect((await get(keeper.auth, `requests/${asked.body.publicId}`)).body).toMatchObject({ estimatedValueMinor: 3000, canApprove: true });

    expect((await ask(other.auth, ids.ticket1, [{ item: ids.part, quantity: 1 }])).body.code).toBe('INVENTORY_CANNOT_REQUEST');       // no Parts requester role
    expect((await ask(requester.auth, ids.design, [{ item: ids.part, quantity: 1 }])).body.code).toBe('INVENTORY_CANNOT_REQUEST');    // design does not use parts
    expect((await get(requester.auth, 'items?company=AE')).status).toBe(403);                                                         // no store browsing
    ids.firstRequest = asked.body.publicId;
  });

  it('approval reserves the stock: available drops, a direct issue cannot take it, the issue against the request does', async () => {
    const approved = await post(keeper.auth, `requests/${ids.firstRequest}/approve`, { locations: [{ lineNo: 1, locationPublicId: ids.storeA }] });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'approved', storeApprovedBy: { publicId: keeper.personId }, reserveUntil: addDays(todayIst(), 14),
      lines: [{ reserved: 3, location: { publicId: ids.storeA }, reservations: [{ location: { publicId: ids.storeA }, quantity: 3 }] }] });
    expect(await stockAt(ids.part, ids.storeA)).toMatchObject({ onHand: 10, reserved: 3, available: 7 });

    const grab = await post(keeper.auth, 'issues', { company: 'AE', ticketPublicId: ids.ticket1, lines: [{ itemPublicId: ids.part, locationPublicId: ids.storeA, quantity: 8 }] });
    expect([grab.status, grab.body.code]).toEqual([409, 'INVENTORY_NOT_ENOUGH_AVAILABLE']);

    const issued = await post(keeper.auth, 'issues', { company: 'AE', requestPublicId: ids.firstRequest, requestLines: [{ lineNo: 1 }] });
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ type: 'issue', request: { publicId: ids.firstRequest }, ticket: { publicId: ids.ticket1 },
      lines: [{ requestLineNo: 1, quantity: 3, unitCostMinor: 1000, valueMinor: 3000 }] });
    expect(await stockAt(ids.part, ids.storeA)).toMatchObject({ onHand: 7, reserved: 0, available: 7 });
    expect((await get(keeper.auth, `requests/${ids.firstRequest}`)).body).toMatchObject({ status: 'fulfilled', lines: [{ issued: 3, reserved: 0 }] });
    expect((await post(keeper.auth, 'issues', { company: 'AE', requestPublicId: ids.firstRequest, requestLines: [{ lineNo: 1 }] })).body.code).toBe('INVENTORY_REQUEST_NOT_APPROVED');

    // what the intercompany statement will read: the issue's ticket, request and unit cost
    const event = await db.query(`SELECT payload FROM core.outbox WHERE aggregate_public_id = $1 AND event_type = 'stock.issued'`, [issued.body.publicId]);
    expect(event.rows[0].payload).toMatchObject({ ticketPublicId: ids.ticket1, requestPublicId: ids.firstRequest, lines: [{ quantity: -3, unitCostMinor: 1000, valueMinor: -3000 }] });
  });

  it('above the value limit the department head approves too; nobody approves their own request', async () => {
    const big = (await ask(requester.auth, ids.ticket1, [{ item: ids.motor, quantity: 2 }]).expect(201)).body;   // 2 × ₹6,000 > ₹10,000
    expect(big.needsHeadApproval).toBe(true);
    const store = await post(keeper.auth, `requests/${big.publicId}/approve`, {});
    expect(store.body).toMatchObject({ status: 'pending', storeApprovedBy: { publicId: keeper.personId }, headApprovedBy: null, lines: [{ reserved: 0 }] });
    expect((await post(keeper.auth, `requests/${big.publicId}/approve`, {})).body.code).toBe('INVENTORY_NOT_YOUR_APPROVAL');
    const byHead = await post(head.auth, `requests/${big.publicId}/approve`, {});
    expect(byHead.body).toMatchObject({ status: 'approved', headApprovedBy: { publicId: head.personId }, estimatedValueMinor: 1200000, lines: [{ reserved: 2 }] });
    expect(await stockAt(ids.motor, ids.storeA)).toMatchObject({ reserved: 2, available: 3 });

    const own = (await ask(dual.auth, ids.ticket1, [{ item: ids.part, quantity: 1 }]).expect(201)).body;
    expect((await post(dual.auth, `requests/${own.publicId}/approve`, {})).body.code).toBe('INVENTORY_OWN_REQUEST');
    const rejected = await post(keeper.auth, `requests/${own.publicId}/reject`, { reason: 'Take it from the lab bench' });
    expect(rejected.body).toMatchObject({ status: 'rejected', decidedBy: { publicId: keeper.personId }, decisionReason: 'Take it from the lab bench' });
  });

  it('a reservation expires on its date; cancelling the request or closing its ticket releases it too', async () => {
    const reservedNow = async () => (await stockAt(ids.part, ids.storeA)).reserved;
    const approve = async (r: { publicId: string }, body: object = {}) => post(keeper.auth, `requests/${r.publicId}/approve`, body).expect(200);

    const expiring = (await ask(requester.auth, ids.ticket1, [{ item: ids.part, quantity: 2 }]).expect(201)).body;
    await approve(expiring, { reserveUntil: todayIst() });
    expect(await reservedNow()).toBe(2);
    await db.query(`UPDATE inventory.part_requests SET reserve_until = $1 WHERE public_id = $2`, [addDays(todayIst(), -1), expiring.publicId]);
    const swept = await app.get(RequestsService).releaseDue();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect((await get(keeper.auth, `requests/${expiring.publicId}`)).body).toMatchObject({ status: 'expired', lines: [{ reserved: 0 }] });
    expect(await reservedNow()).toBe(0);

    const cancelled = (await ask(requester.auth, ids.ticket1, [{ item: ids.part, quantity: 1 }]).expect(201)).body;
    await approve(cancelled);
    expect(await reservedNow()).toBe(1);
    expect((await post(requester.auth, `requests/${cancelled.publicId}/cancel`, { reason: 'Found one on the bench' })).body.status).toBe('cancelled');
    expect(await reservedNow()).toBe(0);

    const onTicket2 = (await ask(requester.auth, ids.ticket2, [{ item: ids.part, quantity: 4 }]).expect(201)).body;
    await approve(onTicket2);
    expect(await reservedNow()).toBe(4);
    await http().post(`/api/tickets/${ids.ticket2}/cancel`).set(maker.auth).send({ reason: 'Customer cancelled the order' }).expect(200);
    expect((await get(keeper.auth, `requests/${onTicket2.publicId}`)).body).toMatchObject({ status: 'closed', lines: [{ reserved: 0 }] });
    expect(await reservedNow()).toBe(0);
    expect((await ask(requester.auth, ids.ticket2, [{ item: ids.part, quantity: 1 }])).body.code).toBe('INVENTORY_TICKET_CLOSED');
  });

  it('a serial unit is in one place at a time', async () => {
    const sn = `SN-${T}-1`;
    expect((await receive(ids.board, 1, 250000, ids.storeA, { serialNo: sn })).status).toBe(201);
    const twice = await receive(ids.board, 1, 250000, ids.storeB, { serialNo: sn });
    expect([twice.status, twice.body.code]).toEqual([409, 'INVENTORY_SERIAL_IN_STOCK']);
    expect(twice.body.message).toContain(`already in A${T}`);
    expect((await receive(ids.board, 2, 250000, ids.storeA, { serialNo: `SN-${T}-2` })).body.code).toBe('INVENTORY_TRACKING');   // one unit per line
    expect((await receive(ids.board, 1, 250000, ids.storeA)).body.code).toBe('INVENTORY_TRACKING');                            // needs its number
    const wrongPlace = await post(keeper.auth, 'transfers', { company: 'AE', lines: [{ itemPublicId: ids.board, fromLocationPublicId: ids.storeB,
      toLocationPublicId: ids.storeA, quantity: 1, serialNo: sn }], transitLocationPublicId: (await post(keeper.auth, 'locations', { company: 'AE', type: 'transit',
      code: `TR${T}`, name: 'In transit', custodianPersonPublicId: keeper.personId }).expect(201)).body.publicId });
    expect([wrongPlace.status, wrongPlace.body.code]).toEqual([409, 'INVENTORY_SERIAL_NOT_HERE']);

    const out = await post(keeper.auth, 'issues', { company: 'AE', ticketPublicId: ids.ticket1, lines: [{ itemPublicId: ids.board, locationPublicId: ids.storeA, quantity: 1, serialNo: sn }] });
    expect([out.status, out.body.lines[0].serialNo]).toEqual([201, sn]);
    const again = await post(keeper.auth, 'issues', { company: 'AE', ticketPublicId: ids.ticket1, lines: [{ itemPublicId: ids.board, locationPublicId: ids.storeA, quantity: 1, serialNo: sn }] });
    expect(again.body.code).toBe('INVENTORY_SERIAL_NOT_HERE');
    await post(keeper.auth, `documents/${out.body.publicId}/reverse`, { reason: 'Wrong board' }).expect(201);
    const where = await db.query(`SELECT l.public_id FROM inventory.stock_serials s JOIN inventory.locations l ON l.id = s.location_id WHERE s.serial_no = $1`, [sn]);
    expect(where.rows[0].public_id).toBe(ids.storeA);
  });

  it('batches: the earliest expiry is suggested and taken first, and reserved first', async () => {
    for (const [batchNo, quantity, expiryDate] of [[`LATE-${T}`, 5, addDays(todayIst(), 90)], [`EARLY-${T}`, 3, addDays(todayIst(), 10)], [`NONE-${T}`, 4, undefined]] as const) {
      await receive(ids.resin, quantity, 400, ids.storeA, { batchNo, ...(expiryDate ? { expiryDate } : {}) }).expect(201);
    }
    expect((await receive(ids.resin, 1, 400, ids.storeA)).body.code).toBe('INVENTORY_TRACKING');
    const suggested = (await get(keeper.auth, `stock/batches?item=${ids.resin}&location=${ids.storeA}`).expect(200)).body as any[];
    expect(suggested.map((b) => b.batchNo)).toEqual([`EARLY-${T}`, `LATE-${T}`, `NONE-${T}`]);

    const out = await post(keeper.auth, 'issues', { company: 'AE', ticketPublicId: ids.ticket1, lines: [{ itemPublicId: ids.resin, locationPublicId: ids.storeA, quantity: 5 }] });
    expect(out.body.lines.map((l: any) => [l.batchNo, l.quantity])).toEqual([[`EARLY-${T}`, 3], [`LATE-${T}`, 2]]);
    const r = (await ask(requester.auth, ids.ticket1, [{ item: ids.resin, quantity: 4 }]).expect(201)).body;
    const approved = (await post(keeper.auth, `requests/${r.publicId}/approve`, {}).expect(200)).body;
    expect(approved.lines[0].reservations.map((x: any) => [x.batchNo, x.quantity])).toEqual([[`LATE-${T}`, 3], [`NONE-${T}`, 1]]);
  });

  it('a cross-company requester requests only for the granted ticket, sees no values and approves nothing', async () => {
    const until = addDays(todayIst(), 5);
    const sameCompany = await post(keeper.auth, 'grants', { company: 'AE', personPublicId: other.personId, ticketPublicId: ids.ticket3, validUntil: until });
    expect(sameCompany.body.code).toBe('INVENTORY_GRANT_SAME_COMPANY');
    const grant = await post(keeper.auth, 'grants', { company: 'AE', personPublicId: grantee.personId, ticketPublicId: ids.ticket3, validUntil: until });
    expect(grant.status).toBe(201);
    expect(grant.body).toMatchObject({ company: 'AE', person: { publicId: grantee.personId }, ticket: { publicId: ids.ticket3 }, validUntil: until, active: true });
    expect((await post(keeper.auth, 'grants', { company: 'AE', personPublicId: grantee.personId, ticketPublicId: ids.ticket3, validUntil: until })).body.code).toBe('INVENTORY_GRANT_EXISTS');
    expect((await get(grantee.auth, 'grants/mine')).body).toEqual([expect.objectContaining({ ticket: expect.objectContaining({ publicId: ids.ticket3 }), active: true })]);

    expect((await get(grantee.auth, `requests/items?ticket=${ids.ticket3}`)).status).toBe(200);
    const asked = await ask(grantee.auth, ids.ticket3, [{ item: ids.part, quantity: 1 }]);
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ crossCompany: true, estimatedValueMinor: null, lines: [{ estimatedValueMinor: null }], canApprove: false });
    expect((await ask(grantee.auth, ids.ticket1, [{ item: ids.part, quantity: 1 }])).body.code).toBe('INVENTORY_CANNOT_REQUEST');
    expect((await post(grantee.auth, `requests/${asked.body.publicId}/approve`, {})).status).toBe(403);
    const parts = (await get(grantee.auth, `tickets/${ids.ticket3}/parts`).expect(200)).body;
    expect(parts).toMatchObject({ canRequest: true, showsValues: false, requests: [expect.objectContaining({ estimatedValueMinor: null })] });
    expect((await get(grantee.auth, 'items?company=AE')).status).toBe(403);
    expect((await get(grantee.auth, 'stock?company=AE')).status).toBe(403);
    expect((await get(head.auth, `tickets/${ids.ticket3}/parts`)).body.showsValues).toBe(true);   // the ticket's department head sees values

    await post(keeper.auth, `grants/${grant.body.publicId}/end`, {}).expect(200);
    expect((await ask(grantee.auth, ids.ticket3, [{ item: ids.part, quantity: 1 }])).body.code).toBe('INVENTORY_CANNOT_REQUEST');
    const audit = await db.query(`SELECT action FROM core.audit_log WHERE entity_public_id = $1 ORDER BY id`, [grant.body.publicId]);
    expect(audit.rows.map((x) => x.action)).toEqual(['inventory.grant.created', 'inventory.grant.ended']);
  });

  it('every balance holds exactly what its open reservations reserve (what the nightly rebuild checks)', async () => {
    // read-only: the rebuild itself runs in the stock tests, which may run at the same time
    const off = await db.query(`
      SELECT b.id FROM inventory.stock_balances b
        JOIN inventory.items i ON i.id = b.item_id AND i.code LIKE $1
       WHERE b.reserved <> coalesce((SELECT sum(r.quantity) FROM inventory.stock_reservations r WHERE r.released_at IS NULL AND r.item_id = b.item_id
         AND r.location_id = b.location_id AND coalesce(r.batch_id, 0) = coalesce(b.batch_id, 0)), 0)`, [`R${T}-%`]);
    expect(off.rows).toEqual([]);
    const reserved = await db.query(`SELECT sum(b.reserved)::float AS q FROM inventory.stock_balances b JOIN inventory.items i ON i.id = b.item_id WHERE i.code LIKE $1`, [`R${T}-%`]);
    expect(reserved.rows[0].q).toBeGreaterThan(0);   // the motor and resin requests still hold stock
  });
});
