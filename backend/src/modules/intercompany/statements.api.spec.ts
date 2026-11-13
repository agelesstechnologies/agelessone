import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { createTestApp, DEMO, signIn } from '../../test/create-app';
import { tag } from '../../test/people';
import { newStaff, Staff } from '../../test/staff';
import { addDays, todayIst } from '../../platform/time';
import { StatementsService } from './application/statements.service';

type Auth = Record<string, string>;
type Line = { publicId: string; kind: string; serviceType: string | null; rateMinor: number | null; minutes: number | null; amountMinor: number;
  costMinor: number | null; status: string; tickets: { publicId: string; minutes: number }[] };
const PDF = Buffer.from('%PDF-1.4\n% made-up test bill\n%%EOF\n');
const letters = () => Array.from({ length: 5 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
// AE provides to ATPL here (the other intercompany spec has the ATPL → AE agreement: one active agreement per pair).
// AE's August and September 2025 are locked for these statements; no other test uses AE's months of 2025-08 to 2025-10.

describe('Intercompany statements API', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth, ceo: Auth;
  let aeHead: Staff, atplHead: Staff, aeApprover: Staff, atplApprover: Staff, deptHead: Staff, worker1: Staff, worker2: Staff, outsider: Staff;
  let agreementId: string;
  let tA: string, tB: string, tC: string;
  let august: string, september: string;
  const project = randomUUID();
  const http = () => request(app.getHttpServer());
  const time = (ticket: string, s: Staff, date: string, minutes: number) => db.query(
    `INSERT INTO tickets.ticket_time_allocations (tenant_id, ticket_id, employment_id, legal_entity_id, person_id, work_date, minutes)
     SELECT 1, t.id, e.id, e.legal_entity_id, e.person_id, $3::date, $4 FROM tickets.tickets t, hrms.employments e WHERE t.public_id = $1 AND e.public_id = $2`,
    [ticket, s.jobs.AE, date, minutes]);
  const statement = async (id: string, auth: Auth = ceo) => (await http().get(`/api/intercompany/statements/${id}`).set(auth).expect(200)).body;
  const line = (lines: Line[], f: (l: Line) => boolean) => lines.find(f)!;
  const post = (path: string, auth: Auth, body: Record<string, unknown> = {}) => http().post(`/api/intercompany/${path}`).set(auth).send(body);

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    [aeHead, atplHead, aeApprover, atplApprover, deptHead, worker1, worker2, outsider] = await Promise.all([
      newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['ATPL']), newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['ATPL']),
      newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['AE']),
    ]);

    agreementId = (await http().post('/api/intercompany/agreements').set(ceo).send({
      provider: { company: 'AE', headEmploymentPublicId: aeHead.jobs.AE, approverEmploymentPublicId: aeApprover.jobs.AE },
      receiver: { company: 'ATPL', headEmploymentPublicId: atplHead.jobs.ATPL, approverEmploymentPublicId: atplApprover.jobs.ATPL },
      services: ['design', 'software'], pricingMethod: 'rate_card', startDate: '2025-06-01',
    }).expect(201)).body.publicId;
    await http().patch(`/api/intercompany/agreements/${agreementId}`).set(ceo).send({ status: 'active' }).expect(200);
    for (const [serviceType, rateMinor, effectiveFrom] of [['design', 150_000, '2025-06-01'], ['design', 180_000, '2025-08-16'], ['software', 200_000, '2025-06-01']] as const) {
      await http().post(`/api/intercompany/agreements/${agreementId}/rate-cards`).set(ceo).send({ serviceType, rateMinor, effectiveFrom }).expect(201);
    }
    // payroll: ₹41,600 and ₹20,800 a month ÷ 208 h = ₹200 and ₹100 an hour (Demo HR also holds the Payroll role)
    for (const [s, monthly] of [[worker1, 4_160_000], [worker2, 2_080_000]] as const) {
      await http().post('/api/payroll/salaries').set(hr).send({ employmentPublicId: s.jobs.AE, monthlyAmountPaise: monthly, effectiveFrom: '2025-04-01' }).expect(201);
    }

    // an AE department headed by deptHead (Manager role); tickets of it, created by that head
    await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: deptHead.personId, roleCode: 'manager', scope: 'team' }).expect(201);
    const dept = (await http().post('/api/hrms/departments').set(hr).send({ company: 'AE', name: `IC billing ${tag()}`, codePrefix: letters() }).expect(201)).body.publicId;
    await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: deptHead.personId }).expect(200);
    const design = (await http().get('/api/tickets/types').query({ company: 'AE' }).set(hr)).body.find((t: { code: string }) => t.code === 'design').publicId;
    const ticket = async () => (await http().post('/api/tickets').set(deptHead.auth).send({ company: 'AE', typePublicId: design, title: `Ride ${tag()}`,
      departmentPublicId: dept, scheduledAt: '2025-08-01T04:00:00.000Z' }).expect(201)).body.publicId as string;
    [tA, tB, tC] = [await ticket(), await ticket(), await ticket()];
    const tD = await ticket();   // never linked: not billed
    const link = (t: string, serviceType: string) => http().put(`/api/intercompany/tickets/${t}/link`).set(deptHead.auth)
      .send({ kind: 'project', publicId: project, company: 'ATPL', serviceType }).expect(200);
    await link(tA, 'design');
    await link(tB, 'software');
    await link(tC, 'design');
    await http().post(`/api/intercompany/tickets/${tC}/billable`).set(deptHead.auth).send({ billable: false, reason: 'Warranty rework' }).expect(200);

    // ticket time (written directly; the test does not punch): allocations plus a head's adjustment
    await time(tA, worker1, '2025-08-05', 120);
    await db.query(`INSERT INTO tickets.ticket_time_adjustments (tenant_id, batch_id, ticket_id, employment_id, legal_entity_id, person_id, work_date, minutes, reason, adjusted_by, adjusted_as)
      SELECT 1, gen_random_uuid(), t.id, e.id, e.legal_entity_id, e.person_id, DATE '2025-08-05', 30, 'Forgot to punch', h.id, 'head'
        FROM tickets.tickets t, hrms.employments e, core.persons h WHERE t.public_id = $1 AND e.public_id = $2 AND h.public_id = $3`, [tA, worker1.jobs.AE, deptHead.personId]);
    await time(tA, worker1, '2025-08-20', 60);      // the new design rate from 16 August
    await time(tB, worker2, '2025-08-06', 90);
    await time(tC, worker1, '2025-08-07', 45);      // not billable
    await time(tD, worker2, '2025-08-08', 60);      // not linked
    await time(tA, worker1, '2025-09-03', 60);
    await time(tA, worker1, '2025-10-02', 30);      // October stays unbilled

    // passed-on costs: one with its bill (counts), one waiting for a bill (does not)
    await http().post(`/api/intercompany/agreements/${agreementId}/passed-costs`).set(aeHead.auth)
      .field('description', 'Acrylic sheets').field('amountMinor', '100000').field('incurredOn', '2025-08-12')
      .attach('bill', PDF, { filename: 'bill.pdf', contentType: 'application/pdf' }).expect(201);
    await http().post(`/api/intercompany/agreements/${agreementId}/passed-costs`).set(aeHead.auth)
      .field('description', 'Courier, bill to follow').field('amountMinor', '50000').field('incurredOn', '2025-08-13').expect(201);

    for (const month of [8, 9]) await http().post('/api/hrms/month-locks').set(hr).send({ company: 'AE', year: 2025, month }).expect(201);
  }, 120_000);
  afterAll(async () => { await db?.end(); await app?.close(); });

  it('a month whose attendance is not locked is refused', async () => {
    const res = await post(`agreements/${agreementId}/statements`, ceo, { year: 2025, month: 10 });
    expect([res.status, res.body.code]).toEqual([409, 'IC_MONTH_NOT_LOCKED']);
    // only the provider's head or the CEO builds one
    expect((await post(`agreements/${agreementId}/statements`, atplHead.auth, { year: 2025, month: 8 })).status).toBe(403);
  });

  it('totals equal allocated hours (with the head\'s adjustment) × the rate in force; each line links to its tickets', async () => {
    const res = await post(`agreements/${agreementId}/statements`, ceo, { year: 2025, month: 8 });
    expect(res.status).toBe(201);
    august = res.body.publicId;
    const lines: Line[] = res.body.lines;
    expect(lines.map((l) => [l.kind, l.serviceType, l.rateMinor, l.minutes, l.amountMinor])).toEqual([
      ['labour', 'design', 150_000, 150, 375_000],        // 2 h + 30 min adjustment at ₹1,500
      ['labour', 'design', 180_000, 60, 180_000],         // 1 h at ₹1,800 (from 16 August)
      ['labour', 'software', 200_000, 90, 300_000],       // 1.5 h at ₹2,000
      ['passed_cost', null, null, null, 100_000],         // with its bill; the one without is left out
    ]);
    expect(res.body).toMatchObject({ status: 'draft', totalMinor: 955_000, minutes: 300, preparedBy: { publicId: DEMO.ceo.publicId } });
    expect(line(lines, (l) => l.rateMinor === 150_000).tickets).toEqual([expect.objectContaining({ publicId: tA, minutes: 150 })]);
    expect(line(lines, (l) => l.serviceType === 'software').tickets).toEqual([expect.objectContaining({ publicId: tB, minutes: 90 })]);
    expect(lines.flatMap((l) => l.tickets.map((t) => t.publicId))).not.toContain(tC);
    // the same month again: the stored statement
    expect((await post(`agreements/${agreementId}/statements`, aeHead.auth, { year: 2025, month: 8 })).status).toBe(200);
  });

  it('the preparer cannot approve; a head of a department with time on it can, and the month is billed', async () => {
    // what each one may do, as the screens show it
    expect((await statement(august, ceo)).actions).toMatchObject({ approve: false, rebuild: true, send: false });
    expect((await statement(august, deptHead.auth)).actions).toMatchObject({ approve: true, rebuild: false });
    expect((await statement(august, atplHead.auth)).actions).toEqual({ rebuild: false, approve: false, send: false, answer: false, correct: false, invoice: false, close: false });
    expect([(await statement(august, atplHead.auth)).viewerSide, (await statement(august, deptHead.auth)).viewerSide, (await statement(august, ceo)).viewerSide])
      .toEqual(['receiver', 'provider', 'all']);
    const self = await post(`statements/${august}/approve`, ceo);
    expect([self.status, self.body.code]).toEqual([403, 'IC_SELF_APPROVAL']);
    const notHead = await post(`statements/${august}/approve`, aeHead.auth);
    expect([notHead.status, notHead.body.code]).toEqual([403, 'IC_NOT_APPROVER']);
    const ok = await post(`statements/${august}/approve`, deptHead.auth);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved_by_provider', approved: { by: { publicId: deptHead.personId }, as: 'head' } });
    expect((await http().get(`/api/intercompany/agreements/${agreementId}`).set(ceo)).body.billedMonths).toEqual([expect.objectContaining({ year: 2025, month: 8 })]);
    expect((await post(`statements/${august}/rebuild`, aeHead.auth)).body.code).toBe('IC_STATEMENT_STATUS');
  });

  it('dispute flow: the receiver disputes lines; the provider corrects or explains and sends again; accepted; a correction after invoicing is a credit', async () => {
    const sent = await post(`statements/${august}/send`, aeHead.auth);
    expect(sent.body).toMatchObject({ status: 'sent', round: 1, reviewDueOn: addDays(todayIst(), 5) });
    const lines: Line[] = sent.body.lines;
    const software = line(lines, (l) => l.serviceType === 'software').publicId;
    const cost = line(lines, (l) => l.kind === 'passed_cost').publicId;

    expect((await post(`statements/${august}/answer`, aeHead.auth, {})).body.code).toBe('IC_NOT_RECEIVER');
    expect((await post(`statements/${august}/answer`, outsider.auth, {})).status).toBe(404);
    const answered = await post(`statements/${august}/answer`, atplHead.auth,
      { disputes: [{ linePublicId: software, reason: 'Only 1 hour was agreed' }, { linePublicId: cost, reason: 'Which project?' }] });
    expect(answered.body.status).toBe('partly_disputed');
    expect(answered.body.lines.map((l: Line) => l.status)).toEqual(['accepted', 'accepted', 'disputed', 'disputed']);

    expect((await post(`statements/${august}/send`, aeHead.auth)).body.code).toBe('IC_DISPUTES_OPEN');
    expect((await post(`statement-lines/${software}/correct`, aeHead.auth, { amountMinor: 300_000, reason: 'Same' })).body.code).toBe('IC_AMOUNT_NOT_LOWER');
    expect((await post(`statement-lines/${software}/correct`, aeHead.auth, { amountMinor: 1 })).status).toBe(400);   // reason required
    const corrected = await post(`statement-lines/${software}/correct`, aeHead.auth, { amountMinor: 240_000, reason: 'Agreed: 72 minutes' });
    expect(line(corrected.body.lines, (l) => l.publicId === software)).toMatchObject({ amountMinor: 240_000, originalAmountMinor: 300_000,
      resolution: { kind: 'corrected', reason: 'Agreed: 72 minutes' } });
    await post(`statement-lines/${cost}/explain`, aeHead.auth, { reason: 'Sheets for the ATPL ride project' }).expect(200);

    const resent = await post(`statements/${august}/send`, aeHead.auth);
    expect(resent.body).toMatchObject({ status: 'sent', round: 2 });
    expect(resent.body.lines.map((l: Line) => l.status)).toEqual(['accepted', 'accepted', 'pending', 'pending']);
    expect((await statement(august, atplApprover.auth)).actions.answer).toBe(true);
    const accepted = await post(`statements/${august}/answer`, atplApprover.auth, {});
    expect(accepted.body).toMatchObject({ status: 'accepted', totalMinor: 895_000, accepted: { as: 'receiver', by: { publicId: atplApprover.personId } } });
    // the dispute thread of each line, oldest first
    const thread = (id: string) => line(accepted.body.lines, (l) => l.publicId === id) as unknown as { thread: { kind: string; round: number; reason: string;
      amountBeforeMinor: number | null; amountAfterMinor: number | null }[] };
    expect(thread(software).thread).toMatchObject([
      { kind: 'disputed', round: 1, reason: 'Only 1 hour was agreed', amountBeforeMinor: 300_000 },
      { kind: 'corrected', round: 1, reason: 'Agreed: 72 minutes', amountBeforeMinor: 300_000, amountAfterMinor: 240_000 },
    ]);
    expect(thread(cost).thread.map((e) => e.kind)).toEqual(['disputed', 'explained']);

    const disputes = (await http().get('/api/intercompany/reports/disputes').query({ from: '2025-08', to: '2025-08' }).set(atplHead.auth).expect(200)).body;
    expect(disputes.rows.map((r: { resolution: string }) => r.resolution).sort()).toEqual(['corrected', 'explained']);

    const invoiceNumber = `AE-IC-${tag()}`;
    await post(`statements/${august}/invoice`, aeHead.auth, { invoiceNumber, invoicedOn: todayIst() }).expect(200);
    // the receiver's side: the matching bill is in the balance until it is paid (due after the 30 payment days)
    const balance = (await http().get('/api/intercompany/reports/balance').set(atplHead.auth).expect(200)).body;
    expect(balance.rows).toEqual([expect.objectContaining({ provider: 'AE', receiver: 'ATPL', invoiceNumber, invoicedOn: todayIst(),
      dueOn: addDays(todayIst(), 30), amountMinor: 895_000, overdueDays: 0 })]);
    expect(balance.pairs).toEqual([{ provider: 'AE', receiver: 'ATPL', amountMinor: 895_000, overdueMinor: 0 }]);
    expect((await http().get('/api/intercompany/reports/balance').query({ format: 'csv' }).set(atplHead.auth)).text).toContain(invoiceNumber);
    expect((await http().get('/api/intercompany/reports/balance').set(outsider.auth)).body.rows).toEqual([]);
    const design180 = line(accepted.body.lines, (l) => l.rateMinor === 180_000).publicId;
    const credited = await post(`statement-lines/${design180}/correct`, aeHead.auth, { amountMinor: 150_000, reason: 'Rate from 16 Aug not yet signed' });
    expect(credited.status).toBe(200);
    expect(credited.body.status).toBe('invoiced');                                         // the invoiced statement stays as it is
    expect(line(credited.body.lines, (l) => l.publicId === design180)).toMatchObject({ amountMinor: 180_000, creditedMinor: 30_000,
      thread: [expect.objectContaining({ kind: 'credited', amountBeforeMinor: 180_000, amountAfterMinor: 150_000 })] });
  });

  it('no answer within the review days: accepted automatically by the daily job, and recorded', async () => {
    const built = await post(`agreements/${agreementId}/statements`, aeHead.auth, { year: 2025, month: 9 });
    september = built.body.publicId;
    expect(built.body.lines.map((l: Line) => [l.kind, l.amountMinor])).toEqual([['labour', 180_000], ['credit', -30_000]]);   // the credit from August
    expect((await post(`statements/${september}/approve`, aeHead.auth)).body.code).toBe('IC_NOT_APPROVER');
    await post(`statements/${september}/approve`, deptHead.auth).expect(200);
    await post(`statements/${september}/send`, aeHead.auth).expect(200);

    const job = app.get(StatementsService, { strict: false });
    expect(await job.acceptOverdue(addDays(todayIst(), 5))).toBe(0);   // the last review day: still open
    expect(await job.acceptOverdue(addDays(todayIst(), 6))).toBeGreaterThanOrEqual(1);
    expect(await statement(september)).toMatchObject({ status: 'accepted', totalMinor: 150_000, accepted: { as: 'automatic', by: null } });
    const audit = await db.query(`SELECT actor_person_id FROM core.audit_log a JOIN intercompany.ic_statements s ON s.public_id = a.entity_public_id
      WHERE a.action = 'intercompany.statement_accepted_automatically' AND s.public_id = $1`, [september]);
    expect(audit.rows).toEqual([{ actor_person_id: null }]);
  });

  it('margin and costs are the CEO\'s only', async () => {
    const q = { from: '2025-08', to: '2025-09' };
    const margin = await http().get('/api/intercompany/reports/margin').query(q).set(ceo);
    expect(margin.status).toBe(200);
    // August: billed 895,000; cost: 150 min and 60 min at ₹200 (50,000 + 20,000), 90 min at ₹100 (15,000), the cost at cost (100,000)
    expect(margin.body.rows.find((r: { month: string }) => r.month === '2025-08')).toMatchObject({ billedMinor: 895_000, costMinor: 185_000, marginMinor: 710_000, costMissing: false });
    const csv = await http().get('/api/intercompany/reports/margin').query({ ...q, format: 'csv' }).set(ceo).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    for (const who of [atplHead.auth, aeHead.auth, deptHead.auth]) expect((await http().get('/api/intercompany/reports/margin').query(q).set(who)).status).toBe(403);
    expect((await statement(august, ceo)).costMinor).toBe(185_000);
    const forReceiver = await statement(august, atplHead.auth);
    expect(forReceiver.costMinor).toBeNull();
    expect(forReceiver.lines.every((l: Line) => l.costMinor === null)).toBe(true);
  });

  it('reports and the CEO\'s cards', async () => {
    const q = { from: '2025-08', to: '2025-10' };
    const billed = (await http().get('/api/intercompany/reports/billed').query(q).set(atplHead.auth).expect(200)).body;
    expect(billed).toMatchObject({ totalMinor: 895_000 + 150_000, totalMinutes: 360 });
    const unbilled = (await http().get('/api/intercompany/reports/unbilled').query(q).set(atplHead.auth).expect(200)).body;
    expect(unbilled.rows.map((r: { month: string; ticket: { publicId: string }; minutes: number }) => [r.month, r.ticket.publicId, r.minutes])).toEqual([['2025-10', tA, 30]]);
    const cost = (await http().get('/api/intercompany/reports/receiver-cost').query(q).set(atplHead.auth).expect(200)).body;
    expect(cost.rows.find((r: { project: { publicId: string } | null }) => r.project?.publicId === project)).toMatchObject({ receiver: 'ATPL', minutes: 360, labourMinor: 975_000 });
    expect((await http().get('/api/intercompany/reports/billed').query({ ...q, format: 'csv' }).set(atplHead.auth)).text).toContain('TOTAL');
    expect((await http().get('/api/intercompany/reports/billed').query(q).set(outsider.auth)).body.rows).toEqual([]);

    const cards = (await http().get('/api/intercompany/dashboard').set(ceo).expect(200)).body;
    expect(cards.billedThisMonthMinor).toBeGreaterThanOrEqual(895_000 + 150_000);
    expect(cards.unbilledMinutes).toBeGreaterThanOrEqual(30);
    expect(cards.balances).toContainEqual({ provider: 'AE', receiver: 'ATPL', amountMinor: 895_000 });   // August invoiced, not paid
    expect((await http().get('/api/intercompany/dashboard').set(atplHead.auth)).status).toBe(403);

    await post(`statements/${august}/close`, aeHead.auth, { paidOn: todayIst(), paymentRef: 'UTR-TEST-1' }).expect(200);
    expect((await http().get('/api/intercompany/dashboard').set(ceo)).body.balances.find((b: { provider: string }) => b.provider === 'AE')).toBeUndefined();
    expect((await http().get('/api/intercompany/reports/balance').set(atplHead.auth)).body.rows).toEqual([]);
  });

  it('access, for the menu: who sees agreements and statements', async () => {
    const access = async (auth: Auth) => (await http().get('/api/intercompany/access').set(auth).expect(200)).body;
    expect(await access(ceo)).toMatchObject({ seesAll: true, manages: true, statements: true });
    expect(await access(atplHead.auth)).toEqual({ seesAll: false, manages: false, agreements: 1, statements: true });
    expect(await access(atplApprover.auth)).toEqual({ seesAll: false, manages: false, agreements: 0, statements: true });
    expect(await access(deptHead.auth)).toEqual({ seesAll: false, manages: false, agreements: 0, statements: true });
    expect(await access(outsider.auth)).toEqual({ seesAll: false, manages: false, agreements: 0, statements: false });
  });
});
