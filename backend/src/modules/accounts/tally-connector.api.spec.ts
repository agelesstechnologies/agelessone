import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { DB, Db } from '../../platform/db/db.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { AccountsFacade } from './accounts.facade';

type Auth = Record<string, string>;
const COMPANY = 'TCONN';   // used only by this file; dates are in 2037
const TALLY_NAME = 'Connector Test Co';
let ipCount = 0;
const freshIp = () => `203.0.113.${++ipCount}`;   // documentation range: every sign-in test gets its own address, so IP counts never mix

describe('Tally connector: machine credential, outbox, results and the name check', () => {
  let app: INestApplication;
  let hr: Auth, ceo: Auth, tech: Auth, admin: Auth;
  let db: pg.Client;
  let companyId: number;
  let clientId = '', secret = '', credentialId = '';
  let machine: Auth = {};
  const http = () => request(app.getHttpServer());
  const post = async (entryDate: string, sourceType: 'expense_approved' | 'expense_paid', debit: string, credit: string, amount: number) =>
    (await app.get<Db>(DB).transaction((tx) => app.get(AccountsFacade).postEntry(tx, { tenantId: 1, legalEntityId: companyId, sourceType, sourcePublicId: randomUUID(), entryDate, createdBy: null,
      lines: [{ ledgerKey: debit, debitMinor: amount, creditMinor: 0 }, { ledgerKey: credit, debitMinor: 0, creditMinor: amount }] }))).publicId;
  const tokenFor = (id: string, sec: string, ip = freshIp()) => http().post('/api/auth/machine-token').set('X-Forwarded-For', ip).send({ clientId: id, secret: sec });
  const build = async (from: string, to: string) => (await http().post('/api/accounts/tally/batches').set(hr).send({ company: COMPANY, from, to })).body.publicId as string;
  const approve = (id: string) => http().post(`/api/accounts/tally/batches/${id}/approve`).set(ceo).send().expect(200);
  const outbox = () => http().get('/api/accounts/tally/outbox').set(machine);
  const report = (body: object) => http().post('/api/accounts/tally/results').set(machine).send(body);
  const detail = async (id: string) => (await http().get(`/api/accounts/tally/batches/${id}`).set(hr)).body;

  let e1: string, e2: string, e3: string, e4: string;

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, ceo, tech, admin] = await Promise.all([DEMO.hr, DEMO.ceo, DEMO.technician, DEMO.admin].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    // The connector's outbox is tenant-wide, so this file and the other Tally spec must not run at the same time: whoever
    // starts first holds this lock until its afterAll (a session lock on this connection).
    await db.query('SELECT pg_advisory_lock(7203001)');
    const found = await db.query(`SELECT id FROM core.legal_entities WHERE tenant_id = 1 AND code = $1`, [COMPANY]);
    companyId = found.rows[0]?.id ? Number(found.rows[0].id)
      : Number((await db.query(`INSERT INTO core.legal_entities (tenant_id, code, name, legal_form) VALUES (1, $1, 'Connector Test Co', 'private_limited') RETURNING id`, [COMPANY])).rows[0].id);
    const tc = await http().post('/api/accounts/tally-company').set(hr).send({ company: COMPANY, tallyCompanyName: TALLY_NAME, booksFrom: '2037-01-01' });
    await http().post(`/api/accounts/tally-company/${tc.body.publicId}/approve`).set(ceo).send().expect(200);
    for (const [ledgerKey, tallyLedgerName] of [['expense.fuel', 'Fuel & Oil'], ['payable.reimbursements', 'Staff Reimbursements Payable'], ['bank.operating', 'HDFC Current']]) {
      const m = await http().post('/api/accounts/ledger-map').set(hr).send({ company: COMPANY, ledgerKey, tallyLedgerName });
      await http().post(`/api/accounts/ledger-map/${m.body.publicId}/approve`).set(ceo).send().expect(200);
    }
    e1 = await post('2037-03-01', 'expense_approved', 'expense.fuel', 'payable.reimbursements', 100_00);
    e2 = await post('2037-03-02', 'expense_paid', 'payable.reimbursements', 'bank.operating', 100_00);
    e3 = await post('2037-04-01', 'expense_approved', 'expense.fuel', 'payable.reimbursements', 50_00);
    e4 = await post('2037-05-01', 'expense_approved', 'expense.fuel', 'payable.reimbursements', 25_00);
  }, 180_000);
  afterAll(async () => { await db?.query('SELECT pg_advisory_unlock(7203001)'); await db?.end(); await app?.close(); });

  describe('the machine credential', () => {
    it('an admin makes one; the secret is shown once and only its hash is kept; others cannot make or list them', async () => {
      expect((await http().post('/api/core/machine-credentials').set(tech).send({ name: 'Tally PC' })).status).toBe(403);
      expect((await http().post('/api/core/machine-credentials').set(hr).send({ name: 'Tally PC' })).status).toBe(403);
      const made = await http().post('/api/core/machine-credentials').set(admin).send({ name: 'Tally server PC' });
      expect(made.status).toBe(201);
      expect(made.body).toMatchObject({ name: 'Tally server PC', permission: 'accounts.tally.connector', isActive: true, lastUsedAt: null });
      expect(made.body.clientId).toMatch(/^mc_/);
      expect(made.body.secret).toMatch(/^mcs_/);
      ({ clientId, secret } = made.body);
      credentialId = made.body.publicId;

      const stored = (await db.query(`SELECT secret_hash FROM core.machine_credentials WHERE public_id = $1`, [credentialId])).rows[0].secret_hash as string;
      expect(stored.startsWith('$2')).toBe(true);
      expect(stored).not.toContain(secret);
      const list = await http().get('/api/core/machine-credentials').set(admin);
      expect(JSON.stringify(list.body)).not.toContain(secret);
      expect(list.body.find((c: { publicId: string }) => c.publicId === credentialId)).not.toHaveProperty('secret');
      expect((await http().get('/api/core/machine-credentials').set(tech)).status).toBe(403);
      const audit = await db.query(`SELECT summary, details::text AS d FROM core.audit_log WHERE entity_public_id = $1`, [credentialId]);
      expect(JSON.stringify(audit.rows)).not.toContain(secret);
    });

    it('a wrong secret and an unknown client get the same answer; five wrong tries lock the client', async () => {
      const wrong = await tokenFor(clientId, 'mcs_not-the-secret-at-all');
      const unknown = await tokenFor('mc_unknown-client-id', 'mcs_not-the-secret-at-all');
      expect([wrong.status, wrong.body.code, wrong.body.message]).toEqual([401, 'AUTH_FAILED', unknown.body.message]);
      expect([unknown.status, unknown.body.code]).toEqual([401, 'AUTH_FAILED']);

      const lockMe = 'mc_throttle-test-client';
      const ip = freshIp();
      for (let i = 0; i < 4; i++) expect((await tokenFor(lockMe, 'mcs_not-the-secret-at-all', ip)).status).toBe(401);
      const locked = await tokenFor(lockMe, 'mcs_not-the-secret-at-all', ip);
      expect([locked.status, locked.body.code]).toEqual([429, 'AUTH_LOCKED']);
    });

    it('the right secret gives a 15-minute token that opens the connector routes and nothing else', async () => {
      const ok = await tokenFor(clientId, secret);
      expect(ok.status).toBe(200);
      expect(Date.parse(ok.body.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      machine = { Authorization: `Bearer ${ok.body.token}` };
      expect((await outbox()).status).toBe(200);
      expect((await http().get('/api/core/machine-credentials').set(machine)).status).toBe(403);
      for (const path of ['/api/auth/me', '/api/accounts/periods?company=ATPL&year=2037', `/api/accounts/tally/queue?company=${COMPANY}&from=2037-01-01&to=2037-12-31`, '/api/accounts/access', '/api/hrms/people']) {
        const r = await http().get(path).set(machine);
        expect([r.status, r.body.code], path).toEqual([403, 'FORBIDDEN']);
      }
      expect((await http().post('/api/accounts/tally/batches').set(machine).send({ company: COMPANY, from: '2037-01-01', to: '2037-12-31' })).status).toBe(403);
      expect((await db.query(`SELECT last_used_at FROM core.machine_credentials WHERE public_id = $1`, [credentialId])).rows[0].last_used_at).not.toBeNull();
    });

    it('people cannot use the connector routes, and a missing or bad token is refused', async () => {
      for (const auth of [hr, ceo, admin, tech]) expect((await http().get('/api/accounts/tally/outbox').set(auth)).status).toBe(403);
      expect((await http().get('/api/accounts/tally/outbox')).status).toBe(401);
      expect((await http().get('/api/accounts/tally/outbox').set({ Authorization: 'Bearer not.a.token' })).status).toBe(401);
    });
  });

  describe('outbox and results', () => {
    let b1 = '';

    it('only approved batches are in the outbox, with the XML, the entries and the ledger names Tally must have; taking one counts as the first download', async () => {
      b1 = await build('2037-03-01', '2037-03-31');
      expect((await outbox()).body.batches).toEqual([]);                      // built, not approved
      await approve(b1);
      const res = await outbox();
      expect(res.body.batches).toHaveLength(1);
      const [batch] = res.body.batches;
      expect(batch).toMatchObject({ publicId: b1, company: COMPANY, tallyCompanyName: TALLY_NAME, expectedCostCentres: [] });
      expect(batch.expectedLedgers).toEqual(['Fuel & Oil', 'HDFC Current', 'Staff Reimbursements Payable']);
      expect(batch.entries.map((e: { entryPublicId: string }) => e.entryPublicId).sort()).toEqual([e1, e2].sort());
      expect(batch.xml).toContain('<SVCURRENTCOMPANY>Connector Test Co</SVCURRENTCOMPANY>');
      expect(batch.xml).toContain(`REMOTEID="${e1}"`);
      expect((await detail(b1)).downloadedAt).not.toBeNull();
      const audit = await db.query(`SELECT actor_person_id, details::text AS d FROM core.audit_log WHERE entity_public_id = $1 AND action = 'accounts.tally_batch_downloaded'`, [b1]);
      expect(audit.rows[0].actor_person_id).toBeNull();                        // the connector is not a person
      expect(audit.rows[0].d).toContain('Tally server PC');
    });

    it('"not posted" keeps the batch in the outbox and shows the connector\'s note', async () => {
      const r = await report({ batchPublicId: b1, outcome: 'not_posted', message: 'Tally is not running on port 9000' });
      expect([r.status, r.body.state, r.body.onHold]).toEqual([200, 'approved', false]);
      expect((await outbox()).body.batches.map((b: { publicId: string }) => b.publicId)).toEqual([b1]);
      expect((await detail(b1)).connectorMessage).toBe('Tally is not running on port 9000');
    });

    it('a result that names a failed entry returns it to the queue; the batch is recorded as imported by the connector, once', async () => {
      const body = { batchPublicId: b1, outcome: 'completed', created: 1, altered: 0, errors: 1, lastVchId: '41', lineErrors: [`Voucher ${e2}: Ledger "HDFC Current" does not exist!`] };
      const r = await report(body);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ state: 'imported', onHold: false, entriesCreated: 1, entriesReturned: 1, message: null });
      const d = await detail(b1);
      expect(d).toMatchObject({ state: 'imported', importedByConnector: true, finishedBy: null, failedCount: 1, hasResult: true, onHold: false });
      expect(d.entries.find((e: { entryPublicId: string }) => e.entryPublicId === e2)).toMatchObject({ state: 'failed', tallyMessage: `Voucher ${e2}: Ledger "HDFC Current" does not exist!` });
      expect(await report(body).then((x) => x.body)).toEqual(r.body);        // a resend answers the same
      expect((await outbox()).body.batches).toEqual([]);
      const q = await http().get('/api/accounts/tally/queue').query({ company: COMPANY, from: '2037-03-01', to: '2037-03-31' }).set(hr);
      expect(q.body.items[0]).toMatchObject({ entryPublicId: e2, ready: true, lastError: `Voucher ${e2}: Ledger "HDFC Current" does not exist!` });
      const stored = (await db.query(`SELECT import_result, finished_by, finished_by_machine FROM accounts.tally_batches WHERE public_id = $1`, [b1])).rows[0];
      expect([stored.finished_by, stored.finished_by_machine === null]).toEqual([null, false]);
      expect(JSON.parse(stored.import_result)).toMatchObject({ source: 'connector', lastVchId: '41' });
    });

    it('"in doubt" puts the batch on hold: it leaves the outbox until a person records the result', async () => {
      const b2 = await build('2037-03-01', '2037-03-31');                    // the returned entry, e2
      await approve(b2);
      expect((await outbox()).body.batches.map((b: { publicId: string }) => b.publicId)).toEqual([b2]);
      const r = await report({ batchPublicId: b2, outcome: 'in_doubt', message: 'No answer from Tally after 120 seconds' });
      expect(r.body).toMatchObject({ state: 'approved', onHold: true, message: 'No answer from Tally after 120 seconds' });
      expect((await outbox()).body.batches).toEqual([]);
      expect(await detail(b2)).toMatchObject({ onHold: true, state: 'approved' });
      const done = await http().post(`/api/accounts/tally/batches/${b2}/mark-imported`).set(hr).send({});
      expect(done.body).toMatchObject({ state: 'imported', onHold: false, connectorMessage: null, importedByConnector: false, finishedBy: { displayName: 'Demo HR' } });
    });

    it('a result that does not say which entries failed also puts the batch on hold (not an error); cancelling clears the hold', async () => {
      const b3 = await build('2037-04-01', '2037-04-30');
      await approve(b3);
      await outbox();
      const r = await report({ batchPublicId: b3, outcome: 'completed', created: 0, altered: 0, errors: 1, lastVchId: null, lineErrors: ['Ledger does not exist'] });
      expect(r.status).toBe(200);
      expect(r.body.onHold).toBe(true);
      expect(r.body.message).toMatch(/Error that names no entry: Ledger does not exist/);
      expect((await outbox()).body.batches).toEqual([]);
      const cancelled = await http().post(`/api/accounts/tally/batches/${b3}/cancel`).set(hr).send();
      expect(cancelled.body).toMatchObject({ state: 'cancelled', onHold: false });
    });

    it('a clean result records every entry as created; counts that do not add up are held, not guessed', async () => {
      const bad = await build('2037-04-01', '2037-04-30');
      await approve(bad);
      const short = await report({ batchPublicId: bad, outcome: 'completed', created: 0, altered: 0, errors: 0, lastVchId: '1', lineErrors: [] });
      expect(short.body).toMatchObject({ state: 'approved', onHold: true });
      expect(short.body.message).toMatch(/expected/);
      await http().post(`/api/accounts/tally/batches/${bad}/cancel`).set(hr).send().expect(200);

      const good = await build('2037-04-01', '2037-05-31');                    // e3 and e4
      await approve(good);
      const r = await report({ batchPublicId: good, outcome: 'completed', created: 2, altered: 0, errors: 0, lastVchId: '57', lineErrors: [] });
      expect(r.body).toEqual({ state: 'imported', onHold: false, entriesCreated: 2, entriesReturned: 0, message: null });
      expect((await detail(good)).entries.map((e: { entryPublicId: string }) => e.entryPublicId).sort()).toEqual([e3, e4].sort());
    });

    it('unknown batches, unapproved batches and bad reports are refused', async () => {
      expect((await report({ batchPublicId: randomUUID(), outcome: 'completed', created: 1, errors: 0 })).status).toBe(404);
      const q = await post('2037-06-01', 'expense_approved', 'expense.fuel', 'payable.reimbursements', 5_00);
      const unapproved = await build('2037-06-01', '2037-06-30');
      const r = await report({ batchPublicId: unapproved, outcome: 'completed', created: 1, errors: 0 });
      expect([r.status, r.body.code]).toEqual([409, 'ACCOUNTS_TALLY_NOT_APPROVED']);
      expect(q).toBeTruthy();
      expect((await report({ batchPublicId: unapproved, outcome: 'maybe' })).body.code).toBe('VALIDATION');
      expect((await report({ batchPublicId: 'nope', outcome: 'completed' })).body.code).toBe('VALIDATION');
      await http().post(`/api/accounts/tally/batches/${unapproved}/cancel`).set(hr).send().expect(200);
    });
  });

  describe('the name check', () => {
    const mapping = (body: object) => http().post('/api/accounts/tally/mapping-report').set(machine).send({ tallyCompanyName: TALLY_NAME, ledgersChecked: 3, costCentresChecked: 0, missingLedgers: [], missingCostCentres: [], ...body });
    const nameAudits = async () => Number((await db.query(`SELECT count(*) FROM core.audit_log WHERE action = 'accounts.tally_names_checked' AND legal_entity_id = $1`, [companyId])).rows[0].count);

    it('names Tally does not have exactly are kept on the Tally company and audited once; a clean check clears them', async () => {
      const bad = await mapping({ missingLedgers: ['Fuel & Oil', 'HDFC Current'], missingCostCentres: ['Site 7'] });
      expect([bad.status, bad.body.ok]).toEqual([200, false]);
      const company = await http().get('/api/accounts/tally-company').query({ company: COMPANY }).set(hr);
      expect(company.body.connectorMissing).toEqual({ ledgers: ['Fuel & Oil', 'HDFC Current'], costCentres: ['Site 7'] });
      expect(company.body.connectorCheckedAt).not.toBeNull();
      expect(company.body.state).toBe('approved');                             // a check never withdraws the approval
      const before = await nameAudits();
      await mapping({ missingLedgers: ['HDFC Current', 'Fuel & Oil'], missingCostCentres: ['Site 7'] });   // same answer, different order
      expect(await nameAudits()).toBe(before);
      const clean = await mapping({});
      expect(clean.body.ok).toBe(true);
      expect((await http().get('/api/accounts/tally-company').query({ company: COMPANY }).set(hr)).body.connectorMissing).toEqual({ ledgers: [], costCentres: [] });
      expect(await nameAudits()).toBe(before + 1);
    });

    it('an unknown Tally company name is refused', async () => {
      expect((await mapping({ tallyCompanyName: 'No Such Company' })).status).toBe(404);
    });
  });

  describe('revoking', () => {
    it('revoking stops the token at once and a new sign-in; the record is kept', async () => {
      expect((await outbox()).status).toBe(200);
      const revoked = await http().post(`/api/core/machine-credentials/${credentialId}/revoke`).set(admin).send();
      expect(revoked.body).toMatchObject({ isActive: false });
      expect(revoked.body.revokedAt).not.toBeNull();
      const after = await outbox();
      expect([after.status, after.body.code]).toEqual([401, 'AUTH_INVALID']);
      expect((await tokenFor(clientId, secret)).status).toBe(401);
      expect((await http().post(`/api/core/machine-credentials/${credentialId}/revoke`).set(admin).send()).body.revokedAt).toBe(revoked.body.revokedAt);   // again: nothing changes
      await expect(db.query(`DELETE FROM core.machine_credentials WHERE public_id = $1`, [credentialId])).rejects.toThrow(/CORE_NO_DELETE/);
      expect((await http().post('/api/core/machine-credentials/' + credentialId + '/revoke').set(tech).send()).status).toBe(403);
    });
  });
});
