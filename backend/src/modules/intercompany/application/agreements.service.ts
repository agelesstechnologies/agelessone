import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AddPassedCostRequest, AddRateCardRequest, AgreementsQuery, CreateAgreementRequest, IcAgreement, IcAgreementDetail, IcPassedCost, IcPassedCostList,
  IcRateCard, MarkMonthBilledRequest, PassedCostsQuery, RateCardsQuery, UpdateAgreementRequest,
} from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext, requireAll } from '../../../platform/http/request-context';
import { CONTENT_TYPES, detectDocumentType, discardUpload, DocumentType, readUpload, saveUpload } from '../../../platform/storage';
import { todayIst } from '../../../platform/time';
import { rupees } from '../../../platform/csv';
import { CoreFacade } from '../../core/core.facade';
import { AgreementRow, IntercompanyRepository, JobRow, PersonRow } from '../infrastructure/intercompany.repository';
import {
  AgreementStatus, billedMonthOf, billedMonthReachedBy, billMonthProblem, canRecordCosts, canSeeAgreement, Head, isCurrentJob, monthEnd, monthLabel,
  monthOf, monthStart, pricingChanged, statusChangeProblem, Terms, termsProblem, YearMonth,
} from '../domain/agreements';
import { ratesInForce } from '../domain/rates';
import { INTERCOMPANY } from '../domain/permissions';

/** An uploaded bill as multer keeps it in memory. */
export interface BillUpload { buffer: Buffer; size: number }

type Row = Omit<AgreementRow, 'provider' | 'providerName' | 'receiver' | 'receiverName'>;
type Side = 'provider' | 'receiver';
type JobColumn = 'providerHeadEmploymentId' | 'providerApproverEmploymentId' | 'receiverHeadEmploymentId' | 'receiverApproverEmploymentId';
const ROLE_LABEL = { head: 'head', approver: 'approver' } as const;

/**
 * Agreements between two companies of the group (ATPL provides, AE receives), their rate cards, the months already
 * billed, and the costs passed on. Seen only by the two companies' heads named on the agreement and the CEO (scope all);
 * changed only by the CEO (intercompany.manage); costs are recorded by the provider's head. Every change is audited.
 */
