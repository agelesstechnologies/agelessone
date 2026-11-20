import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { DB, Db } from '../../platform/db/db.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff } from '../../test/staff';
import { EXPENSE_LEDGER_KEYS, LEDGER_KEYS } from '@ageless/shared';
import { AccountsFacade } from './accounts.facade';

type Auth = Record<string, string>;
// Dates in 2033 and 2034 are used by no other test. Demo HR acts as maker and Demo CEO as checker (policy accounts.interim_roles).

describe('Accounts API', () => {
  let app: INestApplication;
  let hr: Auth, ceo: Auth, tech: Auth, admin: Auth;
  let both: Auth;            // holds both Accounts roles, to show nobody approves their own draft
  let db: pg.Client;
  let companyId: number;
  const http = () => request(app.getHttpServer());
  const facade = () => app.get(AccountsFacade);
  const post = (entryDate: string, lines: { ledgerKey: string; debitMinor: number; creditMinor: number }[], sourcePublicId = randomUUID(), sourceType: 'expense_approved' | 'expense_paid' = 'expense_approved') =>
    app.get<Db>(DB).transaction((tx) => facade().postEntry(tx, { tenantId: 1, legalEntityId: companyId, sourceType, sourcePublicId, entryDate, lines, createdBy: null }));
  const lines = (amount: number, a = 'expense.fuel', b = 'payable.reimbursements') => [
    { ledgerKey: a, debitMinor: amount, creditMinor: 0 }, { ledgerKey: b, debitMinor: 0, creditMinor: amount }];
  const period = (year: number, month: number) => ({ company: 'ATPL', year, month });
  const balanceOf = async (ledgerKey: string) => Number((await db.query(
    `SELECT coalesce(sum(debit_minor - credit_minor), 0) AS b FROM accounts.journal_lines WHERE legal_entity_id = $1 AND ledger_key = $2`, [companyId, ledgerKey])).rows[0].b);

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, ceo, tech, admin] = await Promise.all([DEMO.hr, DEMO.ceo, DEMO.technician, DEMO.admin].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    companyId = Number((await db.query(`SELECT id FROM core.legal_entities WHERE tenant_id = 1 AND code = 'ATPL'`)).rows[0].id);
    const s = await newStaff(app, hr, admin, ['ATPL']);
    for (const roleCode of ['accounts_executive', 'accounts_manager']) {
      await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: s.personId, roleCode, scope: 'all' }).expect(201);
    }
    both = s.auth;
  });
  afterAll(async () => { await db?.end(); await app?.close(); });

  describe('who may do what', () => {
    it('HR is the maker and the CEO the checker (and Management) while the interim policy applies; others have no Accounts access', async () => {
      const a = async (auth: Auth) => (await http().get('/api/accounts/access').query({ company: 'ATPL' }).set(auth)).body;
      expect(await a(hr)).toEqual({ maker: true, checker: false, ceo: false, view: true });
      expect(await a(ceo)).toEqual({ maker: false, checker: true, ceo: true, view: true });
      expect(await a(both)).toEqual({ maker: true, checker: true, ceo: false, view: true });
      expect(await a(tech)).toEqual({ maker: false, checker: false, ceo: false, view: false });
    });

    it('an employee is refused on every read', async () => {
      for (const path of ['periods?company=ATPL&year=2033', 'posting-rules', 'journal-entries', 'ledger-map?company=ATPL']) {
        expect((await http().get(`/api/accounts/${path}`).set(tech)).status, path).toBe(403);
      }
    });
  });

  describe('journal entries', () => {
    it('an entry whose debits and credits differ fails when the transaction commits', async () => {
      await db.query('BEGIN');
      try {
        const e = await db.query(`INSERT INTO accounts.journal_entries (tenant_id, legal_entity_id, source_type, source_public_id, entry_date)
          VALUES (1, $1, 'expense_approved', gen_random_uuid(), '2033-05-10') RETURNING id`, [companyId]);
        await db.query(`INSERT INTO accounts.journal_lines (tenant_id, entry_id, legal_entity_id, line_no, ledger_key, debit_minor, credit_minor)
          VALUES (1, $1, $2, 1, 'expense.fuel', 500, 0), (1, $1, $2, 2, 'payable.reimbursements', 0, 499)`, [e.rows[0].id, companyId]);
        await expect(db.query('COMMIT')).rejects.toThrow(/ACCOUNTS_UNBALANCED/);
      } finally { await db.query('ROLLBACK'); }
    });

    it('an entry with no lines fails at commit too', async () => {
      await db.query('BEGIN');
      try {
        await db.query(`INSERT INTO accounts.journal_entries (tenant_id, legal_entity_id, source_type, source_public_id, entry_date)
          VALUES (1, $1, 'expense_approved', gen_random_uuid(), '2033-05-10')`, [companyId]);
        await expect(db.query('COMMIT')).rejects.toThrow(/ACCOUNTS_UNBALANCED/);
      } finally { await db.query('ROLLBACK'); }
    });

    it('the service refuses unbalanced lines before writing anything', async () => {
      await expect(post('2033-05-10', [{ ledgerKey: 'expense.fuel', debitMinor: 5, creditMinor: 0 }, { ledgerKey: 'payable.reimbursements', debitMinor: 0, creditMinor: 4 }]))
        .rejects.toMatchObject({ code: 'ACCOUNTS_UNBALANCED' });
    });

    it('one entry per source document: posting it twice stores it once; the database refuses a second row', async () => {
      const source = randomUUID();
      const first = await post('2033-05-11', lines(120_000), source);
      const again = await post('2033-05-11', lines(120_000), source);
      expect([first.created, again.created, again.publicId]).toEqual([true, false, first.publicId]);
      expect(Number((await db.query(`SELECT count(*) FROM accounts.journal_entries WHERE source_public_id = $1`, [source])).rows[0].count)).toBe(1);
      await expect(db.query(`INSERT INTO accounts.journal_entries (tenant_id, legal_entity_id, source_type, source_public_id, entry_date)
        VALUES (1, $1, 'expense_approved', $2, '2033-05-11')`, [companyId, source])).rejects.toThrow(/journal_entries_source_unique/);
    });

    it('lines and entries cannot be edited or deleted', async () => {
      const e = await post('2033-05-12', lines(7_000));
      const id = (await db.query(`SELECT id FROM accounts.journal_entries WHERE public_id = $1`, [e.publicId])).rows[0].id;
      await expect(db.query(`UPDATE accounts.journal_lines SET debit_minor = 1 WHERE entry_id = $1 AND line_no = 1`, [id])).rejects.toThrow(/ACCOUNTS_APPEND_ONLY/);
      await expect(db.query(`DELETE FROM accounts.journal_lines WHERE entry_id = $1`, [id])).rejects.toThrow(/ACCOUNTS_APPEND_ONLY/);
      await expect(db.query(`UPDATE accounts.journal_entries SET entry_date = '2033-05-13' WHERE id = $1`, [id])).rejects.toThrow(/ACCOUNTS_APPEND_ONLY/);
      await expect(db.query(`DELETE FROM accounts.journal_entries WHERE id = $1`, [id])).rejects.toThrow(/ACCOUNTS_APPEND_ONLY/);
    });

    it('a reversal restores every balance, happens once, and is never itself reversed', async () => {
      const before = [await balanceOf('expense.travel'), await balanceOf('payable.vendors')];
      const entry = await post('2033-05-14', lines(50_000, 'expense.travel', 'payable.vendors'));
      expect(await balanceOf('expense.travel')).toBe(before[0] + 50_000);

      expect((await http().post(`/api/accounts/journal-entries/${entry.publicId}/reverse`).set(hr).send({ reason: 'wrong amount' })).status).toBe(403);
      const rev = await http().post(`/api/accounts/journal-entries/${entry.publicId}/reverse`).set(ceo).send({ reason: 'wrong amount' });
      expect(rev.status).toBe(201);
      expect(rev.body).toMatchObject({ sourceType: 'reversal', reversesPublicId: entry.publicId, totalDebitMinor: 50_000, totalCreditMinor: 50_000 });
      expect([await balanceOf('expense.travel'), await balanceOf('payable.vendors')]).toEqual(before);

      const again = await http().post(`/api/accounts/journal-entries/${entry.publicId}/reverse`).set(ceo).send({ reason: 'wrong amount' });
      expect([again.status, again.body.publicId]).toEqual([200, rev.body.publicId]);
      const original = await http().get(`/api/accounts/journal-entries/${entry.publicId}`).set(hr);
      expect(original.body.reversedByPublicId).toBe(rev.body.publicId);
      const reversingTheReversal = await http().post(`/api/accounts/journal-entries/${rev.body.publicId}/reverse`).set(ceo).send({ reason: 'again' });
      expect([reversingTheReversal.status, reversingTheReversal.body.code]).toEqual([409, 'ACCOUNTS_CANNOT_REVERSE_REVERSAL']);
    });

    it('entries are listed with filters and found by their source', async () => {
      const source = randomUUID();
      const e = await post('2033-06-02', lines(33_300, 'expense.materials', 'payable.vendors'), source);
      const list = await http().get('/api/accounts/journal-entries').query({ company: 'ATPL', from: '2033-06-01', to: '2033-06-30', ledgerKey: 'expense.materials' }).set(hr);
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0]).toMatchObject({ publicId: e.publicId, company: 'ATPL', entryDate: '2033-06-02', totalDebitMinor: 33_300, totalCreditMinor: 33_300 });
      expect(list.body.items[0].lines).toHaveLength(2);
      const bySource = await http().get(`/api/accounts/journal-entries/by-source/expense_approved/${source}`).set(hr);
      expect([bySource.status, bySource.body.publicId]).toEqual([200, e.publicId]);
      expect((await http().get(`/api/accounts/journal-entries/by-source/expense_approved/${randomUUID()}`).set(hr)).status).toBe(404);
    });
  });

  describe('periods', () => {
    it('all twelve months are listed; untouched ones are open', async () => {
      const res = await http().get('/api/accounts/periods').query({ company: 'ATPL', year: 2033 }).set(hr);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(12);
      expect(res.body.every((p: { state: string }) => p.state === 'open')).toBe(true);
    });

    it('only the checker closes; a closed month refuses postings (service and database); a soft-closed month still accepts them', async () => {
      expect((await http().post('/api/accounts/periods/close').set(hr).send(period(2033, 3))).status).toBe(403);
      const soft = await http().post('/api/accounts/periods/soft-close').set(ceo).send(period(2033, 2));
      expect(soft.body.state).toBe('soft_closed');
      await expect(post('2033-02-10', lines(100))).resolves.toMatchObject({ created: true });

      const closed = await http().post('/api/accounts/periods/close').set(ceo).send(period(2033, 3));
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ state: 'closed', closedBy: { displayName: 'Demo CEO' } });
      expect((await http().post('/api/accounts/periods/close').set(ceo).send(period(2033, 3))).body.state).toBe('closed');
      await expect(post('2033-03-10', lines(100))).rejects.toMatchObject({ code: 'ACCOUNTS_PERIOD_CLOSED', status: 409 });
      await expect(db.query(`INSERT INTO accounts.journal_entries (tenant_id, legal_entity_id, source_type, source_public_id, entry_date)
        VALUES (1, $1, 'expense_approved', gen_random_uuid(), '2033-03-31')`, [companyId])).rejects.toThrow(/ACCOUNTS_PERIOD_CLOSED/);
      await expect(post('2033-04-01', lines(100))).resolves.toMatchObject({ created: true });
    });

    it('reopening needs a request and then the CEO, never the same person; both steps are audited', async () => {
      await http().post('/api/accounts/periods/close').set(ceo).send(period(2033, 7)).expect(200);
      const notClosed = await http().post('/api/accounts/periods/reopen-request').set(hr).send({ ...period(2033, 8), reason: 'missed bill' });
      expect([notClosed.status, notClosed.body.code]).toEqual([409, 'ACCOUNTS_PERIOD_NOT_CLOSED']);
      const early = await http().post('/api/accounts/periods/reopen-approve').set(ceo).send(period(2033, 7));
      expect([early.status, early.body.code]).toEqual([409, 'ACCOUNTS_REOPEN_NOT_REQUESTED']);

      const asked = await http().post('/api/accounts/periods/reopen-request').set(hr).send({ ...period(2033, 7), reason: 'missed bill' });
      expect(asked.body).toMatchObject({ state: 'closed', reopenReason: 'missed bill', reopenRequestedBy: { displayName: 'Demo HR' } });
      expect((await http().post('/api/accounts/periods/reopen-approve').set(hr).send(period(2033, 7))).status).toBe(403);

      const opened = await http().post('/api/accounts/periods/reopen-approve').set(ceo).send(period(2033, 7));
      expect(opened.body).toMatchObject({ state: 'open', closedBy: null, reopenReason: null });
      await expect(post('2033-07-05', lines(100))).resolves.toMatchObject({ created: true });
      const audit = await db.query(`SELECT action FROM core.audit_log WHERE entity = 'accounts_period' AND legal_entity_id = $1 ORDER BY id`, [companyId]);
      expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['accounts.period_closed', 'accounts.period_reopen_requested', 'accounts.period_reopened']));
    });

    it('the person who asked cannot also approve', async () => {
      await http().post('/api/accounts/periods/close').set(ceo).send(period(2033, 9)).expect(200);
      await http().post('/api/accounts/periods/reopen-request').set(ceo).send({ ...period(2033, 9), reason: 'my own request' }).expect(200);
      const res = await http().post('/api/accounts/periods/reopen-approve').set(ceo).send(period(2033, 9));
      expect([res.status, res.body.code]).toEqual([403, 'ACCOUNTS_SELF_APPROVAL']);
    });
  });

  describe('posting rules', () => {
    it('with nothing stored the built-in rules apply', async () => {
      const res = await http().get('/api/accounts/posting-rules').query({ company: 'ATPL' }).set(hr);
      expect(res.status).toBe(200);
      const byEvent = Object.fromEntries(res.body.map((r: { eventType: string }) => [r.eventType, r]));
      expect(byEvent.expense_approved).toMatchObject({ debitLedgerKey: 'expense.<category>', creditLedgerKey: 'payable.reimbursements', source: 'default' });
      expect(byEvent.expense_paid).toMatchObject({ debitLedgerKey: 'payable.reimbursements', creditLedgerKey: 'bank.operating' });
      expect(byEvent.payroll_approved).toMatchObject({ debitLedgerKey: 'salary.expense', creditLedgerKey: 'payable.salary', deductionLedgerKey: null });
      expect(byEvent.salary_paid).toMatchObject({ debitLedgerKey: 'payable.salary', creditLedgerKey: 'bank.salary' });
    });

    it('the checker adds a new version that takes effect on its date; the maker cannot; a resend stores nothing new', async () => {
      const body = { company: 'ATPL', eventType: 'salary_paid', debitLedgerKey: 'payable.salary', creditLedgerKey: 'bank.salary', effectiveFrom: '2033-01-01' };
      expect((await http().post('/api/accounts/posting-rules').set(hr).send(body)).status).toBe(403);
      const id = randomUUID();
      const created = await http().post('/api/accounts/posting-rules').set(ceo).send({ ...body, publicId: id });
      expect([created.status, created.body.version]).toEqual([201, 1]);
      const again = await http().post('/api/accounts/posting-rules').set(ceo).send({ ...body, publicId: id });
      expect([again.status, again.body.publicId]).toEqual([200, id]);
      const next = await http().post('/api/accounts/posting-rules').set(ceo).send({ ...body, creditLedgerKey: 'bank.operating', effectiveFrom: '2034-01-01' });
      expect(next.body.version).toBe(2);
      await expect(db.query(`UPDATE accounts.posting_rules SET credit_ledger_key = 'bank.operating' WHERE public_id = $1`, [id])).rejects.toThrow(/ACCOUNTS_APPEND_ONLY/);
    });

    it('a rule must debit and credit different ledgers', async () => {
      const res = await http().post('/api/accounts/posting-rules').set(ceo).send({ company: 'ATPL', eventType: 'expense_paid', debitLedgerKey: 'bank.operating', creditLedgerKey: 'bank.operating', effectiveFrom: '2033-01-01' });
      expect([res.status, res.body.code]).toEqual([400, 'ACCOUNTS_RULE_INVALID']);
    });
  });

  describe('Tally company', () => {
    const draft = { company: 'ATPL', tallyCompanyName: 'Ageless Technologies Pvt Ltd', booksFrom: '2026-04-01' };

    it('starts unset; the maker drafts it, a different person approves; changing it withdraws the approval', async () => {
      const before = await http().get('/api/accounts/tally-company').query({ company: 'ATPL' }).set(hr);
      expect([before.status, before.body.state]).toEqual([200, 'unset']);
      expect((await http().post('/api/accounts/tally-company').set(tech).send(draft)).status).toBe(403);
      expect((await http().post('/api/accounts/tally-company').set(ceo).send(draft)).status).toBe(403);   // the checker does not draft

      const id = randomUUID();
      const made = await http().post('/api/accounts/tally-company').set(hr).send({ ...draft, publicId: id });
      expect([made.status, made.body.state, made.body.publicId, made.body.booksFrom]).toEqual([201, 'draft', id, '2026-04-01']);
      expect((await http().post('/api/accounts/tally-company').set(hr).send({ ...draft, publicId: id })).status).toBe(200);   // a resend
      expect((await http().post(`/api/accounts/tally-company/${id}/approve`).set(hr).send()).status).toBe(403);               // the maker cannot approve
      const approved = await http().post(`/api/accounts/tally-company/${id}/approve`).set(ceo).send();
      expect(approved.body).toMatchObject({ state: 'approved', tallyCompanyName: 'Ageless Technologies Pvt Ltd', approvedBy: { displayName: 'Demo CEO' } });

      const changed = await http().post('/api/accounts/tally-company').set(hr).send({ ...draft, booksFrom: '2026-04-02' });
      expect(changed.body).toMatchObject({ publicId: id, state: 'draft', booksFrom: '2026-04-02', approvedBy: null });
      await http().post('/api/accounts/tally-company').set(hr).send(draft).expect(200);
      expect((await http().post(`/api/accounts/tally-company/${id}/approve`).set(ceo).send()).body.state).toBe('approved');
    });

    it('there is one per company, and the database refuses a second or an approval by the drafter', async () => {
      const row = (await db.query(`SELECT public_id, drafted_by FROM accounts.tally_companies WHERE legal_entity_id = $1`, [companyId])).rows[0];
      await expect(db.query(`INSERT INTO accounts.tally_companies (tenant_id, public_id, legal_entity_id, tally_company_name, books_from, drafted_by)
        VALUES (1, gen_random_uuid(), $1, 'Another', '2026-04-01', $2)`, [companyId, row.drafted_by])).rejects.toThrow(/tally_companies_legal_entity_id_unique/);
      await expect(db.query(`UPDATE accounts.tally_companies SET state = 'approved', approved_by = drafted_by, approved_at = now() WHERE public_id = $1`, [row.public_id]))
        .rejects.toThrow(/tally_companies_not_own_approval/);
    });

    it('a ledger cannot be mapped for a company with no Tally company yet', async () => {
      const res = await http().post('/api/accounts/ledger-map').set(hr).send({ company: 'AE', ledgerKey: 'bank.operating', tallyLedgerName: 'HDFC Current' });
      expect([res.status, res.body.code]).toEqual([409, 'ACCOUNTS_TALLY_COMPANY_MISSING']);
    });

    it('the ledger map has no company name of its own any more', async () => {
      const cols = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'accounts' AND table_name = 'tally_ledger_map' AND column_name = 'tally_company'`);
      expect(cols.rowCount).toBe(0);
    });
  });

  describe('ledger keys', () => {
    it('the database accepts exactly the list in shared/', async () => {
      const def = (await db.query(`SELECT pg_get_functiondef('accounts.is_ledger_key(text)'::regprocedure) AS d`)).rows[0].d as string;
      const inDb = [...def.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort();
      expect(inDb).toEqual([...LEDGER_KEYS].sort());
    });

    it('an unknown key is refused: in a posting rule, a ledger mapping, a journal line, and by the database directly', async () => {
      const rule = { company: 'ATPL', eventType: 'salary_paid', debitLedgerKey: 'payable.salary', creditLedgerKey: 'bank.salary', effectiveFrom: '2033-01-01' };
      for (const bad of [{ creditLedgerKey: 'bank' }, { debitLedgerKey: 'salary_payable' }, { deductionLedgerKey: 'deduction:pt' }, { creditLedgerKey: 'expense:fuel' }]) {
        const res = await http().post('/api/accounts/posting-rules').set(ceo).send({ ...rule, ...bad });
        expect([res.status, res.body.code], JSON.stringify(bad)).toEqual([400, 'VALIDATION']);
      }
      const map = await http().post('/api/accounts/ledger-map').set(hr).send({ company: 'ATPL', ledgerKey: 'made_up', tallyLedgerName: 'Anything' });
      expect([map.status, map.body.code]).toEqual([400, 'VALIDATION']);
      expect(map.body.message).toMatch(/ledger key/i);

      await expect(post('2033-08-01', lines(100, 'made_up', 'payable.vendors'))).rejects.toThrow();
      await db.query('BEGIN');
      try {
        await expect(db.query(`INSERT INTO accounts.posting_rules (tenant_id, public_id, legal_entity_id, event_type, debit_ledger_key, credit_ledger_key, version, effective_from, created_by)
          VALUES (1, gen_random_uuid(), $1, 'salary_paid', 'payable.salary', 'bank', 99, '2033-01-01', (SELECT id FROM core.persons ORDER BY id LIMIT 1))`, [companyId]))
          .rejects.toThrow(/posting_rules_credit_key_check/);
      } finally { await db.query('ROLLBACK'); }
      await db.query('BEGIN');
      try {
        const e = await db.query(`INSERT INTO accounts.journal_entries (tenant_id, legal_entity_id, source_type, source_public_id, entry_date)
          VALUES (1, $1, 'expense_approved', gen_random_uuid(), '2033-08-02') RETURNING id`, [companyId]);
        await expect(db.query(`INSERT INTO accounts.journal_lines (tenant_id, entry_id, legal_entity_id, line_no, ledger_key, debit_minor, credit_minor)
          VALUES (1, $1, $2, 1, 'made_up', 5, 0)`, [e.rows[0].id, companyId])).rejects.toThrow(/journal_lines_key_check/);
      } finally { await db.query('ROLLBACK'); }
    });

    it('every list key is accepted, and payroll deductions can use the stat.* keys', async () => {
      for (const k of LEDGER_KEYS) expect((await db.query(`SELECT accounts.is_ledger_key($1) AS ok`, [k])).rows[0].ok, k).toBe(true);
      const res = await http().post('/api/accounts/posting-rules').set(ceo).send({ company: 'ATPL', eventType: 'payroll_approved', debitLedgerKey: 'salary.expense',
        creditLedgerKey: 'payable.salary', deductionLedgerKey: 'stat.pt', effectiveFrom: '2035-01-01' });
      expect([res.status, res.body.deductionLedgerKey]).toEqual([201, 'stat.pt']);
    });

    it('an expense category cannot be created without a ledger key, nor with one that is not an expense.* key', async () => {
      const insert = (cols: string, vals: string) => db.query(`INSERT INTO hrms.expense_categories (tenant_id, code, name, ${cols}) VALUES (1, 'keytest', 'Key test', ${vals})`);
      await db.query('BEGIN');
      try {
        await db.query('SAVEPOINT s');
        await expect(insert('receipt_required', 'true')).rejects.toThrow(/ledger_key/);
        await db.query('ROLLBACK TO s');
        await expect(insert('ledger_key', `'bank.operating'`)).rejects.toThrow(/expense_categories_ledger_key_check/);
        await db.query('ROLLBACK TO s');
        await expect(insert('ledger_key', `'expense.made_up'`)).rejects.toThrow(/expense_categories_ledger_key_check/);
        await db.query('ROLLBACK TO s');
        await expect(insert('ledger_key', `'expense.travel'`)).resolves.toBeDefined();
      } finally { await db.query('ROLLBACK'); }
    });

    it('every expense category has an expense.* key (the five seeded ones map to their own)', async () => {
      const rows = (await db.query(`SELECT code, ledger_key FROM hrms.expense_categories WHERE tenant_id = 1`)).rows;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(EXPENSE_LEDGER_KEYS as readonly string[], r.code).toContain(r.ledger_key);
      for (const code of ['fuel', 'travel', 'food', 'materials', 'other']) expect(rows.find((r) => r.code === code)?.ledger_key).toBe(`expense.${code}`);
    });
  });

  describe('Tally ledger map', () => {
    it('keys the rules use start unmapped; the maker drafts, a different person approves', async () => {
      const before = await http().get('/api/accounts/ledger-map').query({ company: 'ATPL' }).set(hr);
      expect(before.body.find((m: { ledgerKey: string }) => m.ledgerKey === 'payable.reimbursements')).toMatchObject({ state: 'unmapped', publicId: null, tallyCompany: 'Ageless Technologies Pvt Ltd' });

      const draft = { company: 'ATPL', ledgerKey: 'payable.reimbursements', tallyLedgerName: 'Staff Reimbursements Payable' };
      expect((await http().post('/api/accounts/ledger-map').set(tech).send(draft)).status).toBe(403);
      expect((await http().post('/api/accounts/ledger-map').set(ceo).send(draft)).status).toBe(403);   // the checker does not draft
      const id = randomUUID();
      const made = await http().post('/api/accounts/ledger-map').set(hr).send({ ...draft, publicId: id });
      expect([made.status, made.body.state, made.body.publicId]).toEqual([201, 'draft', id]);
      expect((await http().post('/api/accounts/ledger-map').set(hr).send({ ...draft, publicId: id })).status).toBe(200);

      expect((await http().post(`/api/accounts/ledger-map/${id}/approve`).set(hr).send()).status).toBe(403);   // the maker cannot approve
      const approved = await http().post(`/api/accounts/ledger-map/${id}/approve`).set(ceo).send();
      expect(approved.body).toMatchObject({ state: 'approved', approvedBy: { displayName: 'Demo CEO' }, draftedBy: { displayName: 'Demo HR' } });

      const changed = await http().post('/api/accounts/ledger-map').set(hr).send({ ...draft, tallyLedgerName: 'Reimbursements Payable' });
      expect(changed.body).toMatchObject({ publicId: id, state: 'draft', tallyLedgerName: 'Reimbursements Payable', approvedBy: null });
    });

    it('someone holding both roles cannot approve their own draft; the database says so too', async () => {
      const id = randomUUID();
      await http().post('/api/accounts/ledger-map').set(both).send({ publicId: id, company: 'ATPL', ledgerKey: 'bank.operating', tallyLedgerName: 'HDFC Current' }).expect(201);
      const own = await http().post(`/api/accounts/ledger-map/${id}/approve`).set(both).send();
      expect([own.status, own.body.code]).toEqual([403, 'ACCOUNTS_SELF_APPROVAL']);
      await expect(db.query(`UPDATE accounts.tally_ledger_map SET state = 'approved', approved_by = drafted_by, approved_at = now() WHERE public_id = $1`, [id]))
        .rejects.toThrow(/tally_ledger_map_not_own_approval/);
      expect((await http().post(`/api/accounts/ledger-map/${id}/approve`).set(ceo).send()).body.state).toBe('approved');
    });
  });
});
