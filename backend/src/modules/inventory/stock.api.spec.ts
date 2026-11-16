import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { png } from '../../test/images';
import { tag } from '../../test/people';
import { newStaff, Staff } from '../../test/staff';
import { StockRebuildService } from './application/stock-rebuild.service';

type Auth = Record<string, string>;
// Fictional data only. Codes carry a random part so this file never collides with the seed or another run.
const T = tag().slice(0, 4);

describe('Inventory stock: documents, balances, moving average', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth;
  let keeper: Staff;      // ATPL store in-charge (team): posts anywhere in ATPL
  let ownKeeper: Staff;   // ATPL storekeeper (own): looks after the lab store only
  let aeKeeper: Staff;    // AE store in-charge (team)
  let ticketMaker: Staff; // ATPL Manager + Admin user: creates tickets
  const atpl: Record<string, string> = {};
  const ae: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const post = (auth: Auth, path: string, body: object) => http().post(`/api/inventory/${path}`).set(auth).send(body);
  const get = (auth: Auth, path: string) => http().get(`/api/inventory/${path}`).set(auth);
  const role = (s: Staff, roleCode: string, scope: string) =>
    http().post('/api/core/role-assignments').set(admin).send({ personPublicId: s.personId, roleCode, scope }).expect(201);
  let n = 0;
  const item = async (extra: object = {}, company = 'ATPL') => {
    const ids = company === 'ATPL' ? atpl : ae;
    const auth = company === 'ATPL' ? keeper.auth : aeKeeper.auth;
    return (await post(auth, 'items', { company, name: `Part ${T} ${++n}`, categoryPublicId: ids.category, baseUnitPublicId: ids.pcs, ...extra }).expect(201)).body.publicId as string;
  };
  const receive = (itemId: string, quantity: number, unitCostMinor: number, location = atpl.main, auth = keeper.auth, extra: object = {}) =>
    post(auth, 'receipts', { company: 'ATPL', supplierName: 'Fictional Supplies', reason: 'Direct purchase for stock', lines: [{ itemPublicId: itemId, locationPublicId: location, quantity, unitCostMinor }], ...extra });
  const issue = (itemId: string, quantity: number, location = atpl.main, auth = keeper.auth) =>
    post(auth, 'issues', { company: 'ATPL', ticketPublicId: atpl.ticket, lines: [{ itemPublicId: itemId, locationPublicId: location, quantity }] });
  const stockOf = async (itemId: string) => (await get(keeper.auth, `stock?item=${itemId}&includeEmpty=true`).expect(200)).body.items as any[];
  const at = (rows: any[], location: string) => rows.find((r) => r.location.publicId === location);
  const ticket = async (auth: Auth, company: string) => {
    const types = (await http().get(`/api/tickets/types?company=${company}`).set(auth).expect(200)).body as any[];
    // ATPL: a seeded department (another test counts ATPL's departments); AE has none seeded, so one is added
    const letters = Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
    const dept = company === 'ATPL'
      ? ((await http().get('/api/hrms/departments?company=ATPL').set(hr).expect(200)).body as any[]).find((d) => d.codePrefix === 'ATH')
      : (await http().post('/api/hrms/departments').set(hr).send({ company, name: `Stores ${T} ${letters}`, codePrefix: letters }).expect(201)).body;
    return (await http().post('/api/tickets').set(auth).send({ company, typePublicId: types.find((t) => t.code === 'production').publicId,
      title: `Panel build ${T}`, departmentPublicId: dept.publicId, scheduledAt: new Date().toISOString(), details: { item: 'Control panel' } }).expect(201)).body.publicId as string;
  };

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin] = await Promise.all([DEMO.hr, DEMO.admin].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    [keeper, ownKeeper, aeKeeper, ticketMaker] = await Promise.all([newStaff(app, hr, admin, ['ATPL']), newStaff(app, hr, admin, ['ATPL']),
      newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['ATPL', 'AE'])]);
    await role(keeper, 'store_incharge', 'team');
    await role(ownKeeper, 'storekeeper', 'own');
    await role(aeKeeper, 'store_incharge', 'team');
    await role(ticketMaker, 'manager', 'team');
    await role(ticketMaker, 'admin_user', 'all');

    for (const [ids, auth, company] of [[atpl, keeper.auth, 'ATPL'], [ae, aeKeeper.auth, 'AE']] as const) {
      ids.pcs = (await post(auth, 'units', { company, code: `pc${T}`, name: 'Pieces', decimals: 0 }).expect(201)).body.publicId;
      ids.category = (await post(auth, 'categories', { company, name: `Stock ${T}`, codePrefix: `S${T}` }).expect(201)).body.publicId;
    }
    atpl.box = (await post(keeper.auth, 'units', { company: 'ATPL', code: `bx${T}`, name: 'Box', decimals: 0 }).expect(201)).body.publicId;
    const loc = async (auth: Auth, company: string, type: string, code: string, custodian: string) =>
      (await post(auth, 'locations', { company, type, code: `${code}${T}`, name: `${type} ${T}`, custodianPersonPublicId: custodian }).expect(201)).body.publicId as string;
    atpl.main = await loc(keeper.auth, 'ATPL', 'store', 'MS', keeper.personId);
    atpl.lab = await loc(keeper.auth, 'ATPL', 'store', 'LS', ownKeeper.personId);
    atpl.transit = await loc(keeper.auth, 'ATPL', 'transit', 'TR', keeper.personId);
    atpl.quarantine = await loc(keeper.auth, 'ATPL', 'quarantine', 'QU', keeper.personId);
    atpl.scrap = await loc(keeper.auth, 'ATPL', 'scrap', 'SC', keeper.personId);
    ae.main = await loc(aeKeeper.auth, 'AE', 'store', 'MS', aeKeeper.personId);
    atpl.ticket = await ticket(ticketMaker.auth, 'ATPL');
    ae.ticket = await ticket(ticketMaker.auth, 'AE');
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('receipts raise stock at their cost; the moving average is recalculated on each receipt (purchase units converted)', async () => {
    const relay = await item({ conversions: [{ unitPublicId: atpl.box, factor: 10 }] });
    const publicId = randomUUID();
    const first = await receive(relay, 10, 1000, atpl.main, keeper.auth, { publicId, challanNo: 'DC-1' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ publicId, company: 'ATPL', type: 'receipt', status: 'posted', number: expect.stringMatching(/^GRN-\d{5}$/),
      supplierName: 'Fictional Supplies', totalValueMinor: 10000, lines: [{ lineNo: 1, quantity: 10, unitCostMinor: 1000, valueMinor: 10000, enteredUnit: null }] });
    expect((await receive(relay, 10, 1000, atpl.main, keeper.auth, { publicId })).status).toBe(200);   // sent twice: stored once
    expect(at(await stockOf(relay), atpl.main)).toMatchObject({ onHand: 10, reserved: 0, available: 10, avgCostMinor: 1000, valueMinor: 10000 });

    const boxes = await post(keeper.auth, 'receipts', { company: 'ATPL', supplierName: 'Fictional Supplies', reason: 'Direct purchase',
      lines: [{ itemPublicId: relay, locationPublicId: atpl.main, quantity: 2, unitPublicId: atpl.box, unitCostMinor: 15000 }] });
    expect(boxes.body.lines[0]).toMatchObject({ quantity: 20, enteredQuantity: 2, enteredUnit: { publicId: atpl.box }, valueMinor: 30000, unitCostMinor: 1500 });
    expect(at(await stockOf(relay), atpl.main)).toMatchObject({ onHand: 30, avgCostMinor: 1333.333333, valueMinor: 40000 });   // (10000 + 30000) / 30

    const event = await db.query(`SELECT event_type, payload FROM core.outbox WHERE aggregate_public_id = $1`, [publicId]);
    expect(event.rows).toEqual([{ event_type: 'stock.received', payload: expect.objectContaining({ company: 'ATPL', documentType: 'receipt', totalValueMinor: 10000,
      lines: [expect.objectContaining({ itemPublicId: relay, locationPublicId: atpl.main, quantity: 10, unitCostMinor: 1000, valueMinor: 10000 })] }) }]);
  });

  it('an issue records the average cost at that moment, and later receipts never change it', async () => {
    const part = await item();
    await receive(part, 10, 1000).expect(201);
    await receive(part, 20, 1500).expect(201);                      // 40000 / 30 = 1333.333333
    const issued = await issue(part, 3);
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ type: 'issue', number: expect.stringMatching(/^ISS-/), ticket: { publicId: atpl.ticket },
      lines: [{ quantity: 3, unitCostMinor: 1333.333333, valueMinor: 4000 }] });
    await receive(part, 10, 5000).expect(201);
    const again = await get(keeper.auth, `documents/${issued.body.publicId}`).expect(200);
    expect(again.body.lines[0]).toMatchObject({ unitCostMinor: 1333.333333, valueMinor: 4000 });
    expect(at(await stockOf(part), atpl.main)).toMatchObject({ onHand: 37, avgCostMinor: 2324.324324 });   // (36000 + 50000) / 37

    const event = await db.query(`SELECT payload FROM core.outbox WHERE aggregate_public_id = $1 AND event_type = 'stock.issued'`, [issued.body.publicId]);
    expect(event.rows[0].payload).toMatchObject({ ticketPublicId: atpl.ticket, projectId: null, lines: [{ quantity: -3, unitCostMinor: 1333.333333, valueMinor: -4000 }] });
  });

  it('negative stock is refused; of two simultaneous issues of the last unit exactly one succeeds', async () => {
    const part = await item();
    await receive(part, 1, 700).expect(201);
    const tooMany = await issue(part, 2);
    expect([tooMany.status, tooMany.body.code]).toEqual([409, 'INVENTORY_NOT_ENOUGH_STOCK']);
    expect(tooMany.body.message).toContain('1 on hand, 2 needed');
    const both = await Promise.all([issue(part, 1), issue(part, 1)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(at(await stockOf(part), atpl.main)).toMatchObject({ onHand: 0, valueMinor: 0 });
  });

  it('a reversal restores quantity and value; a reversal is final; stock that has moved on blocks it', async () => {
    const part = await item();
    const a = (await receive(part, 10, 100).expect(201)).body;
    const b = (await receive(part, 10, 300).expect(201)).body;           // 20 at 200 = 4000
    const out = (await issue(part, 5).expect(201)).body;                 // takes 1000
    expect(at(await stockOf(part), atpl.main)).toMatchObject({ onHand: 15, valueMinor: 3000, avgCostMinor: 200 });

    const rev = await post(keeper.auth, `documents/${out.publicId}/reverse`, { reason: 'Issued to the wrong ticket' });
    expect(rev.status).toBe(201);
    expect(rev.body).toMatchObject({ type: 'reversal', number: expect.stringMatching(/^REV-/), original: { publicId: out.publicId, type: 'issue' }, reason: 'Issued to the wrong ticket' });
    expect(at(await stockOf(part), atpl.main)).toMatchObject({ onHand: 20, valueMinor: 4000, avgCostMinor: 200 });
    expect((await get(keeper.auth, `documents/${out.publicId}`)).body).toMatchObject({ status: 'reversed', reversal: { publicId: rev.body.publicId } });
    expect((await post(keeper.auth, `documents/${out.publicId}/reverse`, { reason: 'Again' })).body.code).toBe('INVENTORY_ALREADY_REVERSED');
    expect((await post(keeper.auth, `documents/${rev.body.publicId}/reverse`, { reason: 'Undo the undo' })).body.code).toBe('INVENTORY_CANNOT_REVERSE_REVERSAL');

    await post(keeper.auth, `documents/${b.publicId}/reverse`, { reason: 'Wrong price' }).expect(201);
    expect(at(await stockOf(part), atpl.main)).toMatchObject({ onHand: 10, valueMinor: 1000, avgCostMinor: 100 });
    await issue(part, 10).expect(201);
    const blocked = await post(keeper.auth, `documents/${a.publicId}/reverse`, { reason: 'Too late' });
    expect([blocked.status, blocked.body.code]).toEqual([409, 'INVENTORY_NOT_ENOUGH_STOCK']);
    const event = await db.query(`SELECT payload FROM core.outbox WHERE aggregate_public_id = $1`, [rev.body.publicId]);
    expect(event.rows[0].payload).toMatchObject({ reason: 'reversal', reversalOf: out.publicId, lines: [{ quantity: 5, valueMinor: 1000 }] });
  });

  it('returns come back at issue cost to a location that fits their condition, never more than was issued', async () => {
    const part = await item();
    await receive(part, 10, 500).expect(201);
    const out = (await issue(part, 4).expect(201)).body;
    const ret = (body: object) => post(keeper.auth, 'returns', { issuePublicId: out.publicId, ...body });
    const usable = await ret({ lines: [{ lineNo: 1, quantity: 1, condition: 'usable' }] });
    expect(usable.status).toBe(201);
    expect(usable.body).toMatchObject({ type: 'return', original: { publicId: out.publicId }, lines: [{ returnOfLineNo: 1, condition: 'usable', location: { publicId: atpl.main },
      unitCostMinor: 500, valueMinor: 500 }] });
    const wrongPlace = await ret({ lines: [{ lineNo: 1, quantity: 1, condition: 'repair', locationPublicId: atpl.main }] });
    expect([wrongPlace.status, wrongPlace.body.code]).toEqual([400, 'INVENTORY_LOCATION_USE']);
    await ret({ lines: [{ lineNo: 1, quantity: 1, condition: 'repair', locationPublicId: atpl.quarantine }] }).expect(201);
    const tooMuch = await ret({ lines: [{ lineNo: 1, quantity: 3, condition: 'usable' }] });
    expect([tooMuch.status, tooMuch.body.code]).toEqual([409, 'INVENTORY_RETURN_TOO_MUCH']);
    const last = await ret({ lines: [{ lineNo: 1, quantity: 2, condition: 'scrap', locationPublicId: atpl.scrap }] });
    expect(last.body.lines[0].valueMinor).toBe(1000);                    // the rest of the issued value, exactly
    const rows = await stockOf(part);
    expect([at(rows, atpl.main).onHand, at(rows, atpl.quarantine).onHand, at(rows, atpl.scrap).onHand]).toEqual([7, 1, 2]);
    expect(at(rows, atpl.main).avgCostMinor).toBe(500);
    const blocked = await post(keeper.auth, `documents/${out.publicId}/reverse`, { reason: 'Wrong ticket' });
    expect([blocked.status, blocked.body.code]).toEqual([409, 'INVENTORY_REVERSE_RETURNS_FIRST']);
  });

  it('a transfer waits in transit until the receiving custodian receives it; a transfer in transit can be reversed', async () => {
    const part = await item();
    await receive(part, 5, 200).expect(201);
    const sent = await post(keeper.auth, 'transfers', { company: 'ATPL', transitLocationPublicId: atpl.transit,
      lines: [{ itemPublicId: part, fromLocationPublicId: atpl.main, toLocationPublicId: atpl.lab, quantity: 2 }] });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ type: 'transfer', status: 'in_transit', transitLocation: { publicId: atpl.transit },
      lines: [{ location: { publicId: atpl.main }, toLocation: { publicId: atpl.lab }, quantity: 2, valueMinor: 400 }] });
    let rows = await stockOf(part);
    expect([at(rows, atpl.main).onHand, at(rows, atpl.transit).onHand]).toEqual([3, 2]);
    expect(at(rows, atpl.lab)).toBeUndefined();

    const got = await http().post(`/api/inventory/transfers/${sent.body.publicId}/receive`).set(ownKeeper.auth);   // the lab's custodian
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ status: 'posted', receivedBy: { publicId: ownKeeper.personId } });
    rows = await stockOf(part);
    expect([at(rows, atpl.main).onHand, at(rows, atpl.transit).onHand, at(rows, atpl.lab).onHand]).toEqual([3, 0, 2]);
    expect(at(rows, atpl.lab)).toMatchObject({ avgCostMinor: 200, valueMinor: 400 });
    expect((await http().post(`/api/inventory/transfers/${sent.body.publicId}/receive`).set(keeper.auth)).body.code).toBe('INVENTORY_NOT_IN_TRANSIT');

    const second = (await post(keeper.auth, 'transfers', { company: 'ATPL', transitLocationPublicId: atpl.transit,
      lines: [{ itemPublicId: part, fromLocationPublicId: atpl.main, toLocationPublicId: atpl.lab, quantity: 1 }] }).expect(201)).body;
    await post(keeper.auth, `documents/${second.publicId}/reverse`, { reason: 'Not needed after all' }).expect(201);
    rows = await stockOf(part);
    expect([at(rows, atpl.main).onHand, at(rows, atpl.transit).onHand]).toEqual([3, 0]);
  });

  it('scope own: a storekeeper posts and sees only the locations they look after', async () => {
    const part = await item();
    const notMine = await receive(part, 1, 100, atpl.main, ownKeeper.auth);
    expect([notMine.status, notMine.body.code]).toEqual([403, 'INVENTORY_NOT_YOUR_LOCATION']);
    const mine = await receive(part, 4, 100, atpl.lab, ownKeeper.auth);
    expect(mine.status).toBe(201);
    const mainDoc = (await receive(part, 1, 100).expect(201)).body;
    expect((await get(ownKeeper.auth, `documents/${mainDoc.publicId}`)).status).toBe(404);
    expect((await get(ownKeeper.auth, `documents/${mine.body.publicId}`)).status).toBe(200);
    const docs = (await get(ownKeeper.auth, 'documents?company=ATPL&pageSize=100')).body.items as any[];
    expect(docs.map((d) => d.publicId)).toContain(mine.body.publicId);
    expect(docs.map((d) => d.publicId)).not.toContain(mainDoc.publicId);
    const rows = (await get(ownKeeper.auth, 'stock?company=ATPL&pageSize=100')).body.items as any[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.location.publicId === atpl.lab)).toBe(true);
    const out = await post(ownKeeper.auth, 'transfers', { company: 'ATPL', transitLocationPublicId: atpl.transit,
      lines: [{ itemPublicId: part, fromLocationPublicId: atpl.main, toLocationPublicId: atpl.lab, quantity: 1 }] });
    expect(out.body.code).toBe('INVENTORY_NOT_YOUR_LOCATION');
  });

  it('an ATPL document cannot use an AE item, location or ticket: the API and the database refuse it', async () => {
    const atplPart = await item();
    const aePart = await item({}, 'AE');
    expect((await receive(aePart, 1, 100)).body.code).toBe('INVENTORY_UNKNOWN_ITEM');
    expect((await receive(atplPart, 1, 100, ae.main)).body.code).toBe('INVENTORY_UNKNOWN_LOCATION');
    await receive(atplPart, 5, 100).expect(201);
    const toAeTicket = await post(keeper.auth, 'issues', { company: 'ATPL', ticketPublicId: ae.ticket, lines: [{ itemPublicId: atplPart, locationPublicId: atpl.main, quantity: 1 }] });
    expect(toAeTicket.body.code).toBe('INVENTORY_UNKNOWN_TICKET');
    const doc = (await issue(atplPart, 1).expect(201)).body;
    expect((await get(aeKeeper.auth, `documents/${doc.publicId}`)).status).toBe(404);
    expect((await get(aeKeeper.auth, 'documents?company=ATPL')).body.code).toBe('INVENTORY_NOT_YOUR_COMPANY');

    const one = async (q: string, p: unknown[]) => (await db.query(q, p)).rows[0];
    const d = await one(`SELECT d.id, d.legal_entity_id, l.id AS line_id FROM inventory.stock_documents d JOIN inventory.stock_document_lines l ON l.document_id = d.id WHERE d.public_id = $1`, [doc.publicId]);
    const aeItemId = (await one('SELECT id FROM inventory.items WHERE public_id = $1', [aePart])).id;
    const aeLocationId = (await one('SELECT id FROM inventory.locations WHERE public_id = $1', [ae.main])).id;
    const atplItemId = (await one('SELECT id FROM inventory.items WHERE public_id = $1', [atplPart])).id;
    const atplLocationId = (await one('SELECT id FROM inventory.locations WHERE public_id = $1', [atpl.main])).id;
    const aeTicketId = (await one('SELECT id FROM tickets.tickets WHERE public_id = $1', [ae.ticket])).id;
    await expect(db.query(`INSERT INTO inventory.stock_moves (tenant_id, legal_entity_id, item_id, location_id, qty_delta, unit_cost_minor, value_delta_minor, document_id, document_line_id)
      VALUES (1, $1, $2, $3, -1, 0, 0, $4, $5)`, [d.legal_entity_id, aeItemId, atplLocationId, d.id, d.line_id])).rejects.toMatchObject({ constraint: 'stock_moves_item_company_fk' });
    await expect(db.query(`INSERT INTO inventory.stock_document_lines (tenant_id, legal_entity_id, document_id, line_no, item_id, location_id, quantity, unit_cost_minor, value_minor)
      VALUES (1, $1, $2, 99, $3, $4, 1, 0, 0)`, [d.legal_entity_id, d.id, atplItemId, aeLocationId])).rejects.toMatchObject({ constraint: 'stock_document_lines_location_company_fk' });
    await expect(db.query('UPDATE inventory.stock_documents SET ticket_id = $1 WHERE id = $2', [aeTicketId, d.id])).rejects.toMatchObject({ constraint: 'stock_documents_ticket_company_fk' });
  });

  it('stock moves and document lines can never be edited or deleted; documents are never deleted', async () => {
    const part = await item();
    const doc = (await receive(part, 2, 100).expect(201)).body;
    const id = (await db.query('SELECT id FROM inventory.stock_documents WHERE public_id = $1', [doc.publicId])).rows[0].id;
    await expect(db.query('UPDATE inventory.stock_moves SET qty_delta = 99 WHERE document_id = $1', [id])).rejects.toThrow('never changed or deleted');
    await expect(db.query('DELETE FROM inventory.stock_moves WHERE document_id = $1', [id])).rejects.toThrow('never changed or deleted');
    await expect(db.query('UPDATE inventory.stock_document_lines SET value_minor = 1 WHERE document_id = $1', [id])).rejects.toThrow('never changed or deleted');
    await expect(db.query('DELETE FROM inventory.stock_documents WHERE id = $1', [id])).rejects.toThrow('never deleted');
    await expect(db.query(`DELETE FROM core.outbox WHERE aggregate_public_id = $1`, [doc.publicId])).rejects.toThrow('never deleted');
  });

  it('the nightly rebuild finds stored balances equal to the moves, and fixes and reports a balance that was tampered with', async () => {
    const rebuild = app.get(StockRebuildService);
    expect(await rebuild.rebuild()).toEqual({ balances: [], valuations: [] });
    const part = await item();
    await receive(part, 6, 100).expect(201);
    await db.query(`UPDATE inventory.stock_balances b SET on_hand = 9 FROM inventory.items i WHERE i.id = b.item_id AND i.public_id = $1`, [part]);
    const found = await rebuild.rebuild();
    expect(found.balances).toEqual([expect.objectContaining({ expectedQty: '6.0000', storedQty: '9.0000' })]);
    expect(found.valuations).toEqual([]);
    expect(at(await stockOf(part), atpl.main).onHand).toBe(6);
    const alert = await db.query(`SELECT summary FROM core.audit_log WHERE action = 'inventory.stock.rebuilt' ORDER BY id DESC LIMIT 1`);
    expect(alert.rows[0].summary).toContain('1 stored balance differed');
    expect(await rebuild.rebuild()).toEqual({ balances: [], valuations: [] });
  });

  it('once stock exists: no base unit, tracking or stocked change; no inactive location with stock; and other refusals', async () => {
    const part = await item();
    await receive(part, 2, 100).expect(201);
    const meters = (await post(keeper.auth, 'units', { company: 'ATPL', code: `mm${T}`, name: 'Millimetres', decimals: 0 }).expect(201)).body.publicId;
    for (const change of [{ baseUnitPublicId: meters }, { tracking: 'batch' }, { isStocked: false }]) {
      expect((await http().patch(`/api/inventory/items/${part}`).set(keeper.auth).send(change)).body.code).toBe('INVENTORY_ITEM_HAS_STOCK_MOVES');
    }
    expect((await http().patch(`/api/inventory/locations/${atpl.main}`).set(keeper.auth).send({ status: 'inactive' })).body.code).toBe('INVENTORY_LOCATION_HAS_STOCK');
    const notStocked = await item({ isStocked: false });
    expect((await receive(notStocked, 1, 100)).body.code).toBe('INVENTORY_ITEM_NOT_STOCKABLE');
    const serial = await item({ tracking: 'serial' });
    expect((await receive(serial, 1, 100)).body.code).toBe('INVENTORY_ITEM_NOT_STOCKABLE');
    expect((await receive(part, 1, 100, atpl.main, keeper.auth, { documentDate: '2099-01-01' })).body.code).toBe('INVENTORY_DATE_IN_FUTURE');
    expect((await receive(part, 1, 100, atpl.transit)).body.code).toBe('INVENTORY_LOCATION_USE');
    expect((await receive(part, 1.5, 100)).body.code).toBe('INVENTORY_QUANTITY_DECIMALS');
  });

  it('a receipt takes its delivery challan once, and it can be downloaded', async () => {
    const part = await item();
    const doc = (await receive(part, 1, 100).expect(201)).body;
    const file = png(2, 2);
    const attached = await http().post(`/api/inventory/documents/${doc.publicId}/challan`).set(keeper.auth).attach('file', file, 'challan.png');
    expect([attached.status, attached.body.hasChallan]).toEqual([200, true]);
    const again = await http().post(`/api/inventory/documents/${doc.publicId}/challan`).set(keeper.auth).attach('file', file, 'challan.png');
    expect(again.body.code).toBe('INVENTORY_CHALLAN_EXISTS');
    const down = await http().get(`/api/inventory/documents/${doc.publicId}/challan`).set(keeper.auth).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect([down.status, down.headers['content-type'], Buffer.compare(down.body, file)]).toEqual([200, 'image/png', 0]);
    const out = (await issue(part, 1).expect(201)).body;
    expect((await http().post(`/api/inventory/documents/${out.publicId}/challan`).set(keeper.auth).attach('file', file, 'c.png')).body.code).toBe('INVENTORY_NOT_A_RECEIPT');
  });
});