@Injectable()
export class AgreementsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(IntercompanyRepository) private readonly repo: IntercompanyRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  health() { return { module: 'intercompany', ok: true }; }

  // ---- agreements ----

  async list(ctx: RequestContext, q: AgreementsQuery): Promise<IcAgreement[]> {
    const rows = await this.repo.agreements(this.db, ctx.tenantId, q);
    const jobs = await this.repo.jobs(this.db, rows.flatMap(jobIds));
    const visible = rows.filter((r) => this.sees(ctx, r, jobs));
    const people = await this.repo.persons(this.db, visible.flatMap((r) => [r.createdBy, r.updatedBy]));
    return visible.map((r) => toAgreement(r, jobs, people));
  }

  async get(ctx: RequestContext, publicId: string): Promise<IcAgreementDetail> {
    await this.visible(ctx, publicId);
    return this.detail(ctx.tenantId, publicId);
  }

  /**
   * A new agreement, as a draft. Heads and approvers must hold a job in their side's company. Review and payment days
   * left out: the provider's policy on the start date. The same publicId again: the stored agreement.
   */
  async create(ctx: RequestContext, req: CreateAgreementRequest): Promise<{ agreement: IcAgreementDetail; created: boolean }> {
    requireAll(ctx, INTERCOMPANY.manage);
    const publicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const tenant = await this.repo.agreementTenant(req.publicId);
      if (tenant === ctx.tenantId) return { agreement: await this.detail(ctx.tenantId, publicId), created: false };
      if (tenant !== undefined) throw new AppError('IC_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const provider = await this.company(ctx, req.provider.company);
    const receiver = await this.company(ctx, req.receiver.company);
    const job = (side: Side, role: keyof typeof ROLE_LABEL, publicIdOfJob: string, companyId: number, code: string) =>
      this.jobIn(ctx, publicIdOfJob, companyId, `The ${side}'s ${ROLE_LABEL[role]}`, code);
    const [providerHead, providerApprover, receiverHead, receiverApprover] = [
      await job('provider', 'head', req.provider.headEmploymentPublicId, provider.id, provider.code),
      await job('provider', 'approver', req.provider.approverEmploymentPublicId, provider.id, provider.code),
      await job('receiver', 'head', req.receiver.headEmploymentPublicId, receiver.id, receiver.code),
      await job('receiver', 'approver', req.receiver.approverEmploymentPublicId, receiver.id, receiver.code),
    ];
    // POLICY intercompany.review_days (5) and intercompany.payment_terms_days (30): the provider's, on the start date
    const reviewDays = req.reviewDays ?? await this.core.getPolicy(ctx.tenantId, 'intercompany.review_days', provider.id, req.startDate);
    const paymentTermsDays = req.paymentTermsDays ?? await this.core.getPolicy(ctx.tenantId, 'intercompany.payment_terms_days', provider.id, req.startDate);
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.insertAgreement(tx, {
          tenantId: ctx.tenantId, publicId, legalEntityId: provider.id, receiverLegalEntityId: receiver.id, services: req.services,
          pricingMethod: req.pricingMethod, costPlusPercent: percentText(req.costPlusPercent), passedCostHandling: req.passedCostHandling,
          passedCostPercent: percentText(req.passedCostPercent), reviewDays, paymentTermsDays,
          providerHeadEmploymentId: providerHead.id, providerApproverEmploymentId: providerApprover.id,
          receiverHeadEmploymentId: receiverHead.id, receiverApproverEmploymentId: receiverApprover.id,
          startDate: req.startDate, status: 'draft', createdBy: ctx.personId,
        });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'intercompany.agreement_created', entity: 'ic_agreement',
          entityPublicId: publicId, legalEntityId: provider.id,
          summary: `Intercompany agreement ${provider.code} → ${receiver.code} drafted (${req.pricingMethod}, from ${req.startDate})`,
          details: { services: req.services, pricingMethod: req.pricingMethod, costPlusPercent: req.costPlusPercent ?? null, reviewDays, paymentTermsDays } });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'ic_agreements_public_id_unique') return this.create(ctx, req);   // the same request twice at once
      throw err;
    }
    return { agreement: await this.detail(ctx.tenantId, publicId), created: true };
  }

  /**
   * Change terms, people, dates or status (draft → active → ended). An ended agreement never changes; once a month is
   * billed the pricing terms stay; the start date moves only while a draft. Audited with what changed.
   */
  async update(ctx: RequestContext, publicId: string, req: UpdateAgreementRequest): Promise<IcAgreementDetail> {
    requireAll(ctx, INTERCOMPANY.manage);
    try {
      await this.db.transaction(async (tx) => {
        const a = await this.repo.lockAgreement(tx, ctx.tenantId, publicId);
        if (!a) throw notFound();
        if (a.status === 'ended') throw new AppError('IC_AGREEMENT_ENDED', 409, 'An ended agreement no longer changes');
        const billed = await this.repo.billedMonths(tx, a.id);
        const before = termsOf(a);
        const after: Terms = {
          services: req.services ?? before.services, pricingMethod: req.pricingMethod ?? before.pricingMethod,
          costPlusPercent: req.costPlusPercent !== undefined ? req.costPlusPercent : before.costPlusPercent,
          passedCostHandling: req.passedCostHandling ?? before.passedCostHandling,
          passedCostPercent: req.passedCostPercent !== undefined ? req.passedCostPercent : before.passedCostPercent,
        };
        const problem = termsProblem(after);
        if (problem === 'IC_COST_PLUS_PERCENT') throw new AppError(problem, 400, 'Cost plus pricing needs its percentage, and only cost plus has one');
        if (problem) throw new AppError(problem, 400, 'Percent handling of passed-on costs needs its percentage, and only percent has one');
        if (billed.length > 0 && pricingChanged(before, after)) {
          throw new AppError('IC_MONTH_BILLED', 409, `Months are billed (latest ${monthLabel(billed[0])}): the pricing terms stay; end this agreement and start a new one`);
        }
        if (req.startDate !== undefined && req.startDate !== a.startDate && a.status !== 'draft') {
          throw new AppError('IC_START_DATE_FIXED', 409, 'The start date changes only while the agreement is a draft');
        }
        const status = req.status ?? (a.status as AgreementStatus);
        const statusProblem = statusChangeProblem(a.status as AgreementStatus, status);
        if (statusProblem) throw new AppError(statusProblem, 409, `An agreement goes draft → active → ended; it cannot go from ${a.status} to ${status}`);
        const startDate = req.startDate ?? a.startDate;
        if (req.endDate !== undefined) {
          if (req.endDate < startDate) throw new AppError('IC_END_BEFORE_START', 400, 'The end date is before the start date');
          const last = billed[0];
          if (last && monthEnd(last) > req.endDate) throw new AppError('IC_MONTH_BILLED', 409, `${monthLabel(last)} is billed: the agreement ends on its last day or later`);
        }
        const [codes] = await this.repo.agreements(tx, ctx.tenantId, { id: a.id });
        const oldJobs = await this.repo.jobs(tx, jobIds(a));
        const people: Partial<Record<JobColumn, number>> = {};
        const peopleChanges: Record<string, [string | null, string]> = {};
        const roles: [JobColumn, string | undefined, string, number, string][] = [
          ['providerHeadEmploymentId', req.providerHeadEmploymentPublicId, 'The provider\'s head', a.legalEntityId, codes.provider],
          ['providerApproverEmploymentId', req.providerApproverEmploymentPublicId, 'The provider\'s approver', a.legalEntityId, codes.provider],
          ['receiverHeadEmploymentId', req.receiverHeadEmploymentPublicId, 'The receiver\'s head', a.receiverLegalEntityId, codes.receiver],
          ['receiverApproverEmploymentId', req.receiverApproverEmploymentPublicId, 'The receiver\'s approver', a.receiverLegalEntityId, codes.receiver],
        ];
        for (const [column, jobPublicId, who, companyId, code] of roles) {
          if (!jobPublicId) continue;
          const j = await this.jobIn(ctx, jobPublicId, companyId, who, code);
          if (j.id === a[column]) continue;
          people[column] = j.id;
          peopleChanges[column.replace('EmploymentId', 'Employment')] = [oldJobs.get(a[column])?.publicId ?? null, j.publicId];
        }

        const patch = {
          services: after.services, pricingMethod: after.pricingMethod, costPlusPercent: percentText(after.costPlusPercent),
          passedCostHandling: after.passedCostHandling, passedCostPercent: percentText(after.passedCostPercent),
          reviewDays: req.reviewDays ?? a.reviewDays, paymentTermsDays: req.paymentTermsDays ?? a.paymentTermsDays,
          startDate, status, endDate: req.endDate ?? a.endDate,
        };
        const changes = { ...changedFields(a, patch), ...peopleChanges };
        if (Object.keys(changes).length === 0) return;
        await this.repo.updateAgreement(tx, a.id, { ...patch, ...people, updatedBy: ctx.personId, updatedAt: new Date() });
        const statusChanged = status !== a.status;
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId,
          action: statusChanged ? (status === 'active' ? 'intercompany.agreement_activated' : 'intercompany.agreement_ended') : 'intercompany.agreement_changed',
          entity: 'ic_agreement', entityPublicId: publicId, legalEntityId: a.legalEntityId,
          summary: `Intercompany agreement ${codes.provider} → ${codes.receiver} ${statusChanged ? `made ${status}` : 'changed'}: ${Object.keys(changes).join(', ')}`,
          details: changes });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'ic_agreements_one_active') {
        throw new AppError('IC_ACTIVE_AGREEMENT_EXISTS', 409, 'These two companies already have an active agreement: end it first');
      }
      throw err;
    }
    return this.detail(ctx.tenantId, publicId);
  }

  // ---- rate cards ----

  /** Every rate (newest first), or with `on` the rate in force that day for each service type and grade. */
  async rateCards(ctx: RequestContext, publicId: string, q: RateCardsQuery): Promise<IcRateCard[]> {
    const a = await this.visible(ctx, publicId);
    const cards = await this.repo.rateCards(this.db, a.id);
    const shown = q.on ? ratesInForce(cards, q.on) : cards;
    const people = await this.repo.persons(this.db, shown.map((c) => c.createdBy));
    return shown.map((c) => toRateCard(c, people));
  }

  /**
   * A new rate for a service type the agreement covers, or a grade, from a date. Nothing is edited: a change is a new
   * row, and it never reaches back into a billed month (IC_MONTH_BILLED). CA TO CONFIRM.
   */
  async addRateCard(ctx: RequestContext, publicId: string, req: AddRateCardRequest): Promise<{ rateCard: IcRateCard; created: boolean }> {
    requireAll(ctx, INTERCOMPANY.manage);
    const ratePublicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const owner = await this.repo.rateTenant(req.publicId);
      if (owner && owner.tenantId !== ctx.tenantId) throw new AppError('IC_DUPLICATE_ID', 409, 'This publicId is already used');
      if (owner) return { rateCard: await this.rateCard(owner.agreementId, req.publicId), created: false };
    }
    let agreementId = 0;
    try {
      await this.db.transaction(async (tx) => {
        const a = await this.repo.lockAgreement(tx, ctx.tenantId, publicId);
        if (!a) throw notFound();
        agreementId = a.id;
        if (a.status === 'ended') throw new AppError('IC_AGREEMENT_ENDED', 409, 'An ended agreement no longer changes');
        if (req.serviceType && !a.services.includes(req.serviceType)) {
          throw new AppError('IC_SERVICE_NOT_COVERED', 400, `The agreement does not cover ${req.serviceType}`);
        }
        const reached = billedMonthReachedBy(await this.repo.billedMonths(tx, a.id), req.effectiveFrom);
        if (reached) throw new AppError('IC_MONTH_BILLED', 409, `${monthLabel(reached)} is billed: a new rate starts after it`);
        await this.repo.insertRateCard(tx, { tenantId: ctx.tenantId, publicId: ratePublicId, agreementId: a.id, legalEntityId: a.legalEntityId,
          serviceType: req.serviceType ?? null, grade: req.grade ?? null, rateMinor: req.rateMinor, currency: req.currency,
          effectiveFrom: req.effectiveFrom, createdBy: ctx.personId });
        const item = req.serviceType ?? `grade ${req.grade}`;
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'intercompany.rate_added', entity: 'ic_rate_card',
          entityPublicId: ratePublicId, legalEntityId: a.legalEntityId,
          summary: `Intercompany rate for ${item}: ${rupees(req.rateMinor)} an hour from ${req.effectiveFrom}`,
          details: { agreementPublicId: publicId, serviceType: req.serviceType ?? null, grade: req.grade ?? null, rateMinor: req.rateMinor, effectiveFrom: req.effectiveFrom } });
      });
    } catch (err) {
      const broken = violatedConstraint(err);
      if (broken === 'ic_rate_cards_item_from_unique') throw new AppError('IC_RATE_EXISTS', 409, 'There is already a rate for this from that date');
      if (broken === 'ic_rate_cards_public_id_unique') return this.addRateCard(ctx, publicId, req);
      throw err;
    }
    return { rateCard: await this.rateCard(agreementId, ratePublicId), created: true };
  }

  // ---- billed months ----

  /** A finished month inside the agreement's dates is billed: from now on nothing in it changes. Again: no change. */
  async markBilled(ctx: RequestContext, publicId: string, req: MarkMonthBilledRequest): Promise<{ agreement: IcAgreementDetail; created: boolean }> {
    requireAll(ctx, INTERCOMPANY.manage);
    let created = false;
    await this.db.transaction(async (tx) => {
      const a = await this.repo.lockAgreement(tx, ctx.tenantId, publicId);
      if (!a) throw notFound();
      if (a.status === 'draft') throw new AppError('IC_AGREEMENT_NOT_ACTIVE', 409, 'A draft agreement bills nothing: make it active first');
      if ((await this.repo.billedMonths(tx, a.id)).some((b) => b.year === req.year && b.month === req.month)) return;
      const problem = billMonthProblem(req, a, todayIst());
      if (problem === 'IC_MONTH_OUTSIDE_AGREEMENT') throw new AppError(problem, 400, `${monthLabel(req)} is outside the agreement's dates`);
      if (problem) throw new AppError(problem, 409, `${monthLabel(req)} is not over yet`);
      await this.repo.insertBilledMonth(tx, { tenantId: ctx.tenantId, agreementId: a.id, legalEntityId: a.legalEntityId, year: req.year, month: req.month, billedBy: ctx.personId });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'intercompany.month_billed', entity: 'ic_agreement',
        entityPublicId: publicId, legalEntityId: a.legalEntityId, summary: `Intercompany month ${monthLabel(req)} billed: it no longer changes`,
        details: { year: req.year, month: req.month } });
      created = true;
    });
    return { agreement: await this.detail(ctx.tenantId, publicId), created };
  }

  // ---- passed-on costs ----

  async passedCosts(ctx: RequestContext, publicId: string, q: PassedCostsQuery): Promise<IcPassedCostList> {
    const a = await this.visible(ctx, publicId);
    const m = q.month ? monthOf(`${q.month}-01`) : undefined;
    const rows = await this.repo.passedCosts(this.db, a.id, m ? { from: monthStart(m), to: monthEnd(m) } : {});
    const people = await this.repo.persons(this.db, rows.flatMap((r) => [r.createdBy, r.billUploadedBy]));
    const costs = rows.map((r) => toCost(r, publicId, people));
    const sum = (counted: boolean) => costs.filter((c) => c.counted === counted).reduce((s, c) => s + c.amountMinor, 0);
    return { rows: costs, currency: 'INR', countedMinor: sum(true), waitingForBillMinor: sum(false) };
  }

  /**
   * A cost the provider paid for the receiver, on a date inside the agreement (not a billed month), with its bill now or
   * later; it counts only once the bill is attached. The provider's head or the CEO. The same publicId again: the stored cost.
   */
  async addPassedCost(ctx: RequestContext, publicId: string, req: AddPassedCostRequest, bill?: BillUpload): Promise<{ cost: IcPassedCost; created: boolean }> {
    const a = await this.visible(ctx, publicId);
    await this.requireCostRecorder(ctx, a);
    const costPublicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const owner = await this.repo.costOwner(req.publicId);
      if (owner && (owner.tenantId !== ctx.tenantId || owner.agreementId !== a.id)) throw new AppError('IC_DUPLICATE_ID', 409, 'This publicId is already used');
      if (owner) return { cost: await this.cost(ctx, req.publicId), created: false };
    }
    if (a.status === 'draft') throw new AppError('IC_AGREEMENT_NOT_ACTIVE', 409, 'A draft agreement takes no costs: make it active first');
    if (req.incurredOn < a.startDate || (a.endDate !== null && req.incurredOn > a.endDate)) {
      throw new AppError('IC_DATE_OUTSIDE_AGREEMENT', 400, `${req.incurredOn} is outside the agreement's dates`);
    }
    const type = bill ? billType(bill) : null;
    const billPath = bill && type ? await saveUpload('intercompany-bills', type, bill.buffer) : null;
    try {
      await this.db.transaction(async (tx) => {
        const locked = (await this.repo.lockAgreementById(tx, a.id))!;
        this.requireOpenMonth(await this.repo.billedMonths(tx, locked.id), req.incurredOn);
        await this.repo.insertPassedCost(tx, { tenantId: ctx.tenantId, publicId: costPublicId, agreementId: a.id, legalEntityId: a.legalEntityId,
          projectPublicId: req.projectPublicId ?? null, description: req.description, amountMinor: req.amountMinor, currency: req.currency,
          incurredOn: req.incurredOn, createdBy: ctx.personId,
          ...(billPath && type ? { billPath, billType: type, billUploadedBy: ctx.personId, billUploadedAt: new Date() } : {}) });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'intercompany.cost_added', entity: 'ic_passed_cost',
          entityPublicId: costPublicId, legalEntityId: a.legalEntityId,
          summary: `Passed-on cost ${rupees(req.amountMinor)} on ${req.incurredOn}${billPath ? ' with its bill' : ', bill to follow'}: ${req.description}`,
          details: { agreementPublicId: publicId, amountMinor: req.amountMinor, incurredOn: req.incurredOn, bill: billPath !== null } });
      });
    } catch (err) {
      if (billPath) await discardUpload(billPath);
      if (violatedConstraint(err) === 'ic_passed_costs_public_id_unique') return this.addPassedCost(ctx, publicId, req);
      throw err;
    }
    return { cost: await this.cost(ctx, costPublicId), created: true };
  }

  /** Attach (or replace) a cost's bill — then it counts. Not in a billed month. The provider's head or the CEO. */
  async attachBill(ctx: RequestContext, costPublicId: string, bill?: BillUpload): Promise<IcPassedCost> {
    if (!bill) throw new AppError('IC_BILL_REQUIRED', 400, 'Attach the bill (file field `bill`: JPEG, PNG or PDF)');
    const found = await this.repo.findCost(this.db, ctx.tenantId, costPublicId);
    if (!found) throw new AppError('IC_COST_NOT_FOUND', 404, 'Passed-on cost not found');
    const a = await this.visibleById(ctx, found.agreementId, () => new AppError('IC_COST_NOT_FOUND', 404, 'Passed-on cost not found'));
    await this.requireCostRecorder(ctx, a);
    const type = billType(bill);
    const billPath = await saveUpload('intercompany-bills', type, bill.buffer);
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.lockAgreementById(tx, a.id);
        const cost = (await this.repo.findCost(tx, ctx.tenantId, costPublicId))!;
        this.requireOpenMonth(await this.repo.billedMonths(tx, a.id), cost.incurredOn);
        await this.repo.setBill(tx, cost.id, { billPath, billType: type, billUploadedBy: ctx.personId });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: cost.billPath ? 'intercompany.bill_replaced' : 'intercompany.bill_attached',
          entity: 'ic_passed_cost', entityPublicId: costPublicId, legalEntityId: a.legalEntityId,
          summary: `Bill ${cost.billPath ? 'replaced' : 'attached'} for the passed-on cost of ${cost.incurredOn}: it counts`, details: { fileType: type } });
      });
    } catch (err) {
      await discardUpload(billPath);
      throw err;
    }
    return this.cost(ctx, costPublicId);
  }

  /** The bill file of a cost, for whoever sees the agreement. */
  async billFile(ctx: RequestContext, costPublicId: string): Promise<{ name: string; contentType: string; data: Buffer }> {
    const found = await this.repo.findCost(this.db, ctx.tenantId, costPublicId);
    if (!found) throw new AppError('IC_COST_NOT_FOUND', 404, 'Passed-on cost not found');
    await this.visibleById(ctx, found.agreementId, () => new AppError('IC_COST_NOT_FOUND', 404, 'Passed-on cost not found'));
    if (!found.billPath || !found.billType) throw new AppError('IC_NO_BILL', 404, 'No bill is attached to this cost yet');
    const type = found.billType as DocumentType;
    return { name: `bill-${found.incurredOn}.${type}`, contentType: CONTENT_TYPES[type], data: await readUpload(found.billPath) };
  }

  // ---- helpers ----

  private seesAll(ctx: RequestContext): boolean {
    return ctx.permissions[INTERCOMPANY.view] === 'all' || ctx.permissions[INTERCOMPANY.manage] === 'all';
  }

  private sees(ctx: RequestContext, a: Row, jobs: Map<number, JobRow>): boolean {
    return canSeeAgreement({ personId: ctx.personId, seesAll: this.seesAll(ctx) },
      { provider: head(jobs.get(a.providerHeadEmploymentId)), receiver: head(jobs.get(a.receiverHeadEmploymentId)) });
  }

  /** The agreement if the caller may see it; otherwise 404, as if it did not exist. */
  private async visible(ctx: RequestContext, publicId: string): Promise<Row> {
    const [a] = await this.repo.agreements(this.db, ctx.tenantId, { publicId });
    if (!a || !this.sees(ctx, a, await this.repo.jobs(this.db, jobIds(a)))) throw notFound();
    return a;
  }

  private async visibleById(ctx: RequestContext, id: number, hidden: () => AppError): Promise<Row> {
    const [a] = await this.repo.agreements(this.db, ctx.tenantId, { id });
    if (!a || !this.sees(ctx, a, await this.repo.jobs(this.db, jobIds(a)))) throw hidden();
    return a;
  }

  private async requireCostRecorder(ctx: RequestContext, a: Row): Promise<void> {
    const jobs = await this.repo.jobs(this.db, [a.providerHeadEmploymentId]);
    if (!canRecordCosts({ personId: ctx.personId, managesAll: ctx.permissions[INTERCOMPANY.manage] === 'all' }, head(jobs.get(a.providerHeadEmploymentId)))) {
      throw new AppError('IC_NOT_PROVIDER_HEAD', 403, 'Only the provider\'s head (or the CEO) records passed-on costs');
    }
  }

  private requireOpenMonth(billed: YearMonth[], date: string): void {
    const m = billedMonthOf(billed, date);
    if (m) throw new AppError('IC_MONTH_BILLED', 409, `${monthLabel(m)} is billed: nothing in it changes`);
  }

  private async company(ctx: RequestContext, code: string) {
    const c = await this.repo.findCompany(ctx.tenantId, code);
    if (!c) throw new AppError('IC_UNKNOWN_COMPANY', 400, `Unknown company ${code}`);
    return c;
  }

  /** A job held now in the given company (a head or approver of one side). */
  private async jobIn(ctx: RequestContext, publicId: string, companyId: number, who: string, code: string): Promise<JobRow> {
    const j = await this.repo.findJob(ctx.tenantId, publicId);
    if (!j) throw new AppError('IC_JOB_NOT_FOUND', 404, `${who}: job not found`);
    if (j.legalEntityId !== companyId) throw new AppError('IC_JOB_OTHER_COMPANY', 400, `${who} must have a job in ${code}`);
    if (!isCurrentJob(j.status)) throw new AppError('IC_JOB_NOT_CURRENT', 409, `${who} no longer holds that job`);
    return j;
  }

  private async detail(tenantId: number, publicId: string): Promise<IcAgreementDetail> {
    const [a] = await this.repo.agreements(this.db, tenantId, { publicId });
    if (!a) throw notFound();
    const [jobs, cards, billed] = await Promise.all([this.repo.jobs(this.db, jobIds(a)), this.repo.rateCards(this.db, a.id), this.repo.billedMonths(this.db, a.id)]);
    const people = await this.repo.persons(this.db, [a.createdBy, a.updatedBy, ...cards.map((c) => c.createdBy), ...billed.map((b) => b.billedBy)]);
    return {
      ...toAgreement(a, jobs, people),
      rateCards: cards.map((c) => toRateCard(c, people)),
      billedMonths: billed.map((b) => ({ year: b.year, month: b.month, billedBy: person(people, b.billedBy), billedAt: b.billedAt.toISOString() })),
    };
  }

  private async rateCard(agreementId: number, publicId: string): Promise<IcRateCard> {
    const card = (await this.repo.rateCards(this.db, agreementId)).find((c) => c.publicId === publicId)!;
    return toRateCard(card, await this.repo.persons(this.db, [card.createdBy]));
  }

  private async cost(ctx: RequestContext, publicId: string): Promise<IcPassedCost> {
    const found = (await this.repo.findCost(this.db, ctx.tenantId, publicId))!;
    const [a] = await this.repo.agreements(this.db, ctx.tenantId, { id: found.agreementId });
    const [row] = await this.repo.passedCosts(this.db, found.agreementId, { publicId });
    return toCost(row, a.publicId, await this.repo.persons(this.db, [row.createdBy, row.billUploadedBy]));
  }
}

