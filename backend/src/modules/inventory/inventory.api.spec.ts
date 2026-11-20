import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { tag } from '../../test/people';
import { newStaff, Staff } from '../../test/staff';

type Auth = Record<string, string>;
// Fictional data only. Codes carry a random part so this file never collides with the seed or another run.
const T = tag().slice(0, 4);   // 4 hex characters, upper case

describe('Inventory API: items and locations', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth, ceo: Auth;
  let keeper: Staff;        // ATPL store in-charge (scope team: every ATPL location)
  let aeKeeper: Staff;      // AE store in-charge (scope team: every AE location)
  let dualKeeper: Staff;    // storekeeper with jobs in both companies (copies items across)
  let ownKeeper: Staff;     // ATPL storekeeper, scope own: only the locations they look after
  let staff: Staff;         // ATPL employee (a developer): no inventory at all
  let requester: Staff;     // ATPL parts requester: no store browsing
  let accountant: Staff;    // ATPL Accounts executive (scope team): reads
  const atpl: Record<string, string> = {};   // ATPL unit, category and location ids
  const ae: Record<string, string> = {};     // AE ones
  const P = `P${T}`;
  const http = () => request(app.getHttpServer());
  const post = (auth: Auth, path: string, body: object) => http().post(`/api/inventory/${path}`).set(auth).send(body);
  const patch = (auth: Auth, path: string, body: object) => http().patch(`/api/inventory/${path}`).set(auth).send(body);
  const get = (auth: Auth, path: string) => http().get(`/api/inventory/${path}`).set(auth);
  const atplItem = (body: object) => post(keeper.auth, 'items', { company: 'ATPL', categoryPublicId: atpl.category, baseUnitPublicId: atpl.pcs, ...body });
  const aeItem = (body: object) => post(aeKeeper.auth, 'items', { company: 'AE', categoryPublicId: ae.category, baseUnitPublicId: ae.pcs, ...body });
  const csv = (auth: Auth, what: 'items' | 'locations', company: string, text: string, dryRun?: boolean) => {
    const req = http().post(`/api/inventory/${what}/import`).set(auth).field('company', company);
    if (dryRun !== undefined) req.field('dryRun', String(dryRun));
    return req.attach('file', Buffer.from(text, 'utf8'), { filename: `${what}.csv`, contentType: 'text/csv' });
  };
  const employeeCode = async (s: Staff, company: string): Promise<string> =>
    (await http().get(`/api/hrms/people/${s.personId}`).set(hr)).body.employments.find((e: { company: { code: string } }) => e.company.code === company).employeeCode;
  const role = (s: Staff, roleCode: string, scope: 'own' | 'team' = 'own') =>
    http().post('/api/core/role-assignments').set(admin).send({ personPublicId: s.personId, roleCode, scope }).expect(201);

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    [keeper, aeKeeper, dualKeeper, ownKeeper, staff, requester, accountant] = await Promise.all([
      newStaff(app, hr, admin, ['ATPL']), newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['ATPL', 'AE']),
      newStaff(app, hr, admin, ['ATPL']), newStaff(app, hr, admin, ['ATPL']), newStaff(app, hr, admin, ['ATPL']), newStaff(app, hr, admin, ['ATPL'])]);
    for (const s of [keeper, aeKeeper]) await role(s, 'store_incharge', 'team');
    for (const s of [dualKeeper, ownKeeper]) await role(s, 'storekeeper');
    await role(requester, 'parts_requester');
    await role(accountant, 'accounts_executive', 'team');

    for (const [key, code, decimals] of [['pcs', `pc${T}`, 0], ['m', `m${T}`, 2], ['box', `bx${T}`, 0], ['ft', `ft${T}`, 0]] as const) {
      atpl[key] = (await post(keeper.auth, 'units', { company: 'ATPL', code, name: `Unit ${code}`, decimals }).expect(201)).body.publicId;
    }
    ae.pcs = (await post(aeKeeper.auth, 'units', { company: 'AE', code: `pc${T}`, name: 'Pieces', decimals: 0 }).expect(201)).body.publicId;
    atpl.category = (await post(keeper.auth, 'categories', { company: 'ATPL', name: `Sensors ${T}`, codePrefix: P }).expect(201)).body.publicId;
    ae.category = (await post(aeKeeper.auth, 'categories', { company: 'AE', name: `Sensors ${T}`, codePrefix: P }).expect(201)).body.publicId;
    atpl.store = (await post(keeper.auth, 'locations', { company: 'ATPL', type: 'store', code: `S${T}`, name: 'Main store', custodianPersonPublicId: keeper.personId })
      .expect(201)).body.publicId;
    atpl.rack = (await post(keeper.auth, 'locations', { company: 'ATPL', type: 'rack', code: `S${T}-A`, name: 'Rack A', parentPublicId: atpl.store }).expect(201)).body.publicId;
    ae.store = (await post(aeKeeper.auth, 'locations', { company: 'AE', type: 'store', code: `S${T}`, name: 'Workshop store', custodianPersonPublicId: aeKeeper.personId })
      .expect(201)).body.publicId;
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('duplicate codes are refused within a company but allowed across companies', async () => {
    const first = await atplItem({ name: `Proximity sensor ${T}` });
    expect([first.status, first.body.code, first.body.company]).toEqual([201, `${P}-0001`, 'ATPL']);
    const again = await atplItem({ name: `Other sensor ${T}`, code: `${P}-0001` });
    expect([again.status, again.body.code]).toEqual([409, 'INVENTORY_DUPLICATE_ITEM_CODE']);
    const aeSame = await aeItem({ name: `Proximity sensor ${T}`, code: `${P.toLowerCase()}-0001` });   // same code and name, other company
    expect([aeSame.status, aeSame.body.code, aeSame.body.company]).toEqual([201, `${P}-0001`, 'AE']);

    // the setup made store S… in both companies; a second one in ATPL is refused
    const loc = await post(keeper.auth, 'locations', { company: 'ATPL', type: 'scrap', code: `s${T}`, name: 'Scrap', custodianPersonPublicId: keeper.personId });
    expect([loc.status, loc.body.code]).toEqual([409, 'INVENTORY_DUPLICATE_LOCATION_CODE']);
    const unit = await post(keeper.auth, 'units', { company: 'ATPL', code: `pc${T}`, name: 'Again', decimals: 0 });
    expect([unit.status, unit.body.code]).toEqual([409, 'INVENTORY_DUPLICATE_UNIT_CODE']);

    // a create sent twice is stored once
    const publicId = randomUUID();
    expect((await atplItem({ publicId, name: `Resent ${T}` })).status).toBe(201);
    const resent = await atplItem({ publicId, name: `Resent ${T}` });
    expect([resent.status, resent.body.publicId]).toEqual([200, publicId]);
  });

  it('an ATPL record cannot use an AE item, unit, category, location or person: the API and the database refuse it', async () => {
    const item = (await atplItem({ name: `Separate ${T}` })).body.publicId;
    const cases: [object, string][] = [
      [{ defaultLocationPublicId: ae.store }, 'INVENTORY_UNKNOWN_LOCATION'],
      [{ baseUnitPublicId: ae.pcs }, 'INVENTORY_UNKNOWN_UNIT'],
      [{ categoryPublicId: ae.category }, 'INVENTORY_UNKNOWN_CATEGORY'],
      [{ conversions: [{ unitPublicId: ae.pcs, factor: 10 }] }, 'INVENTORY_UNKNOWN_UNIT'],
    ];
    for (const [body, code] of cases) {
      const res = await atplItem({ name: `Crossing ${T}`, ...body });
      expect([res.status, res.body.code]).toEqual([400, code]);
      expect((await patch(keeper.auth, `items/${item}`, body)).body.code).toBe(code);
    }
    const parent = await post(keeper.auth, 'locations', { company: 'ATPL', type: 'rack', code: `X${T}`, name: 'Rack X', parentPublicId: ae.store });
    expect([parent.status, parent.body.code]).toEqual([400, 'INVENTORY_UNKNOWN_PARENT']);
    const custodian = await post(keeper.auth, 'locations', { company: 'ATPL', type: 'store', code: `X${T}`, name: 'Store X', custodianPersonPublicId: aeKeeper.personId });
    expect([custodian.status, custodian.body.code]).toEqual([400, 'INVENTORY_BAD_CUSTODIAN']);

    // the company-safe keys refuse the same even when written straight into the database
    const id = async (table: string, publicId: string) => (await db.query(`SELECT id, legal_entity_id FROM inventory.${table} WHERE public_id = $1`, [publicId])).rows[0];
    const [atplItemRow, aeStore, aeUnit, atplRack] = await Promise.all([id('items', item), id('locations', ae.store), id('units', ae.pcs), id('locations', atpl.rack)]);
    await expect(db.query('UPDATE inventory.items SET default_location_id = $1 WHERE id = $2', [aeStore.id, atplItemRow.id]))
      .rejects.toMatchObject({ constraint: 'items_default_location_company_fk' });
    await expect(db.query('UPDATE inventory.items SET base_unit_id = $1 WHERE id = $2', [aeUnit.id, atplItemRow.id]))
      .rejects.toMatchObject({ constraint: 'items_base_unit_company_fk' });
    await expect(db.query(`INSERT INTO inventory.item_uom_conversions (tenant_id, legal_entity_id, item_id, unit_id, factor, created_by)
      SELECT 1, $1, $2, $3, 10, created_by FROM inventory.items WHERE id = $2`, [atplItemRow.legal_entity_id, atplItemRow.id, aeUnit.id]))
      .rejects.toMatchObject({ constraint: 'item_uom_conversions_unit_company_fk' });
    await expect(db.query(`INSERT INTO inventory.item_uom_conversions (tenant_id, legal_entity_id, item_id, unit_id, factor, created_by)
      SELECT 1, $1, $2, $3, 10, created_by FROM inventory.items WHERE id = $2`, [aeUnit.legal_entity_id, atplItemRow.id, aeUnit.id]))
      .rejects.toMatchObject({ constraint: 'item_uom_conversions_item_company_fk' });
    await expect(db.query('UPDATE inventory.locations SET parent_id = $1 WHERE id = $2', [aeStore.id, atplRack.id]))
      .rejects.toMatchObject({ constraint: 'locations_parent_company_fk' });

    // and AE staff never see ATPL's records
    expect((await get(aeKeeper.auth, `items/${item}`)).status).toBe(404);
    expect((await get(aeKeeper.auth, `locations/${atpl.store}`)).status).toBe(404);
    const list = await get(aeKeeper.auth, 'items?company=ATPL');
    expect([list.status, list.body.code]).toEqual([403, 'INVENTORY_NOT_YOUR_COMPANY']);
    expect((await get(aeKeeper.auth, 'items?pageSize=100')).body.items.every((i: { company: string }) => i.company === 'AE')).toBe(true);
  });

  it('unit conversions: purchase units in base units, converted correctly; changes keep the old factor as history', async () => {
    const relay = await atplItem({ name: `Relay ${T}`, hsnCode: '8536', reorderLevel: 20, reorderQty: 200, defaultLocationPublicId: atpl.rack,
      conversions: [{ unitPublicId: atpl.box, factor: 100 }] });
    expect(relay.status).toBe(201);
    expect(relay.body).toMatchObject({ tracking: 'none', isStocked: true, hsnCode: '8536', defaultLocation: { publicId: atpl.rack, type: 'rack' },
      conversions: [{ unit: { publicId: atpl.box }, factor: 100 }], status: 'active' });
    const wire = (await atplItem({ name: `Wire ${T}`, baseUnitPublicId: atpl.m, conversions: [{ unitPublicId: atpl.ft, factor: 0.3048 }] })).body;

    const convert = (item: string, unit: string, quantity: number) => get(keeper.auth, `items/${item}/convert?unit=${unit}&quantity=${quantity}`);
    expect((await convert(relay.body.publicId, atpl.box, 3)).body).toMatchObject({ quantity: 3, unit: { publicId: atpl.box }, factor: 100, baseQuantity: 300, baseUnit: { publicId: atpl.pcs } });
    expect((await convert(wire.publicId, atpl.ft, 7)).body).toMatchObject({ factor: 0.3048, baseQuantity: 2.13 });   // 2.1336 m in a 2-decimal unit
    expect((await convert(wire.publicId, atpl.m, 1.25)).body).toMatchObject({ factor: 1, baseQuantity: 1.25 });
    expect((await convert(relay.body.publicId, atpl.box, 2.5)).body.code).toBe('INVENTORY_QUANTITY_DECIMALS');
    expect((await convert(relay.body.publicId, atpl.ft, 1)).body.code).toBe('INVENTORY_NO_CONVERSION');

    const changed = await patch(keeper.auth, `items/${relay.body.publicId}`, { conversions: [{ unitPublicId: atpl.box, factor: 50 }] });
    expect(changed.body.conversions).toEqual([expect.objectContaining({ factor: 50 })]);
    expect((await convert(relay.body.publicId, atpl.box, 3)).body.baseQuantity).toBe(150);
    const history = await db.query(`SELECT c.factor::float AS factor, c.ended_at IS NOT NULL AS ended FROM inventory.item_uom_conversions c
      JOIN inventory.items i ON i.id = c.item_id WHERE i.public_id = $1 ORDER BY c.id`, [relay.body.publicId]);
    expect(history.rows).toEqual([{ factor: 100, ended: true }, { factor: 50, ended: false }]);

    const toBase = await patch(keeper.auth, `items/${relay.body.publicId}`, { conversions: [{ unitPublicId: atpl.pcs, factor: 1 }] });
    expect([toBase.status, toBase.body.code]).toEqual([400, 'INVENTORY_ITEM_INVALID']);
    const newBase = await patch(keeper.auth, `items/${relay.body.publicId}`, { baseUnitPublicId: atpl.m });
    expect([newBase.status, newBase.body.code]).toEqual([400, 'INVENTORY_CONVERSIONS_NEEDED']);
  });

  it('item rules, status and audit', async () => {
    const rules: [object, string][] = [
      [{ isStocked: false, reorderLevel: 5 }, 'reorderLevel'],
      [{ isStocked: false, tracking: 'batch' }, 'tracking'],
      [{ tracking: 'serial', baseUnitPublicId: atpl.m }, 'tracking'],
      [{ reorderLevel: 1.5 }, 'reorderLevel'],
    ];
    for (const [body, field] of rules) {
      const res = await atplItem({ name: `Rule ${T}`, ...body });
      expect([res.status, res.body.code, res.body.details[0].field]).toEqual([400, 'INVENTORY_ITEM_INVALID', field]);
    }
    expect((await atplItem({ name: `Bad HSN ${T}`, hsnCode: '123' })).body.code).toBe('VALIDATION');
    const scrap = (await post(keeper.auth, 'locations', { company: 'ATPL', type: 'scrap', code: `SC${T}`, name: 'Scrap', custodianPersonPublicId: keeper.personId })).body;
    expect((await atplItem({ name: `Scrapped ${T}`, defaultLocationPublicId: scrap.publicId })).body.details[0].field).toBe('defaultLocation');

    const ties = await atplItem({ name: `Cable ties ${T}`, isStocked: false });
    expect(ties.body).toMatchObject({ isStocked: false, tracking: 'none', reorderLevel: null, defaultLocation: null });
    const id = ties.body.publicId;
    const off = await patch(keeper.auth, `items/${id}`, { status: 'inactive' });
    expect([off.body.status, off.body.updatedBy.publicId]).toEqual(['inactive', keeper.personId]);
    expect((await patch(keeper.auth, `items/${id}`, { status: 'inactive' })).body.updatedAt).toBe(off.body.updatedAt);   // nothing changed
    const active = await get(keeper.auth, `items?company=ATPL&category=${atpl.category}&status=active&pageSize=100`);
    expect(active.body.items.map((i: { publicId: string }) => i.publicId)).not.toContain(id);
    const stocked = await get(keeper.auth, `items?company=ATPL&stocked=false&search=${encodeURIComponent(`ties ${T}`)}`);
    expect(stocked.body).toMatchObject({ total: 1, items: [{ publicId: id }] });
    const audit = await db.query(`SELECT action FROM core.audit_log WHERE entity_public_id = $1 ORDER BY id`, [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['inventory.item.created', 'inventory.item.deactivated']);
    const used = await patch(keeper.auth, `units/${atpl.m}`, { decimals: 3 });
    expect([used.status, used.body.code]).toEqual([409, 'INVENTORY_UNIT_IN_USE']);
  });

  it('copy from another company makes a new, separate item with the description only', async () => {
    const source = (await aeItem({ name: `Roller switch ${T}`, description: 'Roller lever, 10 A', hsnCode: '85365090', tracking: 'serial',
      reorderLevel: 4, defaultLocationPublicId: ae.store })).body;
    const copied = await post(dualKeeper.auth, 'items/copy', { sourceItemPublicId: source.publicId, company: 'ATPL', categoryPublicId: atpl.category });
    expect(copied.status).toBe(201);
    expect(copied.body).toMatchObject({ company: 'ATPL', name: source.name, description: 'Roller lever, 10 A', hsnCode: '85365090', tracking: 'serial',
      baseUnit: { publicId: atpl.pcs }, category: { publicId: atpl.category }, reorderLevel: null, defaultLocation: null, conversions: [] });
    expect(copied.body.publicId).not.toBe(source.publicId);
    expect(copied.body.code).toMatch(new RegExp(`^${P}-\\d{4}$`));   // ATPL's own numbering

    await patch(dualKeeper.auth, `items/${copied.body.publicId}`, { description: 'Changed in ATPL' });
    expect((await get(aeKeeper.auth, `items/${source.publicId}`)).body.description).toBe('Roller lever, 10 A');   // not linked
    const audit = await db.query(`SELECT details FROM core.audit_log WHERE entity_public_id = $1 AND action = 'inventory.item.copied'`, [copied.body.publicId]);
    expect(audit.rows[0].details.copiedFrom).toEqual({ company: 'AE', code: source.code });

    const same = await post(dualKeeper.auth, 'items/copy', { sourceItemPublicId: source.publicId, company: 'AE', categoryPublicId: ae.category });
    expect([same.status, same.body.code]).toEqual([400, 'INVENTORY_COPY_SAME_COMPANY']);
    expect((await post(keeper.auth, 'items/copy', { sourceItemPublicId: source.publicId, company: 'ATPL', categoryPublicId: atpl.category })).status).toBe(404);
  });

  it('roles: Accounts and the CEO read; developers and parts requesters do not browse the store', async () => {
    expect((await get(accountant.auth, 'items?company=ATPL')).status).toBe(200);
    expect((await get(accountant.auth, 'locations?company=ATPL')).body.map((l: { publicId: string }) => l.publicId)).toContain(atpl.rack);
    expect((await get(accountant.auth, 'items?company=AE')).body.code).toBe('INVENTORY_NOT_YOUR_COMPANY');
    expect((await post(accountant.auth, 'items', { company: 'ATPL', name: `Accounts ${T}`, categoryPublicId: atpl.category, baseUnitPublicId: atpl.pcs })).status).toBe(403);
    const units = await get(ceo, 'units');
    expect(new Set(units.body.map((u: { company: string }) => u.company))).toEqual(new Set(['AE', 'ATPL']));
    expect((await post(ceo, 'units', { company: 'AE', code: 'ceo', name: 'No', decimals: 0 })).status).toBe(403);

    // inventory is need-to-know: a developer (Employee role only) and a parts requester see none of the store
    for (const who of [staff, requester]) {
      for (const path of [`items?company=ATPL`, `items/${(await get(keeper.auth, `items?company=ATPL&pageSize=1`)).body.items[0].publicId}`, 'locations', 'units', 'categories']) {
        expect((await get(who.auth, path)).status).toBe(403);
      }
      expect((await post(who.auth, 'items', { company: 'ATPL', name: `Staff ${T}`, categoryPublicId: atpl.category, baseUnitPublicId: atpl.pcs })).status).toBe(403);
    }
    const me = await http().get('/api/auth/me').set(staff.auth);
    expect(Object.keys(me.body.permissions).filter((p) => p.startsWith('inventory.'))).toEqual([]);
  });

  it('a storekeeper with scope own sees and changes only the locations they look after, and adds none', async () => {
    const mine = (await post(keeper.auth, 'locations', { company: 'ATPL', type: 'store', code: `O${T}`, name: 'Lab store', custodianPersonPublicId: ownKeeper.personId })).body;
    const myBin = (await post(keeper.auth, 'locations', { company: 'ATPL', type: 'bin', code: `O${T}-B1`, name: 'Lab bin', parentPublicId: mine.publicId })).body;
    const visible = (await get(ownKeeper.auth, 'locations?company=ATPL')).body.map((l: { publicId: string }) => l.publicId);
    expect(visible.sort()).toEqual([mine.publicId, myBin.publicId].sort());   // their store and the bin inside; not the main store
    expect((await get(ownKeeper.auth, `locations/${atpl.store}`)).status).toBe(404);
    expect((await patch(ownKeeper.auth, `locations/${atpl.rack}`, { name: 'Taken' })).status).toBe(404);
    expect((await patch(ownKeeper.auth, `locations/${myBin.publicId}`, { name: 'Lab bin one' })).body.name).toBe('Lab bin one');

    const add = await post(ownKeeper.auth, 'locations', { company: 'ATPL', type: 'bin', code: `O${T}-B2`, name: 'Another bin', parentPublicId: mine.publicId });
    expect([add.status, add.body.code]).toEqual([403, 'INVENTORY_LOCATION_SCOPE']);
    expect((await csv(ownKeeper.auth, 'locations', 'ATPL', `code,name,type,parent\nO${T}-B3,Bin,bin,O${T}\n`)).body.code).toBe('INVENTORY_LOCATION_SCOPE');
    // the catalog stays company-wide: they still see and add items
    expect((await get(ownKeeper.auth, 'items?company=ATPL')).status).toBe(200);
    expect((await post(ownKeeper.auth, 'items', { company: 'ATPL', name: `Own keeper item ${T}`, categoryPublicId: atpl.category, baseUnitPublicId: atpl.pcs })).status).toBe(201);

    // handing the store to someone else takes the bin with it; the store in-charge (team) still sees everything
    await patch(keeper.auth, `locations/${mine.publicId}`, { custodianPersonPublicId: keeper.personId }).expect(200);
    expect((await get(ownKeeper.auth, 'locations?company=ATPL')).body).toEqual([]);
    expect((await get(keeper.auth, 'locations?company=ATPL')).body.map((l: { publicId: string }) => l.publicId)).toEqual(expect.arrayContaining([mine.publicId, myBin.publicId, atpl.store]));
  });

  it('items CSV: duplicates by code skipped; any other problem refuses the whole file; a dry run saves nothing', async () => {
    const C = `I${T}`;
    await post(keeper.auth, 'categories', { company: 'ATPL', name: `Imported ${T}`, codePrefix: C }).expect(201);
    const file = [
      'Code,Name,Category,Unit,Tracking,HSN Code,Is Stocked,Reorder Level,Reorder Qty,Default Location,Purchase Unit,Purchase Factor,Notes',
      `,Limit switch ${T},${C},pc${T},,8536,yes,"1,000",,S${T}-A,bx${T},100,ignored column`,
      `${C}-0100,"Cable tie, 200 mm ${T}",Imported ${T},PC${T},none,,no,,,,,,`,
      `${C}-0100,Repeated code ${T},${C},pc${T},,,,,,,,,`,
      `${P}-0001,Already there ${T},${C},pc${T},,,,,,,,,`,
      `,"Resin ${T}",${C},m${T},Batch,3907,,2.5,5,,,,`,
    ].join('\r\n');
    const dry = await csv(keeper.auth, 'items', 'ATPL', file, true);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ company: 'ATPL', dryRun: true, created: 3, skipped: 2 });
    expect(dry.body.rows).toEqual([
      { row: 2, code: `${C}-0101`, name: `Limit switch ${T}`, result: 'created', reason: null },
      { row: 3, code: `${C}-0100`, name: `Cable tie, 200 mm ${T}`, result: 'created', reason: null },
      { row: 4, code: `${C}-0100`, name: `Repeated code ${T}`, result: 'skipped', reason: 'Row 3 has the same code' },
      { row: 5, code: `${P}-0001`, name: `Already there ${T}`, result: 'skipped', reason: 'This code is already used by an item of the company' },
      { row: 6, code: `${C}-0102`, name: `Resin ${T}`, result: 'created', reason: null },
    ]);
    expect((await get(keeper.auth, `items?company=ATPL&category=`)).body.items.some((i: { code: string }) => i.code.startsWith(C))).toBe(false);

    const bad = await csv(keeper.auth, 'items', 'ATPL', `${file}\r\n,Broken ${T},${C},nope,,12,,,,,,,`);
    expect([bad.status, bad.body.code]).toEqual([400, 'INVENTORY_IMPORT_INVALID']);
    expect(bad.body.details).toEqual([{ row: 7, field: 'hsn_code', message: 'Use an HSN/SAC code of 4, 6 or 8 digits' }]);

    const done = await csv(keeper.auth, 'items', 'ATPL', file);
    expect(done.body).toMatchObject({ dryRun: false, created: 3, skipped: 2 });
    const switchItem = (await get(keeper.auth, `items?search=${encodeURIComponent(`Limit switch ${T}`)}&company=ATPL`)).body.items[0];
    expect(switchItem).toMatchObject({ code: `${C}-0101`, reorderLevel: 1000, hsnCode: '8536', defaultLocation: { publicId: atpl.rack },
      conversions: [{ unit: { publicId: atpl.box }, factor: 100 }] });
    expect((await csv(keeper.auth, 'items', 'ATPL', file)).body).toMatchObject({ created: 0, skipped: 5 });   // the same file again

    // the same codes in another company are fine
    await post(aeKeeper.auth, 'categories', { company: 'AE', name: `Imported ${T}`, codePrefix: C }).expect(201);
    const aeFile = `code,name,category,unit\n${C}-0100,"Cable tie, 200 mm ${T}",${C},pc${T}\n`;
    expect((await csv(aeKeeper.auth, 'items', 'AE', aeFile)).body).toMatchObject({ company: 'AE', created: 1, skipped: 0 });

    expect((await csv(keeper.auth, 'items', 'ATPL', 'name,unit\nX1,pcs\n')).body).toMatchObject({ code: 'INVENTORY_IMPORT_INVALID', details: [{ row: 1, field: 'category' }] });
    const binary = await http().post('/api/inventory/items/import').set(keeper.auth).field('company', 'ATPL')
      .attach('file', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe]), 'items.xlsx');
    expect([binary.status, binary.body.code]).toEqual([400, 'INVENTORY_IMPORT_NOT_CSV']);
    expect((await csv(aeKeeper.auth, 'items', 'ATPL', file)).status).toBe(403);
  });

  it('locations CSV: parents in the same file, custodians by employee code, duplicates by code skipped', async () => {
    const [mine, theirs] = await Promise.all([employeeCode(keeper, 'ATPL'), employeeCode(aeKeeper, 'AE')]);
    const file = [
      'code,name,type,parent,custodian',
      `L${T}-B1,Bin 1,bin,L${T}-R1,`,
      `L${T}-R1,Rack 1,rack,L${T},`,
      `L${T},Lab store,store,,${mine.toLowerCase()}`,
      `S${T},Main store again,store,,${mine}`,
      `T${T},In transit,Transit,,${mine}`,
    ].join('\n');
    const res = await csv(keeper.auth, 'locations', 'ATPL', file);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 4, skipped: 1 });
    expect(res.body.rows.find((r: { code: string }) => r.code === `S${T}`)).toMatchObject({ result: 'skipped', reason: 'This code is already used by a location of the company' });
    const list = await get(keeper.auth, 'locations?company=ATPL');
    const bin = list.body.find((l: { code: string }) => l.code === `L${T}-B1`);
    expect(bin).toMatchObject({ type: 'bin', parent: { code: `L${T}-R1`, type: 'rack' }, custodian: null, responsible: { person: { publicId: keeper.personId }, employeeCode: mine } });
    expect((await csv(keeper.auth, 'locations', 'ATPL', file)).body).toMatchObject({ created: 0, skipped: 5 });

    const bad = await csv(keeper.auth, 'locations', 'ATPL', `code,name,type,parent,custodian\nQ${T},Quarantine,quarantine,,${theirs}\nR${T},Loose rack,rack,,\n`);
    expect(bad.body.details).toEqual([
      { row: 2, field: 'custodian', message: `No job with the employee code ${theirs} in this company` },
      { row: 3, field: 'parent', message: 'A rack goes inside a store: give its parent' },
    ]);
  });

  it('inventory records are never deleted', async () => {
    await expect(db.query('DELETE FROM inventory.units WHERE public_id = $1', [atpl.pcs])).rejects.toThrow('never deleted');
    await expect(db.query('DELETE FROM inventory.item_uom_conversions')).rejects.toThrow('never deleted');
  });
});
