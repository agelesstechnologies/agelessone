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
  const lines = (amount: number, a = 'expense:fuel', b = 'staff_reimbursements_payable') => [
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
          VALUES (1, $1, $2, 1, 'a', 500, 0), (1, $1, $2, 2, 'b', 0, 499)`, [e.rows[0].id, companyId]);
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
      await expect(post('2033-05-10', [{ ledgerKey: 'a', debitMinor: 5, creditMinor: 0 }, { ledgerKey: 'b', debitMinor: 0, creditMinor: 4 }]))
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
      const before = [await balanceOf('expense:rev_test'), await balanceOf('payable_rev_test')];
      const entry = await post('2033-05-14', lines(50_000, 'expense:rev_test', 'payable_rev_test'));
      expect(await balanceOf('expense:rev_test')).toBe(before[0] + 50_000);

      expect((await http().post(`/api/accounts/journal-entries/${entry.publicId}/reverse`).set(hr).send({ reason: 'wrong amount' })).status).toBe(403);
      const rev = await http().post(`/api/accounts/journal-entries/${entry.publicId}/reverse`).set(ceo).send({ reason: 'wrong amount' });
      expect(rev.status).toBe(201);
      expect(rev.body).toMatchObject({ sourceType: 'reversal', reversesPublicId: entry.publicId, totalDebitMinor: 50_000, totalCreditMinor: 50_000 });
      expect([await balanceOf('expense:rev_test'), await balanceOf('payable_rev_test')]).toEqual(before);

      const again = await http().post(`/api/accounts/journal-entries/${entry.publicId}/reverse`).set(ceo).send({ reason: 'wrong amount' });
      expect([again.status, again.body.publicId]).toEqual([200, rev.body.publicId]);
      const original = await http().get(`/api/accounts/journal-entries/${entry.publicId}`).set(hr);
      expect(original.body.reversedByPublicId).toBe(rev.body.publicId);
      const reversingTheReversal = await http().post(`/api/accounts/journal-entries/${rev.body.publicId}/reverse`).set(ceo).send({ reason: 'again' });
      expect([reversingTheReversal.status, reversingTheReversal.body.code]).toEqual([409, 'ACCOUNTS_CANNOT_REVERSE_REVERSAL']);
    });

    it('entries are listed with filters and found by their source', async () => {
      const source = randomUUID();
      const e = await post('2033-06-02', lines(33_300, 'expense:list_test'), source);
      const list = await http().get('/api/accounts/journal-entries').query({ company: 'ATPL', from: '2033-06-01', to: '2033-06-30', ledgerKey: 'expense:list_test' }).set(hr);
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
      expect(byEvent.expense_approved).toMatchObject({ debitLedgerKey: 'expense:<category>', creditLedgerKey: 'staff_reimbursements_payable', source: 'default' });
      expect(byEvent.expense_paid).toMatchObject({ debitLedgerKey: 'staff_reimbursements_payable', creditLedgerKey: 'bank' });
      expect(byEvent.payroll_approved).toMatchObject({ debitLedgerKey: 'salary_expense', creditLedgerKey: 'salary_payable', deductionLedgerKey: 'deduction:<label>' });
      expect(byEvent.salary_paid).toMatchObject({ debitLedgerKey: 'salary_payable', creditLedgerKey: 'bank' });
    });

    it('the checker adds a new version that takes effect on its date; the maker cannot; a resend stores nothing new', async () => {
      const body = { company: 'ATPL', eventType: 'salary_paid', debitLedgerKey: 'salary_payable', creditLedgerKey: 'bank_hdfc', effectiveFrom: '2033-01-01' };
      expect((await http().post('/api/accounts/posting-rules').set(hr).send(body)).status).toBe(403);
      const id = randomUUID();
      const created = await http().post('/api/accounts/posting-rules').set(ceo).send({ ...body, publicId: id });
      expect([created.status, created.body.version]).toEqual([201, 1]);
      const again = await http().post('/api/accounts/posting-rules').set(ceo).send({ ...body, publicId: id });
      expect([again.status, again.body.publicId]).toEqual([200, id]);
      const next = await http().post('/api/accounts/posting-rules').set(ceo).send({ ...body, creditLedgerKey: 'bank_icici', effectiveFrom: '2034-01-01' });
      expect(next.body.version).toBe(2);
      await expect(db.query(`UPDATE accounts.posting_rules SET credit_ledger_key = 'x' WHERE public_id = $1`, [id])).rejects.toThrow(/ACCOUNTS_APPEND_ONLY/);
    });

    it('a rule must debit and credit different ledgers', async () => {
      const res = await http().post('/api/accounts/posting-rules').set(ceo).send({ company: 'ATPL', eventType: 'expense_paid', debitLedgerKey: 'bank', creditLedgerKey: 'bank', effectiveFrom: '2033-01-01' });
      expect([res.status, res.body.code]).toEqual([400, 'ACCOUNTS_RULE_INVALID']);
    });
  });

  describe('Tally ledger map', () => {
    it('keys the rules use start unmapped; the maker drafts, a different person approves', async () => {
      const before = await http().get('/api/accounts/ledger-map').query({ company: 'ATPL' }).set(hr);
      expect(before.body.find((m: { ledgerKey: string }) => m.ledgerKey === 'staff_reimbursements_payable')).toMatchObject({ state: 'unmapped', publicId: null });

      const draft = { company: 'ATPL', ledgerKey: 'staff_reimbursements_payable', tallyCompany: 'Ageless Technologies', tallyLedgerName: 'Staff Reimbursements Payable' };
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
      await http().post('/api/accounts/ledger-map').set(both).send({ publicId: id, company: 'ATPL', ledgerKey: 'bank', tallyCompany: 'Ageless Technologies', tallyLedgerName: 'HDFC Current' }).expect(201);
      const own = await http().post(`/api/accounts/ledger-map/${id}/approve`).set(both).send();
      expect([own.status, own.body.code]).toEqual([403, 'ACCOUNTS_SELF_APPROVAL']);
      await expect(db.query(`UPDATE accounts.tally_ledger_map SET state = 'approved', approved_by = drafted_by, approved_at = now() WHERE public_id = $1`, [id]))
        .rejects.toThrow(/tally_ledger_map_not_own_approval/);
      expect((await http().post(`/api/accounts/ledger-map/${id}/approve`).set(ceo).send()).body.state).toBe('approved');
    });
  });
});