// ---- mapping ----

const notFound = () => new AppError('IC_AGREEMENT_NOT_FOUND', 404, 'Agreement not found');
const jobIds = (a: Row) => [a.providerHeadEmploymentId, a.providerApproverEmploymentId, a.receiverHeadEmploymentId, a.receiverApproverEmploymentId];
const head = (j: JobRow | undefined): Head => ({ personId: j?.personId ?? -1, current: j !== undefined && isCurrentJob(j.status) });
const percentText = (v: number | null | undefined) => (v === null || v === undefined ? null : v.toFixed(2));
const percentNumber = (v: string | null) => (v === null ? null : Number(v));
const person = (people: Map<number, PersonRow>, id: number) => people.get(id)!;

function billType(bill: BillUpload): DocumentType {
  const t = detectDocumentType(bill.buffer);
  if (!t) throw new AppError('IC_BILL_TYPE', 400, 'The bill must be a JPEG, PNG or PDF file');
  return t;
}

function termsOf(a: Row): Terms {
  return { services: a.services, pricingMethod: a.pricingMethod as Terms['pricingMethod'], costPlusPercent: percentNumber(a.costPlusPercent),
    passedCostHandling: a.passedCostHandling as Terms['passedCostHandling'], passedCostPercent: percentNumber(a.passedCostPercent) };
}

