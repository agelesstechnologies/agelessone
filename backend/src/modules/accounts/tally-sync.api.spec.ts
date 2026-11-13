import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { DB, Db } from '../../platform/db/db.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff } from '../../test/staff';
import { AccountsFacade } from './accounts.facade';

type Auth = Record<string, string>;
const COMPANY = 'TSYNC';   // a company only this file uses, so it never meets the other Accounts tests; dates are in 2035-2036
const TALLY_NAME = 'Sync Test & Sons Pvt Ltd';

describe('Accounts: Tally sync (a file, no connection to Tally)', () => {
  let app: INestApplication;
  let hr: Auth, ceo: Auth, tech: Auth, admin: Auth, both: Auth;   // hr = maker, ceo = checker, both = holds both roles
  let db: pg.Client;
  let companyId: number;
  const http = () => request(app.getHttpServer());
  const facade = () => app.get(AccountsFacade);
  const post = async (entryDate: string, sourceType: 'expense_approved' | 'expense_paid', debit: string, credit: string, amount: number) =>
    (await app.get<Db>(DB).transaction((tx) => facade().postEntry(tx, { tenantId: 1, legalEntityId: companyId, sourceType, sourcePublicId: randomUUID(), entryDate, createdBy: null,
      lines: [{ ledgerKey: debit, debitMinor: amount, creditMinor: 0 }, { ledgerKey: credit, debitMinor: 0, creditMinor: amount }] }))).publicId;
  const queue = (from: string, to: string, auth = hr) => http().get('/api/accounts/tally/queue').query({ company: COMPANY, from, to }).set(auth);
  const create = (from: string, to: string, auth = hr, publicId?: string) => http().post('/api/accounts/tally/batches').set(auth).send({ company: COMPANY, from, to, ...(publicId && { publicId }) });
  const act = (id: string, what: string, auth: Auth, body: object = {}) => http().post(`/api/accounts/tally/batches/${id}/${what}`).set(auth).send(body);
  const countJournal = async () => Number((await db.query(`SELECT (SELECT count(*) FROM accounts.journal_entries) + (SELECT count(*) FROM accounts.journal_lines) AS n`)).rows[0].n);

  let e0: string, e1: string, e2: string, e3: string;
  let batch1 = '', batch2 = '';

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
      : Number((await db.query(`INSERT INTO core.legal_entities (tenant_id, code, name, legal_form) VALUES (1, $1, 'Tally Sync Test Co', 'private_limited') RETURNING id`, [COMPANY])).rows[0].id);
    const s = await newStaff(app, hr, admin, ['ATPL']);
    for (const roleCode of ['accounts_executive', 'accounts_manager']) await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: s.personId, roleCode, scope: 'all' }).expect(201);
    both = s.auth;

    // The Tally company (books from 2036-01-01) and the ledger mappings, drafted by the maker and approved by the checker.
    const tc = await http().post('/api/accounts/tally-company').set(hr).send({ company: COMPANY, tallyCompanyName: TALLY_NAME, booksFrom: '2036-01-01' });
    await http().post(`/api/accounts/tally-company/${tc.body.publicId}/approve`).set(ceo).send().expect(200);
    for (const [ledgerKey, tallyLedgerName] of [['expense.fuel', 'Fuel & Oil'], ['payable.reimbursements', 'Staff Reimbursements Payable'], ['bank.operating', 'HDFC Current']]) {
      const m = await http().post('/api/accounts/ledger-map').set(hr).send({ company: COMPANY, ledgerKey, tallyLedgerName });
      await http().post(`/api/accounts/ledger-map/${m.body.publicId}/approve`).set(ceo).send().expect(200);
    }
    // expense.food is deliberately left unmapped.
    e0 = await post('2035-12-31', 'expense_approved', 'expense.fuel', 'payable.reimbursements', 5_00);      // before the books start
    e1 = await post('2036-05-10', 'expense_approved', 'expense.fuel', 'payable.reimbursements', 1_234_50);
    e2 = await post('2036-05-11', 'expense_paid', 'payable.reimbursements', 'bank.operating', 1_234_50);
    e3 = await post('2036-05-12', 'expense_approved', 'expense.food', 'payable.reimbursements', 99_99);      // blocked: no Tally ledger for expense.food
  }, 180_000);
  afterAll(async () => { await db?.query('SELECT pg_advisory_unlock(7203001)'); await db?.end(); await app?.close(); });

  it('the queue shows ready and blocked entries, leaves out dates before the books start, and is for Accounts roles only', async () => {
    const q = await queue('2035-12-01', '2036-05-31');
    expect(q.status).toBe(200);
    const byId = Object.fromEntries(q.body.items.map((i: { entryPublicId: string }) => [i.entryPublicId, i]));
    expect(byId[e0]).toBeUndefined();
    expect(byId[e1]).toMatchObject({ ready: true, blockedKeys: [], totalMinor: 1_234_50, sourceType: 'expense_approved', lastError: null });
    expect(byId[e3]).toMatchObject({ ready: false, blockedKeys: ['expense.food'] });
    expect([q.body.readyCount, q.body.blockedCount, q.body.returnedCount]).toEqual([2, 1, 0]);
    expect((await queue('2036-05-01', '2036-05-31', tech)).status).toBe(403);
    expect((await queue('2036-06-01', '2036-05-01')).body.code).toBe('VALIDATION');
  });

  it('only the maker builds a batch; entries with an unmapped ledger stay in the queue; asking again with the same id answers the same batch', async () => {
    expect((await create('2036-05-01', '2036-05-31', tech)).status).toBe(403);
    expect((await create('2036-05-01', '2036-05-31', ceo)).status).toBe(403);   // the checker does not build
    const id = randomUUID();
    const made = await create('2036-05-01', '2036-05-31', hr, id);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ publicId: id, state: 'built', entryCount: 2, totalMinor: 2_469_00, skippedBlocked: 1, tallyCompanyName: TALLY_NAME, approvedBy: null, createdBy: { displayName: 'Demo HR' } });
    expect(made.body.entries.map((e: { entryPublicId: string; voucherType: string }) => [e.entryPublicId, e.voucherType]))
      .toEqual([[e1, 'Platform Journal'], [e2, 'Platform Payment']]);
    batch1 = id;
    const again = await create('2036-05-01', '2036-05-31', hr, id);
    expect([again.status, again.body.publicId]).toEqual([200, id]);
    expect((await queue('2036-05-01', '2036-05-31')).body.items.map((i: { entryPublicId: string }) => i.entryPublicId)).toEqual([e3]);   // taken entries leave the queue
    const nothing = await create('2036-05-01', '2036-05-31');
    expect([nothing.status, nothing.body.code]).toEqual([409, 'ACCOUNTS_TALLY_NOTHING_TO_SEND']);
    expect(nothing.body.message).toMatch(/1 use a ledger/);
  });

  it('nothing can be downloaded or marked imported before the checker approves', async () => {
    const dl = await http().get(`/api/accounts/tally/batches/${batch1}/download`).set(hr);
    expect([dl.status, dl.body.code]).toEqual([409, 'ACCOUNTS_TALLY_NOT_APPROVED']);
    expect((await act(batch1, 'mark-imported', hr)).body.code).toBe('ACCOUNTS_TALLY_NOT_APPROVED');
    expect((await act(batch1, 'import-result', hr, { resultText: '<RESPONSE><CREATED>2</CREATED></RESPONSE>' })).body.code).toBe('ACCOUNTS_TALLY_NOT_APPROVED');
    await expect(db.query(`UPDATE accounts.tally_batches SET downloaded_at = now() WHERE public_id = $1`, [batch1])).rejects.toThrow(/tally_batches_download_after_approval/);
  });

  it('a different person, the checker, approves each batch; nobody approves their own; approving twice changes nothing', async () => {
    const own = randomUUID();
    const eMine = await post('2036-06-05', 'expense_approved', 'expense.fuel', 'payable.reimbursements', 10_00);
    expect((await create('2036-06-01', '2036-06-30', both, own)).status).toBe(201);
    const refused = await act(own, 'approve', both);
    expect([refused.status, refused.body.code]).toEqual([403, 'ACCOUNTS_SELF_APPROVAL']);
    await expect(db.query(`UPDATE accounts.tally_batches SET state = 'approved', approved_by = created_by, approved_at = now() WHERE public_id = $1`, [own])).rejects.toThrow(/tally_batches_not_own_approval/);
    expect((await act(own, 'approve', hr)).status).toBe(403);   // the maker cannot approve either

    const ok = await act(own, 'approve', ceo);
    expect(ok.body).toMatchObject({ state: 'approved', approvedBy: { displayName: 'Demo CEO' } });
    expect(eMine).toBeTruthy();

    const first = await act(batch1, 'approve', ceo);
    expect([first.status, first.body.state]).toEqual([200, 'approved']);
    const second = await act(batch1, 'approve', ceo);
    expect([second.body.state, second.body.approvedAt]).toEqual(['approved', first.body.approvedAt]);

    // Approved but not downloaded: the accountant cannot say it was imported yet. (Then cancel it, which returns its entry to the queue.)
    const early = await act(own, 'mark-imported', hr);
    expect([early.status, early.body.code]).toEqual([409, 'ACCOUNTS_TALLY_NOT_DOWNLOADED']);
    const cancelled = await act(own, 'cancel', hr);
    expect(cancelled.body).toMatchObject({ state: 'cancelled', failedCount: 1 });
    expect((await act(own, 'approve', ceo)).body.code).toBe('ACCOUNTS_TALLY_BATCH_CANCELLED');
    expect((await http().get(`/api/accounts/tally/batches/${own}/download`).set(hr)).status).toBe(409);
    const back = (await queue('2036-06-01', '2036-06-30')).body.items[0];
    expect(back).toMatchObject({ entryPublicId: eMine, ready: true, lastError: 'Batch cancelled before it was imported' });
  });

  it('an approved batch downloads as an XML file with the Tally signs, the company, the REMOTEIDs and escaped names; the first download is recorded', async () => {
    expect((await http().get(`/api/accounts/tally/batches/${batch1}/download`).set(tech)).status).toBe(403);
    const res = await http().get(`/api/accounts/tally/batches/${batch1}/download`).set(hr).buffer(true).parse((r, cb) => { let d = ''; r.setEncoding('utf8'); r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.headers['content-disposition']).toMatch(new RegExp(`attachment; filename="tally-${COMPANY}-\\d{4}-\\d{2}-\\d{2}-${batch1.slice(0, 8)}\\.xml"`));
    const xml = res.body as string;
    expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(xml).toContain('<SVCURRENTCOMPANY>Sync Test &amp; Sons Pvt Ltd</SVCURRENTCOMPANY>');
    expect(xml).toContain(`REMOTEID="${e1}" VCHTYPE="Platform Journal"`);
    expect(xml).toContain(`REMOTEID="${e2}" VCHTYPE="Platform Payment"`);
    expect(xml).toContain('<LEDGERNAME>Fuel &amp; Oil</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1234.50</AMOUNT>');
    expect(xml).toContain('<LEDGERNAME>Staff Reimbursements Payable</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1234.50</AMOUNT>');
    expect(xml).not.toContain(e3);   // the blocked entry is not in the file
    const detail = await http().get(`/api/accounts/tally/batches/${batch1}`).set(hr);
    expect(detail.body.downloadedAt).not.toBeNull();
    const audit = await db.query(`SELECT action FROM core.audit_log WHERE entity = 'tally_batch' AND legal_entity_id = $1`, [companyId]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['accounts.tally_batch_created', 'accounts.tally_batch_approved', 'accounts.tally_batch_downloaded', 'accounts.tally_batch_cancelled']));
  });

  it('Tally\'s result is refused when it does not say which entries failed; one that names an entry returns it to the queue with the error text', async () => {
    const unnamed = await act(batch1, 'import-result', hr, { resultText: '<RESPONSE><CREATED>1</CREATED><ERRORS>1</ERRORS><LINEERROR>Ledger does not exist</LINEERROR></RESPONSE>' });
    expect([unnamed.status, unnamed.body.code]).toEqual([409, 'ACCOUNTS_TALLY_RESULT_UNCLEAR']);
    expect(unnamed.body.details.reasons[0]).toMatch(/names no entry/);
    expect((await act(batch1, 'import-result', hr, { resultText: 'hello' })).body.code).toBe('ACCOUNTS_TALLY_RESULT_UNCLEAR');
    expect((await http().get(`/api/accounts/tally/batches/${batch1}`).set(hr)).body.state).toBe('approved');   // nothing changed
    expect((await act(batch1, 'import-result', tech, { resultText: 'x' })).status).toBe(403);
    expect((await act(batch1, 'import-result', ceo, { resultText: 'x' })).status).toBe(403);                   // the checker does not record imports

    const text = `<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><LINEERROR>Voucher ${e2}: Ledger &quot;HDFC Current&quot; does not exist!</LINEERROR></RESPONSE>`;
    const done = await act(batch1, 'import-result', hr, { resultText: text });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: 'imported', failedCount: 1, hasResult: true, finishedBy: { displayName: 'Demo HR' } });
    const states = Object.fromEntries(done.body.entries.map((e: { entryPublicId: string; state: string }) => [e.entryPublicId, e]));
    expect(states[e1]).toMatchObject({ state: 'created', tallyMessage: null });
    expect(states[e2]).toMatchObject({ state: 'failed', tallyMessage: `Voucher ${e2}: Ledger "HDFC Current" does not exist!` });

    const again = await act(batch1, 'import-result', hr, { resultText: text });   // a resend answers the batch as it is
    expect([again.status, again.body.state, again.body.failedCount]).toEqual([200, 'imported', 1]);
    expect((await act(batch1, 'cancel', hr)).body.code).toBe('ACCOUNTS_TALLY_BATCH_IMPORTED');

    const q = await queue('2036-05-01', '2036-05-31');
    expect(q.body.items.find((i: { entryPublicId: string }) => i.entryPublicId === e2)).toMatchObject({ ready: true, lastError: `Voucher ${e2}: Ledger "HDFC Current" does not exist!` });
    expect(q.body.returnedCount).toBe(1);
  });

  it('the returned entry goes into a new batch; marking it imported records it as created; an entry is in one live batch only', async () => {
    const made = await create('2036-05-01', '2036-05-31');
    expect([made.status, made.body.entryCount, made.body.skippedBlocked]).toEqual([201, 1, 1]);
    batch2 = made.body.publicId;
    expect(made.body.entries[0].entryPublicId).toBe(e2);
    await act(batch2, 'approve', ceo).then((r) => expect(r.status).toBe(200));
    expect((await http().get(`/api/accounts/tally/batches/${batch2}/download`).set(both)).status).toBe(200);

    const stranger = await act(batch2, 'mark-imported', hr, { failed: [{ entryPublicId: e1, error: 'not in this batch' }] });
    expect([stranger.status, stranger.body.code]).toEqual([400, 'ACCOUNTS_TALLY_UNKNOWN_ENTRY']);
    expect((await act(batch2, 'mark-imported', hr, { failed: [{ entryPublicId: e2, error: '' }] })).body.code).toBe('VALIDATION');
    const done = await act(batch2, 'mark-imported', hr);
    expect(done.body).toMatchObject({ state: 'imported', failedCount: 0 });
    expect(done.body.entries[0]).toMatchObject({ entryPublicId: e2, state: 'created' });
    expect((await act(batch2, 'mark-imported', hr)).body.state).toBe('imported');   // a resend changes nothing

    const live = await db.query(`SELECT count(*)::int AS n FROM accounts.tally_exports x JOIN accounts.journal_entries e ON e.id = x.entry_id WHERE e.public_id = $1 AND x.state <> 'failed'`, [e2]);
    expect(live.rows[0].n).toBe(1);
    await expect(db.query(`INSERT INTO accounts.tally_exports (tenant_id, batch_id, entry_id, legal_entity_id, remote_id, voucher_type)
      SELECT 1, x.batch_id, x.entry_id, x.legal_entity_id, x.remote_id, x.voucher_type FROM accounts.tally_exports x JOIN accounts.journal_entries e ON e.id = x.entry_id
       WHERE e.public_id = $1 AND x.state = 'created'`, [e2])).rejects.toThrow(/tally_exports_batch_entry_unique|tally_exports_entry_once/);
  });

  it('batches are listed newest first; an unmapped-ledger entry becomes ready once the ledger is mapped and approved', async () => {
    const list = await http().get('/api/accounts/tally/batches').query({ company: COMPANY }).set(hr);
    expect(list.body.map((b: { publicId: string }) => b.publicId).slice(0, 2)).toEqual([batch2, expect.any(String)]);
    expect(list.body.map((b: { state: string }) => b.state)).toEqual(expect.arrayContaining(['imported', 'cancelled']));
    expect((await http().get('/api/accounts/tally/batches').query({ company: COMPANY }).set(tech)).status).toBe(403);

    const m = await http().post('/api/accounts/ledger-map').set(hr).send({ company: COMPANY, ledgerKey: 'expense.food', tallyLedgerName: 'Food & Refreshments' });
    expect((await queue('2036-05-12', '2036-05-12')).body.items[0]).toMatchObject({ entryPublicId: e3, ready: false });    // still a draft: not approved
    await http().post(`/api/accounts/ledger-map/${m.body.publicId}/approve`).set(ceo).send().expect(200);
    expect((await queue('2036-05-12', '2036-05-12')).body.items[0]).toMatchObject({ entryPublicId: e3, ready: true });
  });

  it('the journal is never touched, and what was sent to Tally is never deleted', async () => {
    const before = await countJournal();
    const made = await create('2036-05-12', '2036-05-12');
    expect(made.status).toBe(201);
    await act(made.body.publicId, 'cancel', hr);
    expect(await countJournal()).toBe(before);
    await expect(db.query(`DELETE FROM accounts.tally_batches WHERE public_id = $1`, [batch1])).rejects.toThrow(/ACCOUNTS_NO_DELETE/);
    await expect(db.query(`DELETE FROM accounts.tally_exports WHERE batch_id = (SELECT id FROM accounts.tally_batches WHERE public_id = $1)`, [batch1])).rejects.toThrow(/ACCOUNTS_NO_DELETE/);
  });

  it('a company whose Tally company is not approved cannot build a batch', async () => {
    const tc = await http().post('/api/accounts/tally-company').set(hr).send({ company: COMPANY, tallyCompanyName: TALLY_NAME, booksFrom: '2036-01-02' });   // a change: draft again
    expect(tc.body.state).toBe('draft');
    const res = await create('2036-05-12', '2036-05-12');
    expect([res.status, res.body.code]).toEqual([409, 'ACCOUNTS_TALLY_COMPANY_NOT_APPROVED']);
    await http().post(`/api/accounts/tally-company/${tc.body.publicId}/approve`).set(ceo).send().expect(200);
  });
});
