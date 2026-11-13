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
const PDF = Buffer.from('%PDF-1.4\n% made-up test bill\n%%EOF\n');
// The only file that makes intercompany agreements: one ATPL → AE agreement from 1 Jan 2026; March 2026 gets billed.

describe('Intercompany API', () => {
  let app: INestApplication;
  let db: pg.Client;
  let hr: Auth, admin: Auth, ceo: Auth, demoHead: Auth;
  let atplHead: Staff, aeHead: Staff, atplApprover: Staff, aeApprover: Staff, deptHead: Staff, outsider: Staff;
  let agreementId: string;
  let ticketId: string;
  let dept: string | undefined;
  const http = () => request(app.getHttpServer());
  const agreement = (auth: Auth) => http().get(`/api/intercompany/agreements/${agreementId}`).set(auth);
  const listed = async (auth: Auth) => (await http().get('/api/intercompany/agreements').set(auth).expect(200)).body.map((a: { publicId: string }) => a.publicId);
  const rate = (body: Record<string, unknown>) => http().post(`/api/intercompany/agreements/${agreementId}/rate-cards`).set(ceo).send(body);
  const addCost = (auth: Auth, f: Record<string, string | number>, bill?: Buffer) => {
    let req = http().post(`/api/intercompany/agreements/${agreementId}/passed-costs`).set(auth);
    for (const [k, v] of Object.entries(f)) req = req.field(k, String(v));
    if (bill) req = req.attach('bill', bill, { filename: 'bill.pdf', contentType: 'application/pdf' });
    return req;
  };

  beforeAll(async () => {
    app = await createTestApp(AppModule);
    [hr, admin, ceo, demoHead] = await Promise.all([DEMO.hr, DEMO.admin, DEMO.ceo, DEMO.head].map((d) => signIn(app, d.login)));
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    [atplHead, aeHead, atplApprover, aeApprover, deptHead, outsider] = await Promise.all([
      newStaff(app, hr, admin, ['ATPL']), newStaff(app, hr, admin, ['AE']), newStaff(app, hr, admin, ['ATPL']), newStaff(app, hr, admin, ['AE']),
      newStaff(app, hr, admin, ['ATPL']), newStaff(app, hr, admin, ['ATPL']),
    ]);

    const created = await http().post('/api/intercompany/agreements').set(ceo).send({
      publicId: randomUUID(),
      provider: { company: 'ATPL', headEmploymentPublicId: atplHead.jobs.ATPL, approverEmploymentPublicId: atplApprover.jobs.ATPL },
      receiver: { company: 'AE', headEmploymentPublicId: aeHead.jobs.AE, approverEmploymentPublicId: aeApprover.jobs.AE },
      services: ['design', 'software'], pricingMethod: 'rate_card', startDate: '2026-01-01',
    });
    expect(created.status).toBe(201);
    agreementId = created.body.publicId;

    // a ticket of ATPL's Software Development (ATS) headed by deptHead (Manager role), created by that head. Other tests
    // expect exactly the seeded ATPL departments, so none is added; the head is taken off again in afterAll.
    await http().post('/api/core/role-assignments').set(admin).send({ personPublicId: deptHead.personId, roleCode: 'manager', scope: 'team' }).expect(201);
    dept = (await http().get('/api/hrms/departments').query({ company: 'ATPL' }).set(hr).expect(200)).body.find((d: { codePrefix: string }) => d.codePrefix === 'ATS').publicId;
    await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: deptHead.personId }).expect(200);
    const design = (await http().get('/api/tickets/types').query({ company: 'ATPL' }).set(hr)).body.find((t: { code: string }) => t.code === 'design').publicId;
    ticketId = (await http().post('/api/tickets').set(deptHead.auth).send({ company: 'ATPL', typePublicId: design, title: `Ride design ${tag()}`,
      departmentPublicId: dept, scheduledAt: '2026-03-10T04:00:00.000Z' }).expect(201)).body.publicId;
  }, 90_000);
  afterAll(async () => {
    if (dept) await http().patch(`/api/hrms/departments/${dept}`).set(hr).send({ headPublicId: null }); // leave no head behind for other tests
    await db?.end();
    await app?.close();
  });

  it('a new agreement is a draft with the review and payment days from policy (5 and 30); sent again it is stored once', async () => {
    const res = await agreement(ceo).expect(200);
    expect(res.body).toMatchObject({ status: 'draft', reviewDays: 5, paymentTermsDays: 30, pricingMethod: 'rate_card', costPlusPercent: null,
      passedCostHandling: 'at_cost', provider: { company: 'ATPL', head: { employmentPublicId: atplHead.jobs.ATPL } },
      receiver: { company: 'AE', head: { employmentPublicId: aeHead.jobs.AE } } });
    const again = await http().post('/api/intercompany/agreements').set(ceo).send({ publicId: agreementId,
      provider: { company: 'ATPL', headEmploymentPublicId: atplHead.jobs.ATPL, approverEmploymentPublicId: atplApprover.jobs.ATPL },
      receiver: { company: 'AE', headEmploymentPublicId: aeHead.jobs.AE, approverEmploymentPublicId: aeApprover.jobs.AE },
      services: ['design'], pricingMethod: 'rate_card', startDate: '2026-01-01' });
    expect([again.status, again.body.publicId]).toEqual([200, agreementId]);
    await http().patch(`/api/intercompany/agreements/${agreementId}`).set(ceo).send({ status: 'active' }).expect(200);
  });

  it('only the two companies\' heads and the CEO see the agreement', async () => {
    for (const who of [atplHead.auth, aeHead.auth, ceo]) {
      expect((await agreement(who)).status).toBe(200);
      expect(await listed(who)).toContain(agreementId);
    }
    for (const who of [hr, demoHead, outsider.auth, deptHead.auth]) {
      const res = await agreement(who);
      expect([res.status, res.body.code]).toEqual([404, 'IC_AGREEMENT_NOT_FOUND']);
      expect(await listed(who)).not.toContain(agreementId);
    }
    expect((await http().get(`/api/intercompany/agreements/${agreementId}/rate-cards`).set(hr)).status).toBe(404);
    // a head cannot change it: that is the CEO's (intercompany.manage)
    expect((await http().patch(`/api/intercompany/agreements/${agreementId}`).set(atplHead.auth).send({ reviewDays: 7 })).status).toBe(403);
  });

  it('a heads\' or approvers\' job must be in their side\'s company; the companies must differ', async () => {
    const send = (provider: Record<string, string>, receiver: Record<string, string>) => http().post('/api/intercompany/agreements').set(ceo)
      .send({ provider, receiver, services: ['cgi'], pricingMethod: 'cost_plus', costPlusPercent: 12.5, startDate: '2026-01-01' });
    const wrong = await send({ company: 'ATPL', headEmploymentPublicId: aeHead.jobs.AE, approverEmploymentPublicId: atplApprover.jobs.ATPL },
      { company: 'AE', headEmploymentPublicId: aeHead.jobs.AE, approverEmploymentPublicId: aeApprover.jobs.AE });
    expect([wrong.status, wrong.body.code]).toEqual([400, 'IC_JOB_OTHER_COMPANY']);
    const same = await send({ company: 'AE', headEmploymentPublicId: aeHead.jobs.AE, approverEmploymentPublicId: aeApprover.jobs.AE },
      { company: 'AE', headEmploymentPublicId: aeHead.jobs.AE, approverEmploymentPublicId: aeApprover.jobs.AE });
    expect([same.status, same.body.code]).toEqual([400, 'VALIDATION']);
  });

  it('rate in force by date: a new rate is a new row; earlier dates keep the earlier rate', async () => {
    expect((await rate({ serviceType: 'design', rateMinor: 150_000, effectiveFrom: '2026-01-01' })).status).toBe(201);
    expect((await rate({ serviceType: 'design', rateMinor: 180_000, effectiveFrom: '2026-06-01' })).status).toBe(201);
    expect((await rate({ grade: 'G2', rateMinor: 90_000, effectiveFrom: '2026-02-01' })).status).toBe(201);
    const on = async (date: string) => (await http().get(`/api/intercompany/agreements/${agreementId}/rate-cards`).query({ on: date }).set(aeHead.auth).expect(200)).body
      .map((c: { serviceType: string | null; grade: string | null; rateMinor: number }) => [c.serviceType ?? c.grade, c.rateMinor]);
    expect(await on('2026-01-15')).toEqual([['design', 150_000]]);
    expect(await on('2026-05-31')).toEqual(expect.arrayContaining([['design', 150_000], ['G2', 90_000]]));
    expect(await on('2026-06-01')).toEqual(expect.arrayContaining([['design', 180_000], ['G2', 90_000]]));
    expect((await agreement(ceo)).body.rateCards).toHaveLength(3);    // every row stays

    const dup = await rate({ serviceType: 'design', rateMinor: 1, effectiveFrom: '2026-06-01' });
    expect([dup.status, dup.body.code]).toEqual([409, 'IC_RATE_EXISTS']);
    const notCovered = await rate({ serviceType: 'cgi', rateMinor: 1, effectiveFrom: '2026-06-01' });
    expect([notCovered.status, notCovered.body.code]).toEqual([400, 'IC_SERVICE_NOT_COVERED']);
    expect((await rate({ rateMinor: 1, effectiveFrom: '2026-06-01' })).status).toBe(400);   // a service type or a grade
  });

  it('billable default from the link: a ticket linked to the other company\'s project is billable to it', async () => {
    const before = await http().get(`/api/intercompany/tickets/${ticketId}/billing`).set(deptHead.auth).expect(200);
    expect(before.body).toMatchObject({ link: null, billableTo: null, billable: false });

    const project = randomUUID();
    const linked = await http().put(`/api/intercompany/tickets/${ticketId}/link`).set(deptHead.auth).send({ kind: 'project', publicId: project, company: 'AE', serviceType: 'design' });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ ticket: { publicId: ticketId, company: 'ATPL' }, link: { kind: 'project', publicId: project },
      billableTo: 'AE', serviceType: 'design', billable: true, notBillableReason: null, changedBy: { publicId: deptHead.personId } });

    const own = await http().put(`/api/intercompany/tickets/${ticketId}/link`).set(deptHead.auth).send({ kind: 'design_request', publicId: randomUUID(), company: 'ATPL', serviceType: 'design' });
    expect([own.status, own.body.code]).toEqual([400, 'IC_SAME_COMPANY']);
    // only the head of the ticket's department (or the CEO) links it
    const other = await http().put(`/api/intercompany/tickets/${ticketId}/link`).set(atplHead.auth).send({ kind: 'project', publicId: project, company: 'AE', serviceType: 'design' });
    expect([other.status, other.body.code]).toEqual([403, 'IC_NOT_DEPARTMENT_HEAD']);
  });

  it('not billable needs a reason; it is audited; linking again to the same company keeps the decision', async () => {
    const noReason = await http().post(`/api/intercompany/tickets/${ticketId}/billable`).set(deptHead.auth).send({ billable: false });
    expect([noReason.status, noReason.body.code]).toEqual([400, 'VALIDATION']);
    const notHead = await http().post(`/api/intercompany/tickets/${ticketId}/billable`).set(outsider.auth).send({ billable: false, reason: 'Warranty rework' });
    expect(notHead.status).toBe(403);

    const res = await http().post(`/api/intercompany/tickets/${ticketId}/billable`).set(deptHead.auth).send({ billable: false, reason: 'Warranty rework' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ billableTo: 'AE', billable: false, notBillableReason: 'Warranty rework' });
    const audit = await db.query(`SELECT a.summary, a.details FROM core.audit_log a JOIN core.persons p ON p.id = a.actor_person_id
      WHERE a.action = 'intercompany.ticket_not_billable' AND a.entity_public_id = $1 AND p.public_id = $2`, [ticketId, deptHead.personId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toMatchObject({ reason: 'Warranty rework', billableTo: 'AE', before: { billable: true } });

    const relinked = await http().put(`/api/intercompany/tickets/${ticketId}/link`).set(deptHead.auth).send({ kind: 'design_request', publicId: randomUUID(), company: 'AE', serviceType: 'design' });
    expect(relinked.body).toMatchObject({ link: { kind: 'design_request' }, billable: false, notBillableReason: 'Warranty rework' });
  });

  it('costs passed on count only with a bill; the receiver\'s head cannot record them', async () => {
    const noBill = await addCost(atplHead.auth, { publicId: randomUUID(), description: 'Acrylic sheets for the AE ride', amountMinor: 1_250_000, incurredOn: '2026-04-10' });
    expect(noBill.status).toBe(201);
    expect(noBill.body).toMatchObject({ amountMinor: 1_250_000, currency: 'INR', bill: null, counted: false });
    const withBill = await addCost(atplHead.auth, { description: 'Courier', amountMinor: 50_000, incurredOn: '2026-04-12' }, PDF);
    expect(withBill.body).toMatchObject({ counted: true, bill: { fileType: 'pdf' } });

    const april = async () => (await http().get(`/api/intercompany/agreements/${agreementId}/passed-costs`).query({ month: '2026-04' }).set(aeHead.auth).expect(200)).body;
    expect(await april()).toMatchObject({ countedMinor: 50_000, waitingForBillMinor: 1_250_000 });

    await http().post(`/api/intercompany/passed-costs/${noBill.body.publicId}/bill`).set(atplHead.auth).attach('bill', PDF, { filename: 'b.pdf', contentType: 'application/pdf' }).expect(200);
    expect(await april()).toMatchObject({ countedMinor: 1_300_000, waitingForBillMinor: 0 });
    const file = await http().get(`/api/intercompany/passed-costs/${noBill.body.publicId}/bill`).set(aeHead.auth).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');

    const receiver = await addCost(aeHead.auth, { description: 'Not theirs', amountMinor: 100, incurredOn: '2026-04-12' });
    expect([receiver.status, receiver.body.code]).toEqual([403, 'IC_NOT_PROVIDER_HEAD']);
    const notText = await addCost(atplHead.auth, { description: 'Bad file', amountMinor: 100, incurredOn: '2026-04-12' }, Buffer.from('not a bill'));
    expect([notText.status, notText.body.code]).toEqual([400, 'IC_BILL_TYPE']);
  });

  it('billed months can\'t change: no cost, no rate reaching back, no ticket billing with time in them', async () => {
    // the ticket has time on 10 March 2026 (written directly: the test does not punch)
    await db.query(`INSERT INTO tickets.ticket_time_allocations (tenant_id, ticket_id, employment_id, legal_entity_id, person_id, work_date, minutes)
      SELECT 1, t.id, e.id, e.legal_entity_id, e.person_id, DATE '2026-03-10', 120 FROM tickets.tickets t, hrms.employments e
       WHERE t.public_id = $1 AND e.public_id = $2`, [ticketId, deptHead.jobs.ATPL]);
    const billed = await http().post(`/api/intercompany/agreements/${agreementId}/billed-months`).set(ceo).send({ year: 2026, month: 3 });
    expect(billed.status).toBe(201);
    expect(billed.body.billedMonths).toEqual([expect.objectContaining({ year: 2026, month: 3, billedBy: expect.objectContaining({ publicId: DEMO.ceo.publicId }) })]);
    expect((await http().post(`/api/intercompany/agreements/${agreementId}/billed-months`).set(ceo).send({ year: 2026, month: 3 })).status).toBe(200);

    const cost = await addCost(atplHead.auth, { description: 'Late bill', amountMinor: 100, incurredOn: '2026-03-31' });
    expect([cost.status, cost.body.code]).toEqual([409, 'IC_MONTH_BILLED']);
    const back = await rate({ grade: 'G2', rateMinor: 95_000, effectiveFrom: '2026-03-15' });
    expect([back.status, back.body.code]).toEqual([409, 'IC_MONTH_BILLED']);
    expect((await rate({ grade: 'G2', rateMinor: 95_000, effectiveFrom: '2026-04-01' })).status).toBe(201);
    const ticket = await http().post(`/api/intercompany/tickets/${ticketId}/billable`).set(deptHead.auth).send({ billable: true });
    expect([ticket.status, ticket.body.code]).toEqual([409, 'IC_MONTH_BILLED']);
    const pricing = await http().patch(`/api/intercompany/agreements/${agreementId}`).set(ceo).send({ pricingMethod: 'cost_plus', costPlusPercent: 10 });
    expect([pricing.status, pricing.body.code]).toEqual([409, 'IC_MONTH_BILLED']);
    expect((await http().patch(`/api/intercompany/agreements/${agreementId}`).set(ceo).send({ paymentTermsDays: 45 }).expect(200)).body.paymentTermsDays).toBe(45);
  });
});