/** field → [before, after] for every field that changes (for the audit log). */
function changedFields(a: Row, patch: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const [k, v] of Object.entries(patch)) {
    const old = (a as Record<string, unknown>)[k];
    if (JSON.stringify(old) !== JSON.stringify(v)) out[k] = [old ?? null, v ?? null];
  }
  return out;
}

function toAgreement(a: AgreementRow, jobs: Map<number, JobRow>, people: Map<number, PersonRow>): IcAgreement {
  const job = (id: number) => {
    const j = jobs.get(id)!;
    return { employmentPublicId: j.publicId, person: { publicId: j.personPublicId, displayName: j.displayName } };
  };
  return {
    publicId: a.publicId,
    provider: { company: a.provider, companyName: a.providerName, head: job(a.providerHeadEmploymentId), approver: job(a.providerApproverEmploymentId) },
    receiver: { company: a.receiver, companyName: a.receiverName, head: job(a.receiverHeadEmploymentId), approver: job(a.receiverApproverEmploymentId) },
    services: a.services as IcAgreement['services'], pricingMethod: a.pricingMethod as IcAgreement['pricingMethod'],
    costPlusPercent: percentNumber(a.costPlusPercent), passedCostHandling: a.passedCostHandling as IcAgreement['passedCostHandling'],
    passedCostPercent: percentNumber(a.passedCostPercent), reviewDays: a.reviewDays, paymentTermsDays: a.paymentTermsDays,
    startDate: a.startDate, endDate: a.endDate, status: a.status as IcAgreement['status'],
    createdBy: person(people, a.createdBy), createdAt: a.createdAt.toISOString(),
    updatedBy: a.updatedBy === null ? null : person(people, a.updatedBy), updatedAt: a.updatedAt?.toISOString() ?? null,
  };
}

type CardRow = Awaited<ReturnType<IntercompanyRepository['rateCards']>>[number];
function toRateCard(c: CardRow, people: Map<number, PersonRow>): IcRateCard {
  return { publicId: c.publicId, serviceType: c.serviceType as IcRateCard['serviceType'], grade: c.grade, rateMinor: c.rateMinor, currency: c.currency,
    effectiveFrom: c.effectiveFrom, createdBy: person(people, c.createdBy), createdAt: c.createdAt.toISOString() };
}

type CostRow = Awaited<ReturnType<IntercompanyRepository['passedCosts']>>[number];
function toCost(r: CostRow, agreementPublicId: string, people: Map<number, PersonRow>): IcPassedCost {
  const bill = r.billType && r.billUploadedBy !== null && r.billUploadedAt
    ? { fileType: r.billType, uploadedBy: person(people, r.billUploadedBy), uploadedAt: r.billUploadedAt.toISOString() } : null;
  return { publicId: r.publicId, agreementPublicId, projectPublicId: r.projectPublicId, description: r.description, amountMinor: r.amountMinor,
    currency: r.currency, incurredOn: r.incurredOn, bill, counted: bill !== null, createdBy: person(people, r.createdBy), createdAt: r.createdAt.toISOString() };
}
