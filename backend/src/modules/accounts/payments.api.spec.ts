import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { newStaff } from '../../test/staff';

type Auth = Record<string, string>;
// Demo HR acts as maker and Demo CEO as checker (policy accounts.interim_roles); `both` holds both roles.

describe('Accounts payments API', () => {
  let app: INestApplication;
  let hr: Auth, ceo: Auth, tech: Auth, both: Auth;
  const http = () => request(app.getHttpServer());
  const ask = (auth: Auth, amountMinor = 150000, extra: object = {}) => http().post('/api/accounts/payment-requests').set(auth)
    .send({ company: 'ATPL', payeeName: 'Demo Vendor', payeeKind: 'vendor', purpose: 'Test supplies', amountMinor, dueDate: '2035-01-31', ...extra });
  const approved = async (amountMinor = 150000) => {
    const r = (await ask(hr, amountMinor).expect(201)).body;
    await http().post(`/api/accounts/payment-requests/${r.publicId}/approve`).set(ceo).expect(200);
    return r.publicId as string;
  };

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    const admin = await signIn(app, DEMO.admin.login);
    [hr, ceo, tech] = await Promise.all([DEMO.hr, DEMO.ceo, DEMO.technician].map((d) => signIn(app, d.login)));
    const s = await newStaff(app, hr, admin, ['ATPL']);
    for (const roleCode of ['accounts_executive', 'accounts_manager']) {
      await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: s.personId, roleCode, scope: 'all' }).expect(201);
    }
    both = s.auth;
  });
  afterAll(async () => { await app?.close(); });

  it('an employee is refused on every read and write', async () => {
    for (const path of ['payment-requests?company=ATPL', 'payment-batches?company=ATPL', 'bank/lines?company=ATPL', 'reports/trial-balance?company=ATPL', 'reports/payments-summary?company=ATPL']) {
      expect((await http().get(`/api/accounts/${path}`).set(tech)).status, path).toBe(403);
    }
    expect((await ask(tech)).status).toBe(403);
  });

  describe('payment requests', () => {
    it('the maker asks once even when the call is repeated; the checker cannot ask', async () => {
      const publicId = randomUUID();
      const first = await ask(hr, 99900, { publicId }).expect(201);
      const again = await ask(hr, 99900, { publicId }).expect(200);
      expect(again.body.publicId).toBe(first.body.publicId);
      expect(first.body).toMatchObject({ state: 'pending', amountMinor: 99900, currency: 'INR' });
      expect((await ask(ceo)).status).toBe(403);
    });

    it('refuses a zero amount and a missing purpose', async () => {
      expect((await ask(hr, 0)).status).toBe(400);
      expect((await ask(hr, 100, { purpose: '' })).status).toBe(400);
    });

    it('nobody approves their own request; a different checker does; approving twice changes nothing', async () => {
      const own = (await ask(both).expect(201)).body.publicId;
      const refused = await http().post(`/api/accounts/payment-requests/${own}/approve`).set(both);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('ACCOUNTS_SELF_APPROVAL');
      expect((await http().post(`/api/accounts/payment-requests/${own}/approve`).set(hr)).status).toBe(403);
      expect((await http().post(`/api/accounts/payment-requests/${own}/approve`).set(ceo).expect(200)).body).toMatchObject({ state: 'approved', decidedBy: { displayName: 'Demo CEO' } });
      await http().post(`/api/accounts/payment-requests/${own}/approve`).set(ceo).expect(200);
    });

    it('a rejected request needs a reason and cannot be approved; only a pending one can be cancelled', async () => {
      const id = (await ask(hr).expect(201)).body.publicId;
      expect((await http().post(`/api/accounts/payment-requests/${id}/reject`).set(ceo).send({ note: '' })).status).toBe(400);
      expect((await http().post(`/api/accounts/payment-requests/${id}/reject`).set(ceo).send({ note: 'Not budgeted' }).expect(200)).body.state).toBe('rejected');
      expect((await http().post(`/api/accounts/payment-requests/${id}/approve`).set(ceo)).body.code).toBe('ACCOUNTS_BAD_STATE');
      const ok = await approved();
      expect((await http().post(`/api/accounts/payment-requests/${ok}/cancel`).set(hr).send({ note: 'Changed mind' })).body.code).toBe('ACCOUNTS_BAD_STATE');
    });
  });

  describe('payment batches and the bank', () => {
    it('a batch takes only approved requests and moves them along: draft, approved, paid', async () => {
      const a = await approved(200000), b = await approved(300000);
      const pending = (await ask(hr).expect(201)).body.publicId;
      const body = { company: 'ATPL', bankLedgerKey: 'bank.operating' };
      expect((await http().post('/api/accounts/payment-batches').set(hr).send({ ...body, requestPublicIds: [a, pending] })).body.code).toBe('ACCOUNTS_BAD_STATE');
      const id = randomUUID();
      const made = await http().post('/api/accounts/payment-batches').set(hr).send({ ...body, publicId: id, requestPublicIds: [a, b] }).expect(201);
      expect(made.body).toMatchObject({ state: 'draft', requestCount: 2, totalMinor: 500000 });
      expect(made.body.requests.map((r: { state: string }) => r.state)).toEqual(['batched', 'batched']);
      await http().post('/api/accounts/payment-batches').set(hr).send({ ...body, publicId: id, requestPublicIds: [a, b] }).expect(200);
      expect((await http().post('/api/accounts/payment-batches').set(hr).send({ ...body, requestPublicIds: [a] })).body.code).toBe('ACCOUNTS_BAD_STATE');

      // paying needs approval first; the maker cannot approve their own batch
      const pay = { paidOn: '2035-01-20', bankReference: 'UTR-TEST-1' };
      expect((await http().post(`/api/accounts/payment-batches/${id}/mark-paid`).set(hr).send(pay)).body.code).toBe('ACCOUNTS_BAD_STATE');
      expect((await http().post(`/api/accounts/payment-batches/${id}/approve`).set(hr)).status).toBe(403);
      await http().post(`/api/accounts/payment-batches/${id}/approve`).set(ceo).expect(200);
      const paid = await http().post(`/api/accounts/payment-batches/${id}/mark-paid`).set(hr).send(pay).expect(200);
      expect(paid.body.state).toBe('paid');
      expect(paid.body.requests.every((r: { state: string }) => r.state === 'paid')).toBe(true);
      expect((await http().post(`/api/accounts/payment-batches/${id}/cancel`).set(hr).send({ note: 'oops' })).body.code).toBe('ACCOUNTS_BAD_STATE');
    });

    it('cancelling a batch frees its requests', async () => {
      const a = await approved(110000);
      const id = (await http().post('/api/accounts/payment-batches').set(hr).send({ company: 'ATPL', bankLedgerKey: 'bank.operating', requestPublicIds: [a] }).expect(201)).body.publicId;
      const cancelled = await http().post(`/api/accounts/payment-batches/${id}/cancel`).set(ceo).send({ note: 'Wrong bank' }).expect(200);
      expect(cancelled.body.state).toBe('cancelled');
      const r = (await http().get('/api/accounts/payment-requests').query({ company: 'ATPL', state: 'approved' }).set(hr)).body.find((x: { publicId: string }) => x.publicId === a);
      expect(r).toMatchObject({ state: 'approved', batchPublicId: null });
    });

    it('a statement can be imported twice; a money-out line matches the paid batch of the same amount and bank, once', async () => {
      const a = await approved(777700);
      const id = (await http().post('/api/accounts/payment-batches').set(hr).send({ company: 'ATPL', bankLedgerKey: 'bank.operating', requestPublicIds: [a] }).expect(201)).body.publicId;
      await http().post(`/api/accounts/payment-batches/${id}/approve`).set(ceo).expect(200);
      const lines = [
        { txnDate: '2035-02-02', description: 'NEFT out', reference: 'R1', debitMinor: 777700, creditMinor: 0 },
        { txnDate: '2035-02-03', description: 'Customer receipt', reference: 'R2', debitMinor: 0, creditMinor: 50000 },
        { txnDate: '2035-02-04', description: 'NEFT out other', reference: 'R3', debitMinor: 1234, creditMinor: 0 },
      ];
      const imp = { company: 'ATPL', bankLedgerKey: 'bank.operating', lines };
      expect((await http().post('/api/accounts/bank/import').set(hr).send(imp).expect(200)).body).toEqual({ imported: 3, skipped: 0 });
      expect((await http().post('/api/accounts/bank/import').set(hr).send(imp).expect(200)).body).toEqual({ imported: 0, skipped: 3 });
      expect((await http().post('/api/accounts/bank/import').set(hr).send({ ...imp, lines: [{ ...lines[0]!, creditMinor: 5 }] })).status).toBe(400);

      const all = (await http().get('/api/accounts/bank/lines').query({ company: 'ATPL', state: 'unmatched' }).set(hr)).body as { publicId: string; reference: string }[];
      const out = all.find((l) => l.reference === 'R1')!, receipt = all.find((l) => l.reference === 'R2')!, other = all.find((l) => l.reference === 'R3')!;
      const match = (line: string, batch: string) => http().post(`/api/accounts/bank/lines/${line}/match`).set(hr).send({ batchPublicId: batch });
      expect((await match(out.publicId, id)).body.code).toBe('ACCOUNTS_BAD_STATE');   // batch not paid yet
      await http().post(`/api/accounts/payment-batches/${id}/mark-paid`).set(hr).send({ paidOn: '2035-02-02', bankReference: 'UTR-2' }).expect(200);
      expect((await match(receipt.publicId, id)).body.code).toBe('ACCOUNTS_BAD_STATE');   // money in
      expect((await match(other.publicId, id)).body.code).toBe('ACCOUNTS_AMOUNT_MISMATCH');
      const done = await match(out.publicId, id).expect(200);
      expect(done.body).toMatchObject({ state: 'matched', matchedBatchPublicId: id });
      await match(out.publicId, id).expect(200);   // again: same answer
      expect((await http().get(`/api/accounts/payment-batches/${id}`).set(hr)).body.reconciled).toBe(true);
    });
  });

  describe('reports', () => {
    it('the trial balance balances and the summary lists every state', async () => {
      const tb = (await http().get('/api/accounts/reports/trial-balance').query({ company: 'ATPL' }).set(hr).expect(200)).body;
      expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
      const s = (await http().get('/api/accounts/reports/payments-summary').query({ company: 'ATPL' }).set(ceo).expect(200)).body;
      expect(Object.keys(s.requests).sort()).toEqual(['approved', 'batched', 'cancelled', 'paid', 'pending', 'rejected']);
      expect(s.requests.paid.count).toBeGreaterThanOrEqual(3);
      expect(s.bank.matched.count).toBeGreaterThanOrEqual(1);
    });
  });
});
