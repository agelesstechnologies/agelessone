import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../../app.module';
import { createTestApp, DEMO, signIn } from '../../../test/create-app';

// Seeded jobs (scripts/db-seed.mjs): the technician's job is managed by the supervisor; the engineer's has no manager.
const JOB = {
  supervisor: '00000000-0000-4000-8000-000000000101',
  technician: '00000000-0000-4000-8000-000000000102',
  engineer: '00000000-0000-4000-8000-000000000103',
  hr: '00000000-0000-4000-8000-000000000104',
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
type Auth = Record<string, string>;
interface Fields { employmentPublicId: string; categoryCode: string; spentOn?: string; amountPaise: string | number; publicId?: string; description?: string }

describe('HRMS expenses API', () => {
  let app: INestApplication;
  let tech: Auth, sup: Auth, hr: Auth, eng: Auth;
  const http = () => request(app.getHttpServer());

  /** Multipart submit, as a browser form sends it. */
  function submit(auth: Auth, f: Fields, file?: { data: Buffer; name: string; type: string }) {
    let req = http().post('/api/hrms/expenses').set(auth);
    for (const [k, v] of Object.entries({ spentOn: '2026-01-10', ...f })) if (v !== undefined) req = req.field(k, String(v));
    if (file) req = req.attach('receipt', file.data, { filename: file.name, contentType: file.type });
    return req;
  }
  const png = { data: PNG, name: 'receipt.png', type: 'image/png' };
  /** A submitted claim by the technician (food: no receipt needed); returns its public id. */
  async function techClaim(amountPaise = 50000, spentOn = '2026-01-10'): Promise<string> {
    const res = await submit(tech, { employmentPublicId: JOB.technician, categoryCode: 'food', amountPaise, spentOn });
    expect(res.status).toBe(201);
    return res.body.publicId;
  }
  const act = (auth: Auth, id: string, step: 'approve' | 'reject' | 'mark-paid', body: object = {}) =>
    http().post(`/api/hrms/expenses/${id}/${step}`).set(auth).send(body);

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [tech, sup, hr, eng] = await Promise.all([DEMO.technician, DEMO.supervisor, DEMO.hr, DEMO.engineer].map((d) => signIn(app, d.login)));
  });
  afterAll(async () => { await app?.close(); });

  it('lists the expense categories', async () => {
    const res = await http().get('/api/hrms/expenses/categories').set(tech);
    expect(res.status).toBe(200);
    expect(res.body.map((c: { code: string }) => c.code)).toEqual(['food', 'fuel', 'materials', 'other', 'travel']);
    expect(res.body.find((c: { code: string }) => c.code === 'fuel').receiptRequired).toBe(true);
    expect(res.body.find((c: { code: string }) => c.code === 'food').receiptRequired).toBe(false);
  });

  describe('submitting', () => {
    it('saves the claim and the receipt file under uploads, and shows it in "mine"', async () => {
      const res = await submit(tech, { employmentPublicId: JOB.technician, categoryCode: 'fuel', amountPaise: 12345, description: 'Diesel for site visit' }, png);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'submitted', amountPaise: 12345, category: { code: 'fuel' }, description: 'Diesel for site visit',
        person: { publicId: DEMO.technician.publicId }, employment: { publicId: JOB.technician, company: 'AE' },
      });
      expect(res.body.receiptPath).toMatch(/^receipts\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
      expect(existsSync(join(process.env.UPLOAD_DIR!, res.body.receiptPath))).toBe(true);

      const mine = await http().get('/api/hrms/expenses/mine').set(tech);
      expect(mine.body.items.map((c: { publicId: string }) => c.publicId)).toContain(res.body.publicId);
    });

    it('refuses a claim on someone else\'s job', async () => {
      const res = await submit(tech, { employmentPublicId: JOB.supervisor, categoryCode: 'food', amountPaise: 1000 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('HRMS_NOT_YOUR_EMPLOYMENT');
    });

    it('needs the amount as whole paise above zero', async () => {
      for (const amountPaise of ['0', '-500', '12.5', 'abc']) {
        const res = await submit(tech, { employmentPublicId: JOB.technician, categoryCode: 'food', amountPaise });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION');
        expect(res.body.details.map((d: { path: string }) => d.path)).toContain('amountPaise');
      }
    });

    it('needs a receipt when the category says so, and not otherwise', async () => {
      const fuel = await submit(tech, { employmentPublicId: JOB.technician, categoryCode: 'fuel', amountPaise: 5000 });
      expect(fuel.status).toBe(400);
      expect(fuel.body.code).toBe('HRMS_RECEIPT_REQUIRED');
      const food = await submit(tech, { employmentPublicId: JOB.technician, categoryCode: 'food', amountPaise: 5000 });
      expect(food.status).toBe(201);
      expect(food.body.receiptPath).toBeNull();
    });

    it('accepts only JPEG, PNG or PDF receipts, judged by the file itself', async () => {
      const res = await submit(tech, { employmentPublicId: JOB.technician, categoryCode: 'fuel', amountPaise: 5000 },
        { data: Buffer.from('not really a picture'), name: 'receipt.png', type: 'image/png' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('HRMS_RECEIPT_TYPE');
    });

    it('stores a resent claim (same publicId) only once', async () => {
      const publicId = randomUUID();
      const first = await submit(tech, { publicId, employmentPublicId: JOB.technician, categoryCode: 'food', amountPaise: 777 });
      const again = await submit(tech, { publicId, employmentPublicId: JOB.technician, categoryCode: 'food', amountPaise: 777 });
      expect([first.status, again.status]).toEqual([201, 200]);
      expect(again.body.publicId).toBe(publicId);
      const mine = await http().get('/api/hrms/expenses/mine?pageSize=100').set(tech);
      expect(mine.body.items.filter((c: { publicId: string }) => c.publicId === publicId)).toHaveLength(1);
    });
  });

  describe('approving and rejecting', () => {
    it('the manager of the job sees the claim to approve; an employee has no approval list', async () => {
      const id = await techClaim();
      const list = await http().get('/api/hrms/expenses/to-approve').set(sup);
      expect(list.status).toBe(200);
      expect(list.body.map((c: { publicId: string }) => c.publicId)).toContain(id);
      expect((await http().get('/api/hrms/expenses/to-approve').set(tech)).status).toBe(403);
    });

    it('approves the claimed amount or a lower one, never a higher one', async () => {
      const lower = await act(sup, await techClaim(50000), 'approve', { approvedAmountPaise: 42000 });
      expect(lower.status).toBe(200);
      expect(lower.body).toMatchObject({ status: 'approved', approvedAmountPaise: 42000, approvedBy: { publicId: DEMO.supervisor.publicId } });
      expect(lower.body.approvedAt).toEqual(expect.any(String));

      const full = await act(sup, await techClaim(30000), 'approve');
      expect(full.body.approvedAmountPaise).toBe(30000);

      const higher = await act(sup, await techClaim(10000), 'approve', { approvedAmountPaise: 10001 });
      expect(higher.status).toBe(400);
      expect(higher.body.code).toBe('HRMS_APPROVED_TOO_HIGH');
    });

    it('nobody approves or rejects their own claim', async () => {
      const own = await submit(hr, { employmentPublicId: JOB.hr, categoryCode: 'food', amountPaise: 2500 });
      expect(own.status).toBe(201);
      for (const step of ['approve', 'reject'] as const) {
        const res = await act(hr, own.body.publicId, step, { reason: 'my own claim' });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('HRMS_SELF_APPROVAL');
      }
    });

    it('a supervisor decides only claims on jobs they manage; HR decides any', async () => {
      const engClaim = await submit(eng, { employmentPublicId: JOB.engineer, categoryCode: 'food', amountPaise: 1500 });
      const bySup = await act(sup, engClaim.body.publicId, 'approve');
      expect(bySup.status).toBe(403);
      expect(bySup.body.code).toBe('FORBIDDEN');
      expect((await act(hr, engClaim.body.publicId, 'approve')).status).toBe(200);
    });

    it('a rejection needs a reason and is final', async () => {
      const id = await techClaim();
      const noReason = await act(sup, id, 'reject', {});
      expect(noReason.status).toBe(400);
      expect(noReason.body.code).toBe('VALIDATION');
      const res = await act(sup, id, 'reject', { reason: 'No bill for this meal' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'rejected', rejectionReason: 'No bill for this meal', rejectedBy: { publicId: DEMO.supervisor.publicId } });
      const later = await act(sup, id, 'approve');
      expect(later.status).toBe(409);
      expect(later.body.code).toBe('HRMS_CLAIM_NOT_PENDING');
    });
  });

  describe('paying', () => {
    it('only an approved claim can be paid, only by someone with the pay permission', async () => {
      const id = await techClaim(20000);
      const early = await act(hr, id, 'mark-paid', { paymentRef: 'NEFT-0001' });
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('HRMS_CLAIM_NOT_APPROVED');

      await act(sup, id, 'approve').expect(200);
      expect((await act(sup, id, 'mark-paid', { paymentRef: 'NEFT-0001' })).status).toBe(403);
      const paid = await act(hr, id, 'mark-paid', { paymentRef: 'NEFT-0001' });
      expect(paid.status).toBe(200);
      expect(paid.body).toMatchObject({ status: 'paid', paymentRef: 'NEFT-0001', paidAt: expect.any(String) });
    });

    it('a paid claim cannot change', async () => {
      const id = await techClaim(20000);
      await act(sup, id, 'approve').expect(200);
      await act(hr, id, 'mark-paid', { paymentRef: 'NEFT-0002' }).expect(200);
      for (const [step, body] of [['approve', {}], ['reject', { reason: 'too late' }], ['mark-paid', { paymentRef: 'NEFT-0003' }]] as const) {
        const res = await act(hr, id, step, body);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('HRMS_CLAIM_PAID');
      }
    });
  });

  describe('database rules (checked directly, without the API)', () => {
    let db: pg.Client;
    beforeAll(async () => { db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); });
    afterAll(async () => { await db?.end(); });
    const claimId = async (publicId: string) => (await db.query('SELECT id, person_id FROM hrms.expense_claims WHERE public_id = $1', [publicId])).rows[0];

    it('refuses self-approval, an approved amount above the claim, and "paid" without date and reference', async () => {
      const c = await claimId(await techClaim(10000));
      await expect(db.query('UPDATE hrms.expense_claims SET approved_by = person_id WHERE id = $1', [c.id])).rejects.toThrow(/expense_claims_not_self_approved/);
      await expect(db.query('UPDATE hrms.expense_claims SET approved_amount_paise = 10001 WHERE id = $1', [c.id])).rejects.toThrow(/expense_claims_approved_within_claim/);
      // decided fields set (as a claim that needed no approval), so only the payment details are missing
      await expect(db.query(`UPDATE hrms.expense_claims SET status = 'paid', approved_at = now(), approved_amount_paise = amount_paise, decided_as = 'no_approval_required' WHERE id = $1`, [c.id]))
        .rejects.toThrow(/expense_claims_paid_has_details/);
    });

    it('freezes a paid claim', async () => {
      const id = await techClaim(10000);
      await act(sup, id, 'approve').expect(200);
      await act(hr, id, 'mark-paid', { paymentRef: 'NEFT-0004' }).expect(200);
      const c = await claimId(id);
      await expect(db.query(`UPDATE hrms.expense_claims SET payment_ref = 'changed' WHERE id = $1`, [c.id])).rejects.toThrow(/is paid and cannot change/);
    });
  });

  describe('report', () => {
    it('totals by status and category for a company and date range', async () => {
      const day = '2025-01-15'; // only this test uses this date
      const fuel = await submit(tech, { employmentPublicId: JOB.technician, categoryCode: 'fuel', amountPaise: 10000, spentOn: day }, png);
      await submit(tech, { employmentPublicId: JOB.technician, categoryCode: 'food', amountPaise: 2000, spentOn: day }).expect(201);
      await submit(eng, { employmentPublicId: JOB.engineer, categoryCode: 'food', amountPaise: 3000, spentOn: day }).expect(201); // ATPL
      await act(sup, fuel.body.publicId, 'approve', { approvedAmountPaise: 9000 }).expect(200);
      await act(hr, fuel.body.publicId, 'mark-paid', { paymentRef: 'NEFT-0005' }).expect(200);

      const ae = await http().get('/api/hrms/expenses/report').query({ company: 'AE', from: day, to: day }).set(hr);
      expect(ae.status).toBe(200);
      expect(ae.body.total).toEqual({ count: 2, amountPaise: 12000, approvedPaise: 9000, paidPaise: 9000 });
      expect(ae.body.byCategory).toEqual([
        { code: 'food', name: 'Food', count: 1, amountPaise: 2000, approvedPaise: 0, paidPaise: 0 },
        { code: 'fuel', name: 'Fuel', count: 1, amountPaise: 10000, approvedPaise: 9000, paidPaise: 9000 },
      ]);
      expect(ae.body.byStatus).toEqual([{ status: 'paid', count: 1, amountPaise: 10000 }, { status: 'submitted', count: 1, amountPaise: 2000 }]);

      const all = await http().get('/api/hrms/expenses/report').query({ from: day, to: day }).set(hr);
      expect(all.body.total.count).toBe(3);
      expect(all.body.company).toBeNull();
    });

    it('is for HR only, and needs from ≤ to', async () => {
      expect((await http().get('/api/hrms/expenses/report').query({ from: '2025-01-01', to: '2025-01-31' }).set(sup)).status).toBe(403);
      const backwards = await http().get('/api/hrms/expenses/report').query({ from: '2025-02-01', to: '2025-01-01' }).set(hr);
      expect(backwards.status).toBe(400);
      expect(backwards.body.code).toBe('VALIDATION');
    });
  });
});
