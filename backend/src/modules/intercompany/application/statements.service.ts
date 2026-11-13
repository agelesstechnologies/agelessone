import { Inject, Injectable } from '@nestjs/common';
import {
  AnswerStatementRequest, BuildStatementRequest, CloseStatementRequest, CorrectLineRequest, ExplainLineRequest, IcAccess, IcStatement, IcStatementDetail,
  IcStatementLine, InvoiceStatementRequest, StatementsQuery,
} from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { todayIst } from '../../../platform/time';
import { rupees } from '../../../platform/csv';
import { CoreFacade } from '../../core/core.facade';
import { AgreementRow, IntercompanyRepository, JobRow, PersonRow } from '../infrastructure/intercompany.repository';
import { LineRow, StatementRow, StatementsRepository } from '../infrastructure/statements.repository';
import { billMonthProblem, canSeeAgreement, Head, isCurrentJob, monthEnd, monthLabel, monthStart } from '../domain/agreements';
import {
  approveProblem, canAnswer, canPrepare, canSeeStatement, correctionProblem, creditFor, openDisputes, passedCostAmount, priceLabour, reviewDueOn,
  reviewOver, StatementPeople, statusAfterAnswer, toBasisPoints,
} from '../domain/statements';
import { INTERCOMPANY } from '../domain/permissions';

const SERVICE_LABEL: Record<string, string> = { design: 'Design', software: 'Software', iot_hardware: 'IoT hardware', cgi: 'CGI' };

/**
 * Monthly statements of an agreement. Built from the month's billable ticket time (allocated plus the heads'
 * adjustments) once the provider's attendance month is locked, priced by rate card or cost plus, with the passed-on costs
 * that have a bill and any credits from corrections after invoicing. The provider approves (a department head with time
 * on it, or the CEO; never the preparer) — the month is then billed — and sends it; the receiver's head or approver
 * accepts or disputes lines within the agreement's review days (no answer: accepted automatically by the daily job);
 * the provider corrects or explains disputed lines and sends again; then invoiced and closed. Every step is audited.
 * Costs (payroll) are shown to the CEO only.
 */
@Injectable()
export class StatementsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(IntercompanyRepository) private readonly ic: IntercompanyRepository,
    @Inject(StatementsRepository) private readonly repo: StatementsRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  // ---- reading ----

  async list(ctx: RequestContext, q: StatementsQuery): Promise<IcStatement[]> {
    let agreementId: number | undefined;
    if (q.agreement) {
      const [a] = await this.ic.agreements(this.db, ctx.tenantId, { publicId: q.agreement });
      if (!a) return [];
      agreementId = a.id;
    }
    const rows = await this.repo.statements(this.db, ctx.tenantId, { agreementId, status: q.status, year: q.year });
    const visible: StatementRow[] = [];
    for (const s of rows) if (canSeeStatement(this.caller(ctx), await this.people(this.db, ctx.tenantId, s))) visible.push(s);
    const lines = await this.repo.lines(this.db, visible.map((s) => s.id));
    const people = await this.ic.persons(this.db, visible.flatMap(statementPeopleIds));
    return visible.map((s) => toStatement(s, lines.filter((l) => l.statementId === s.id), people, this.seesAll(ctx)));
  }

  async get(ctx: RequestContext, publicId: string): Promise<IcStatementDetail> {
    const s = await this.visible(ctx, this.db, publicId);
    return this.view(ctx, s.publicId);
  }

  /**
   * What the caller sees of Intercompany, for the menu: agreements they see (named head; all for the CEO), and whether they
   * see statements (the CEO, a head or approver named on an agreement, the head of a department with time on one).
   */
  async access(ctx: RequestContext): Promise<IcAccess> {
    const caller = this.caller(ctx);
    const agreements = await this.ic.agreements(this.db, ctx.tenantId, {});
    const jobs = await this.ic.jobs(this.db, agreements.flatMap((a) => [a.providerHeadEmploymentId, a.providerApproverEmploymentId,
      a.receiverHeadEmploymentId, a.receiverApproverEmploymentId]));
    const mine = (id: number) => { const h = head(jobs.get(id)); return h.current && h.personId === ctx.personId; };
    const seen = agreements.filter((a) => caller.seesAll || mine(a.providerHeadEmploymentId) || mine(a.receiverHeadEmploymentId)).length;
    const named = agreements.some((a) => mine(a.providerHeadEmploymentId) || mine(a.receiverHeadEmploymentId)
      || mine(a.providerApproverEmploymentId) || mine(a.receiverApproverEmploymentId));
    return { seesAll: caller.seesAll, manages: caller.managesAll, agreements: seen,
      statements: caller.seesAll || named || await this.repo.headsStatementDepartment(this.db, ctx.tenantId, ctx.personId) };
  }

  // ---- building ----

  /**
   * The statement of a month: only once the provider's attendance month is locked (IC_MONTH_NOT_LOCKED). The provider's
   * head or the CEO. Asking again for the same month answers the stored statement.
   */
  async build(ctx: RequestContext, agreementPublicId: string, req: BuildStatementRequest): Promise<{ statement: IcStatementDetail; created: boolean }> {
    const a = await this.agreementForPreparer(ctx, agreementPublicId);
    const existing = await this.repo.findStatement(this.db, a.id, req.year, req.month);
    if (existing) return { statement: await this.view(ctx, existing.publicId), created: false };
    if (a.status === 'draft') throw new AppError('IC_AGREEMENT_NOT_ACTIVE', 409, 'A draft agreement bills nothing: make it active first');
    await this.requireBillableMonth(this.db, a, req.year, req.month);
    let publicId: string;
    try {
      publicId = await this.db.transaction(async (tx) => {
        await this.ic.lockAgreementById(tx, a.id);
        const s = await this.repo.insertStatement(tx, { tenantId: ctx.tenantId, agreementId: a.id, legalEntityId: a.legalEntityId, year: req.year,
          month: req.month, preparedBy: ctx.personId });
        const total = await this.compute(tx, ctx.tenantId, s.id, a, req.year, req.month);
        await this.audit(tx, ctx, a.legalEntityId, s.publicId, 'intercompany.statement_built',
          `Intercompany statement ${a.provider} → ${a.receiver} ${monthLabel(req)} built: ${rupees(total)}`, { totalMinor: total });
        return s.publicId;
      });
    } catch (err) {
      if (violatedConstraint(err) === 'ic_statements_agreement_month_unique') return this.build(ctx, agreementPublicId, req);   // built twice at once
      throw err;
    }
    return { statement: await this.view(ctx, publicId), created: true };
  }

  /** A draft again from today's data (time, rates, costs with bills, credits); the caller becomes its preparer. */
  async rebuild(ctx: RequestContext, publicId: string): Promise<IcStatementDetail> {
    await this.db.transaction(async (tx) => {
      const s = await this.locked(ctx, tx, publicId);
      const p = await this.people(tx, ctx.tenantId, s);
      if (!canPrepare(this.caller(ctx), p)) throw notPreparer();
      if (s.status !== 'draft') throw wrongStatus(s.status, 'rebuilt', 'a draft');
      const [a] = await this.ic.agreements(tx, ctx.tenantId, { id: s.agreementId });
      await this.requireBillableMonth(tx, a, s.year, s.month);
      const total = await this.compute(tx, ctx.tenantId, s.id, a, s.year, s.month);
      await this.repo.updateStatement(tx, s.id, { preparedBy: ctx.personId, preparedAt: new Date() });
      await this.audit(tx, ctx, s.legalEntityId, s.publicId, 'intercompany.statement_rebuilt',
        `Intercompany statement ${s.provider} → ${s.receiver} ${monthLabel(s)} rebuilt: ${rupees(total)}`, { totalMinor: total });
    });
    return this.view(ctx, publicId);
  }

  // ---- provider ----

  /** The provider's approval: a head of a department with time on it, or the CEO; never its preparer. The month is then billed. */
  async approve(ctx: RequestContext, publicId: string): Promise<IcStatementDetail> {
    await this.db.transaction(async (tx) => {
      const s = await this.locked(ctx, tx, publicId);
      if (s.status !== 'draft') throw wrongStatus(s.status, 'approved', 'a draft');
      const p = await this.people(tx, ctx.tenantId, s);
      const problem = approveProblem(this.caller(ctx), p, s.preparedBy);
      if (problem === 'IC_SELF_APPROVAL') throw new AppError(problem, 403, 'Nobody approves a statement they prepared');
      if (problem) throw new AppError(problem, 403, 'A head of a department with time on this statement, or the CEO, approves it');
      if ((await this.repo.lines(tx, [s.id])).length === 0) throw new AppError('IC_STATEMENT_EMPTY', 409, 'Nothing is billed on this statement');
      if ((await this.ic.billedMonths(tx, s.agreementId)).some((b) => b.year === s.year && b.month === s.month)) {
        throw new AppError('IC_MONTH_BILLED', 409, `${monthLabel(s)} was already billed outside this statement`);
      }
      await this.ic.insertBilledMonth(tx, { tenantId: ctx.tenantId, agreementId: s.agreementId, legalEntityId: s.legalEntityId, year: s.year, month: s.month, billedBy: ctx.personId });
      const as = p.departmentHeadIds.includes(ctx.personId) ? 'head' : 'ceo';
      await this.repo.updateStatement(tx, s.id, { status: 'approved_by_provider', approvedBy: ctx.personId, approvedAt: new Date(), approvedAs: as });
      await this.audit(tx, ctx, s.legalEntityId, s.publicId, 'intercompany.statement_approved',
        `Intercompany statement ${s.provider} → ${s.receiver} ${monthLabel(s)} approved by the provider (${as}); the month is billed`, { approvedAs: as });
    });
    return this.view(ctx, publicId);
  }

  /** Send to the receiver (again, once every disputed line is corrected or explained). The review window starts today. */
  async send(ctx: RequestContext, publicId: string): Promise<IcStatementDetail> {
    await this.db.transaction(async (tx) => {
      const s = await this.locked(ctx, tx, publicId);
      if (!canPrepare(this.caller(ctx), await this.people(tx, ctx.tenantId, s))) throw notPreparer();
      if (s.status !== 'approved_by_provider' && s.status !== 'partly_disputed') throw wrongStatus(s.status, 'sent', 'approved by the provider or partly disputed');
      const lines = await this.repo.lines(tx, [s.id]);
      if (openDisputes(lines.map(lineState)).length > 0) {
        throw new AppError('IC_DISPUTES_OPEN', 409, 'Correct, remove or explain every disputed line before sending again');
      }
      for (const l of lines.filter((x) => x.status === 'disputed')) {
        await this.repo.updateLine(tx, l.id, { status: l.resolution === 'removed' ? 'removed' : 'pending' });
      }
      const [a] = await this.ic.agreements(tx, ctx.tenantId, { id: s.agreementId });
      const today = todayIst();
      const due = reviewDueOn(today, a.reviewDays);
      const now = new Date();
      await this.repo.updateStatement(tx, s.id, { status: 'sent', round: s.round + 1, firstSentAt: s.firstSentAt ?? now, sentAt: now, sentBy: ctx.personId, reviewDueOn: due });
      await this.audit(tx, ctx, s.legalEntityId, s.publicId, 'intercompany.statement_sent',
        `Intercompany statement ${s.provider} → ${s.receiver} ${monthLabel(s)} sent${s.round > 0 ? ' again' : ''}: answer by ${due}`, { round: s.round + 1, reviewDueOn: due });
    });
    return this.view(ctx, publicId);
  }

  /**
   * Correct a line, reason required: reduce it to an amount, or remove it. A disputed line of a partly disputed statement
   * changes; after invoicing the correction becomes a credit on the agreement's next statement.
   */
  async correct(ctx: RequestContext, linePublicId: string, req: CorrectLineRequest): Promise<IcStatementDetail> {
    const target: number | 'remove' = req.remove ? 'remove' : req.amountMinor!;
    const statementPublicId = await this.db.transaction(async (tx) => {
      const { s, line } = await this.lineFor(ctx, tx, linePublicId);
      if (s.status === 'invoiced' || s.status === 'closed') {
        const credited = (await this.repo.creditedByLine(tx, [line.id])).get(line.id) ?? 0;
        const facts = { kind: line.kind, amountMinor: line.amountMinor, creditedMinor: credited };
        this.requireCorrection(correctionProblem(facts, target, true));
        if (line.status === 'removed') throw new AppError('IC_LINE_NOT_CORRECTABLE', 409, 'A removed line is not billed');
        const amount = creditFor(facts, target);
        const creditId = await this.repo.insertCredit(tx, { tenantId: ctx.tenantId, agreementId: s.agreementId, legalEntityId: s.legalEntityId,
          lineId: line.id, amountMinor: amount, reason: req.reason, createdBy: ctx.personId });
        await this.repo.insertLineEvent(tx, { tenantId: ctx.tenantId, lineId: line.id, legalEntityId: s.legalEntityId, round: s.round, kind: 'credited',
          reason: req.reason, amountBeforeMinor: line.amountMinor - credited, amountAfterMinor: line.amountMinor - credited - amount, byPersonId: ctx.personId });
        await this.audit(tx, ctx, s.legalEntityId, creditId, 'intercompany.credit_added',
          `Credit of ${rupees(amount)} on ${s.provider} → ${s.receiver} ${monthLabel(s)} (${line.description}) for the next statement: ${req.reason}`,
          { statementPublicId: s.publicId, linePublicId, amountMinor: amount, reason: req.reason });
        return s.publicId;
      }
      this.requireOpenDispute(s, line);
      this.requireCorrection(correctionProblem({ kind: line.kind, amountMinor: line.amountMinor, creditedMinor: 0 }, target, false));
      const amount = target === 'remove' ? line.amountMinor : target;
      await this.repo.updateLine(tx, line.id, { amountMinor: amount, originalAmountMinor: line.originalAmountMinor ?? line.amountMinor,
        resolution: target === 'remove' ? 'removed' : 'corrected', resolutionReason: req.reason, resolvedBy: ctx.personId, resolvedAt: new Date() });
      await this.repo.insertLineEvent(tx, { tenantId: ctx.tenantId, lineId: line.id, legalEntityId: s.legalEntityId, round: s.round,
        kind: target === 'remove' ? 'removed' : 'corrected', reason: req.reason, amountBeforeMinor: line.amountMinor,
        amountAfterMinor: target === 'remove' ? 0 : amount, byPersonId: ctx.personId });
      await this.audit(tx, ctx, s.legalEntityId, s.publicId, target === 'remove' ? 'intercompany.line_removed' : 'intercompany.line_corrected',
        `Disputed line ${target === 'remove' ? 'removed' : `reduced to ${rupees(amount)}`} (${line.description}): ${req.reason}`,
        { linePublicId, before: line.amountMinor, after: target === 'remove' ? 0 : amount, reason: req.reason });
      return s.publicId;
    });
    return this.view(ctx, statementPublicId);
  }

  /** Keep a disputed line as it is, saying why (it goes back to the receiver when sent again). */
  async explain(ctx: RequestContext, linePublicId: string, req: ExplainLineRequest): Promise<IcStatementDetail> {
    const statementPublicId = await this.db.transaction(async (tx) => {
      const { s, line } = await this.lineFor(ctx, tx, linePublicId);
      this.requireOpenDispute(s, line);
      await this.repo.updateLine(tx, line.id, { resolution: 'explained', resolutionReason: req.reason, resolvedBy: ctx.personId, resolvedAt: new Date() });
      await this.repo.insertLineEvent(tx, { tenantId: ctx.tenantId, lineId: line.id, legalEntityId: s.legalEntityId, round: s.round, kind: 'explained',
        reason: req.reason, amountBeforeMinor: line.amountMinor, amountAfterMinor: line.amountMinor, byPersonId: ctx.personId });
      await this.audit(tx, ctx, s.legalEntityId, s.publicId, 'intercompany.line_explained', `Disputed line kept (${line.description}): ${req.reason}`,
        { linePublicId, reason: req.reason });
      return s.publicId;
    });
    return this.view(ctx, statementPublicId);
  }

  async invoice(ctx: RequestContext, publicId: string, req: InvoiceStatementRequest): Promise<IcStatementDetail> {
    try {
      await this.db.transaction(async (tx) => {
        const s = await this.locked(ctx, tx, publicId);
        if (!canPrepare(this.caller(ctx), await this.people(tx, ctx.tenantId, s))) throw notPreparer();
        if (s.status !== 'accepted') throw wrongStatus(s.status, 'invoiced', 'accepted');
        await this.repo.updateStatement(tx, s.id, { status: 'invoiced', invoiceNumber: req.invoiceNumber, invoicedOn: req.invoicedOn, invoicedBy: ctx.personId });
        await this.audit(tx, ctx, s.legalEntityId, s.publicId, 'intercompany.statement_invoiced',
          `Intercompany statement ${s.provider} → ${s.receiver} ${monthLabel(s)} invoiced: ${req.invoiceNumber} of ${req.invoicedOn}`, { ...req });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'ic_statements_invoice_number_unique') throw new AppError('IC_INVOICE_NUMBER_USED', 409, `Invoice ${req.invoiceNumber} is already used`);
      throw err;
    }
    return this.view(ctx, publicId);
  }

  async close(ctx: RequestContext, publicId: string, req: CloseStatementRequest): Promise<IcStatementDetail> {
    await this.db.transaction(async (tx) => {
      const s = await this.locked(ctx, tx, publicId);
      if (!canPrepare(this.caller(ctx), await this.people(tx, ctx.tenantId, s))) throw notPreparer();
      if (s.status !== 'invoiced') throw wrongStatus(s.status, 'closed', 'invoiced');
      await this.repo.updateStatement(tx, s.id, { status: 'closed', paidOn: req.paidOn, paymentRef: req.paymentRef, closedBy: ctx.personId, closedAt: new Date() });
      await this.audit(tx, ctx, s.legalEntityId, s.publicId, 'intercompany.statement_closed',
        `Intercompany statement ${s.provider} → ${s.receiver} ${monthLabel(s)} paid on ${req.paidOn} (${req.paymentRef}) and closed`, { ...req });
    });
    return this.view(ctx, publicId);
  }

  // ---- receiver ----

  /** The receiver's head or approver, within the review window: dispute lines (with a reason); every other line waiting is accepted. */
  async answer(ctx: RequestContext, publicId: string, req: AnswerStatementRequest): Promise<IcStatementDetail> {
    await this.db.transaction(async (tx) => {
      const s = await this.locked(ctx, tx, publicId);
      if (!canAnswer(ctx.personId, await this.people(tx, ctx.tenantId, s))) {
        throw new AppError('IC_NOT_RECEIVER', 403, 'The receiver\'s head or approver answers a statement');
      }
      if (s.status !== 'sent') throw wrongStatus(s.status, 'answered', 'sent');
      if (reviewOver(s.reviewDueOn!, todayIst())) throw new AppError('IC_REVIEW_OVER', 409, `The review ended on ${s.reviewDueOn}: the statement is accepted`);
      const lines = await this.repo.lines(tx, [s.id]);
      const now = new Date();
      for (const d of req.disputes) {
        const line = lines.find((l) => l.publicId === d.linePublicId);
        if (!line || line.status !== 'pending') throw new AppError('IC_LINE_NOT_PENDING', 400, 'Only lines of this statement waiting for your answer can be disputed', { linePublicId: d.linePublicId });
        await this.repo.updateLine(tx, line.id, { status: 'disputed', disputeReason: d.reason, disputedBy: ctx.personId, disputedAt: now,
          resolution: null, resolutionReason: null, resolvedBy: null, resolvedAt: null });
        await this.repo.insertLineEvent(tx, { tenantId: ctx.tenantId, lineId: line.id, legalEntityId: s.legalEntityId, round: s.round, kind: 'disputed',
          reason: d.reason, amountBeforeMinor: line.amountMinor, amountAfterMinor: null, byPersonId: ctx.personId });
        line.status = 'disputed';
        line.resolution = null;
      }
      await this.repo.moveLines(tx, s.id, 'pending', 'accepted');
      const status = statusAfterAnswer(lines.map(lineState));
      await this.repo.updateStatement(tx, s.id, status === 'accepted'
        ? { status, acceptedAt: now, acceptedAs: 'receiver', acceptedBy: ctx.personId } : { status });
      await this.audit(tx, ctx, s.legalEntityId, s.publicId, status === 'accepted' ? 'intercompany.statement_accepted' : 'intercompany.statement_disputed',
        `Intercompany statement ${s.provider} → ${s.receiver} ${monthLabel(s)} ${status === 'accepted' ? 'accepted' : `disputed: ${req.disputes.length} line(s)`} by the receiver`,
        { disputes: req.disputes });
    });
    return this.view(ctx, publicId);
  }

  /**
   * The daily job: statements sent and not answered by the end of their review day are accepted automatically (every
   * line still waiting is accepted), recorded with no actor. Answers how many.
   */
  async acceptOverdue(today: string = todayIst()): Promise<number> {
    let accepted = 0;
    for (const due of await this.repo.reviewOverdue(this.db, today)) {
      await this.db.transaction(async (tx) => {
        const s = await this.repo.lockStatementById(tx, due.tenantId, due.id);
        if (!s || s.status !== 'sent' || !reviewOver(s.reviewDueOn!, today)) return;
        await this.repo.moveLines(tx, s.id, 'pending', 'accepted');
        await this.repo.updateStatement(tx, s.id, { status: 'accepted', acceptedAt: new Date(), acceptedAs: 'automatic', acceptedBy: null });
        await this.core.audit(tx, { tenantId: due.tenantId, actorPersonId: null, action: 'intercompany.statement_accepted_automatically',
          entity: 'ic_statement', entityPublicId: s.publicId, legalEntityId: s.legalEntityId,
          summary: `Intercompany statement ${s.provider} → ${s.receiver} ${monthLabel(s)} accepted automatically: no answer by ${s.reviewDueOn}`,
          details: { reviewDueOn: s.reviewDueOn } });
        accepted++;
      });
    }
    return accepted;
  }

  // ---- helpers ----

  private seesAll(ctx: RequestContext): boolean {
    return ctx.permissions[INTERCOMPANY.view] === 'all' || ctx.permissions[INTERCOMPANY.manage] === 'all';
  }

  private caller(ctx: RequestContext) {
    return { personId: ctx.personId, seesAll: this.seesAll(ctx), managesAll: ctx.permissions[INTERCOMPANY.manage] === 'all' };
  }

  /** Who is who on a statement: the agreement's heads and approvers, and the heads of departments with time on it. */
  private async people(conn: Conn, tenantId: number, s: { id: number; agreementId: number }): Promise<StatementPeople> {
    const [a] = await this.ic.agreements(conn, tenantId, { id: s.agreementId });
    const jobs = await this.ic.jobs(conn, [a.providerHeadEmploymentId, a.providerApproverEmploymentId, a.receiverHeadEmploymentId, a.receiverApproverEmploymentId]);
    return { providerHead: head(jobs.get(a.providerHeadEmploymentId)), providerApprover: head(jobs.get(a.providerApproverEmploymentId)),
      receiverHead: head(jobs.get(a.receiverHeadEmploymentId)), receiverApprover: head(jobs.get(a.receiverApproverEmploymentId)),
      departmentHeadIds: await this.repo.departmentHeads(conn, s.id) };
  }

  private async visible(ctx: RequestContext, conn: Conn, publicId: string): Promise<StatementRow> {
    const [s] = await this.repo.statements(conn, ctx.tenantId, { publicId });
    if (!s || !canSeeStatement(this.caller(ctx), await this.people(conn, ctx.tenantId, s))) throw notFound();
    return s;
  }

  /** The statement, locked for the transaction, if the caller may see it. */
  private async locked(ctx: RequestContext, tx: Tx, publicId: string): Promise<StatementRow> {
    const s = await this.repo.lockStatement(tx, ctx.tenantId, publicId);
    if (!s || !canSeeStatement(this.caller(ctx), await this.people(tx, ctx.tenantId, s))) throw notFound();
    return s;
  }

  private async lineFor(ctx: RequestContext, tx: Tx, linePublicId: string): Promise<{ s: StatementRow; line: LineRow }> {
    const found = await this.repo.findLine(tx, ctx.tenantId, linePublicId);
    if (!found) throw new AppError('IC_LINE_NOT_FOUND', 404, 'Statement line not found');
    const s = await this.repo.lockStatementById(tx, ctx.tenantId, found.statementId);
    const p = await this.people(tx, ctx.tenantId, s);
    if (!canSeeStatement(this.caller(ctx), p)) throw new AppError('IC_LINE_NOT_FOUND', 404, 'Statement line not found');
    if (!canPrepare(this.caller(ctx), p)) throw notPreparer();
    const line = (await this.repo.lines(tx, [s.id])).find((l) => l.id === found.id)!;
    return { s, line };
  }

  private requireOpenDispute(s: StatementRow, line: LineRow): void {
    if (s.status !== 'partly_disputed' || line.status !== 'disputed' || line.resolution !== null) {
      throw new AppError('IC_LINE_NOT_DISPUTED', 409, 'Only a disputed line still waiting for the provider is corrected or explained here (after invoicing a correction becomes a credit)');
    }
  }

  private requireCorrection(problem: ReturnType<typeof correctionProblem>): void {
    if (problem === 'IC_LINE_NOT_CORRECTABLE') throw new AppError(problem, 409, 'A credit line is not corrected');
    if (problem === 'IC_ALREADY_CREDITED') throw new AppError(problem, 409, 'This line is already credited in full');
    if (problem) throw new AppError(problem, 400, 'A correction only lowers the line');
  }

  /** The agreement, for its provider's head or the CEO. Others: 404 when they cannot see it, else 403. */
  private async agreementForPreparer(ctx: RequestContext, publicId: string): Promise<AgreementRow> {
    const [a] = await this.ic.agreements(this.db, ctx.tenantId, { publicId });
    if (!a) throw new AppError('IC_AGREEMENT_NOT_FOUND', 404, 'Agreement not found');
    const jobs = await this.ic.jobs(this.db, [a.providerHeadEmploymentId, a.receiverHeadEmploymentId]);
    const heads = { provider: head(jobs.get(a.providerHeadEmploymentId)), receiver: head(jobs.get(a.receiverHeadEmploymentId)) };
    if (!canSeeAgreement(this.caller(ctx), heads)) throw new AppError('IC_AGREEMENT_NOT_FOUND', 404, 'Agreement not found');
    if (!this.caller(ctx).managesAll && !(heads.provider.current && heads.provider.personId === ctx.personId)) throw notPreparer();
    return a;
  }

  /** A finished month inside the agreement, the provider's attendance locked, not billed outside statements. */
  private async requireBillableMonth(conn: Conn, a: AgreementRow, year: number, month: number): Promise<void> {
    const problem = billMonthProblem({ year, month }, a, todayIst());
    if (problem === 'IC_MONTH_OUTSIDE_AGREEMENT') throw new AppError(problem, 400, `${monthLabel({ year, month })} is outside the agreement's dates`);
    if (problem) throw new AppError(problem, 409, `${monthLabel({ year, month })} is not over yet`);
    if (!await this.repo.isMonthLocked(conn, a.legalEntityId, year, month)) {
      throw new AppError('IC_MONTH_NOT_LOCKED', 409, `${a.provider}'s attendance for ${monthLabel({ year, month })} is not locked yet: lock the month first`);
    }
    const statement = await this.repo.findStatement(conn, a.id, year, month);
    if (!statement && (await this.ic.billedMonths(conn, a.id)).some((b) => b.year === year && b.month === month)) {
      throw new AppError('IC_MONTH_BILLED', 409, `${monthLabel({ year, month })} was billed outside statements`);
    }
  }

  /** (Re)writes a draft's lines: labour, passed-on costs with a bill, open credits. Answers the total. */
  private async compute(tx: Tx, tenantId: number, statementId: number, a: AgreementRow, year: number, month: number): Promise<number> {
    const from = monthStart({ year, month });
    const to = monthEnd({ year, month });
    const time = await this.repo.billableTime(tx, tenantId, from, to, { providerId: a.legalEntityId, receiverId: a.receiverLegalEntityId });
    const tickets = new Map((await this.repo.billableTickets(tx, tenantId, { ticketIds: [...new Set(time.map((t) => t.ticketId))] })).map((t) => [t.ticketId, t]));
    const noService = [...tickets.values()].filter((t) => t.serviceType === null).map((t) => t.number);
    if (noService.length) throw new AppError('IC_TICKET_NO_SERVICE', 409, 'Some tickets have no service type: link them again with one', { tickets: noService });
    const notCovered = [...tickets.values()].filter((t) => !a.services.includes(t.serviceType!)).map((t) => ({ ticket: t.number, serviceType: t.serviceType }));
    if (notCovered.length) throw new AppError('IC_SERVICE_NOT_COVERED', 409, 'Some tickets are for a service the agreement does not cover', { tickets: notCovered });
    const jobs = await this.ic.jobs(tx, time.map((t) => t.employmentId));
    const pricing = {
      method: a.pricingMethod as 'rate_card' | 'cost_plus',
      costPlusBp: a.costPlusPercent === null ? null : toBasisPoints(a.costPlusPercent),
      // POLICY intercompany.cost.hours_per_month (208): a monthly salary ÷ this = the cost per hour
      hoursPerMonth: await this.core.getPolicy(tenantId, 'intercompany.cost.hours_per_month', a.legalEntityId, from),
    };
    const { lines, missing } = priceLabour(time.map((t) => {
      const ticket = tickets.get(t.ticketId)!;
      return { ticketId: t.ticketId, employmentId: t.employmentId, workDate: t.workDate, minutes: t.minutes, serviceType: ticket.serviceType!,
        projectKind: ticket.linkKind, projectPublicId: ticket.linkPublicId, designation: jobs.get(t.employmentId)?.designation ?? null };
    }), await this.ic.rateCards(tx, a.id), await this.repo.salaries(tx, time.map((t) => t.employmentId)), pricing);
    if (missing.rates.length) {
      const first = new Map<string, string>();
      for (const r of missing.rates) if (!first.has(r.serviceType)) first.set(r.serviceType, r.date);
      throw new AppError('IC_NO_RATE', 409, 'No rate in force for some of the time: add the rates first',
        { missing: [...first].map(([serviceType, date]) => ({ serviceType, from: date })) });
    }
    if (missing.costs.length) {
      throw new AppError('IC_NO_COST', 409, 'Cost plus needs a salary in payroll for everyone on the statement',
        { people: [...new Set(missing.costs.map((c) => c.employmentId))].map((id) => ({ employmentPublicId: jobs.get(id)?.publicId, name: jobs.get(id)?.displayName })) });
    }

    await this.repo.clearDraftLines(tx, statementId);
    let total = 0;
    const base = { tenantId, statementId, legalEntityId: a.legalEntityId };
    for (const l of lines.sort((x, y) => x.serviceType.localeCompare(y.serviceType) || (jobs.get(x.employmentId)?.displayName ?? '').localeCompare(jobs.get(y.employmentId)?.displayName ?? '') || x.rateMinor - y.rateMinor)) {
      const who = jobs.get(l.employmentId) as JobRow;
      await this.repo.insertLine(tx, { ...base, kind: 'labour', description: `${SERVICE_LABEL[l.serviceType]} — ${who.displayName}${l.grade ? ` (${l.grade})` : ''}`,
        projectKind: l.projectKind, projectPublicId: l.projectPublicId, serviceType: l.serviceType, employmentId: l.employmentId, grade: l.grade,
        minutes: l.minutes, rateMinor: l.rateMinor, costPerHourMinor: l.costPerHourMinor, costMinor: l.costMinor, amountMinor: l.amountMinor }, l.tickets);
      total += l.amountMinor;
    }
    const percentBp = a.passedCostPercent === null ? null : toBasisPoints(a.passedCostPercent);
    for (const c of await this.repo.countedCosts(tx, a.id, from, to)) {
      const amount = passedCostAmount(c.amountMinor, a.passedCostHandling as 'at_cost' | 'percent', percentBp);
      await this.repo.insertLine(tx, { ...base, kind: 'passed_cost', description: `${c.description} (${c.incurredOn})`,
        projectKind: c.projectPublicId ? 'project' : null, projectPublicId: c.projectPublicId, passedCostId: c.id, costMinor: c.amountMinor, amountMinor: amount });
      total += amount;
    }
    for (const c of await this.repo.openCredits(tx, a.id)) {
      await this.repo.insertLine(tx, { ...base, kind: 'credit', creditId: c.id, amountMinor: -c.amountMinor,
        description: `Credit: ${c.lineDescription} (${monthLabel({ year: c.statementYear, month: c.statementMonth })}) — ${c.reason}` });
      total -= c.amountMinor;
    }
    return total;
  }

  private async view(ctx: RequestContext, publicId: string): Promise<IcStatementDetail> {
    const [s] = await this.repo.statements(this.db, ctx.tenantId, { publicId });
    const lines = await this.repo.lines(this.db, [s.id]);
    const [tickets, credited, sources, events, who, agreement] = await Promise.all([
      this.repo.lineTickets(this.db, lines.map((l) => l.id)), this.repo.creditedByLine(this.db, lines.map((l) => l.id)),
      this.repo.creditSources(this.db, lines.filter((l) => l.creditId !== null).map((l) => l.creditId!)),
      this.repo.lineEvents(this.db, lines.map((l) => l.id)), this.people(this.db, ctx.tenantId, s),
      this.ic.agreements(this.db, ctx.tenantId, { id: s.agreementId }).then((r) => r[0]),
    ]);
    const people = await this.ic.persons(this.db, [...statementPeopleIds(s), ...lines.flatMap((l) => [l.disputedBy, l.resolvedBy]), ...events.map((e) => e.byPersonId)]);
    const costs = this.seesAll(ctx);
    const caller = this.caller(ctx);
    const prepares = canPrepare(caller, who);
    return {
      ...toStatement(s, lines, people, costs),
      paymentTermsDays: agreement.paymentTermsDays,
      viewerSide: caller.seesAll ? 'all' : canAnswer(ctx.personId, who) ? 'receiver' : 'provider',
      actions: {
        rebuild: prepares && s.status === 'draft',
        approve: s.status === 'draft' && lines.length > 0 && approveProblem(caller, who, s.preparedBy) === null,
        send: prepares && (s.status === 'approved_by_provider' || (s.status === 'partly_disputed' && openDisputes(lines.map(lineState)).length === 0)),
        answer: s.status === 'sent' && canAnswer(ctx.personId, who) && !reviewOver(s.reviewDueOn!, todayIst()),
        correct: prepares && ['partly_disputed', 'invoiced', 'closed'].includes(s.status),
        invoice: prepares && s.status === 'accepted',
        close: prepares && s.status === 'invoiced',
      },
      lines: lines.map((l): IcStatementLine => ({
        publicId: l.publicId, kind: l.kind as IcStatementLine['kind'], description: l.description,
        project: l.projectKind && l.projectPublicId ? { kind: l.projectKind as 'project' | 'design_request', publicId: l.projectPublicId } : null,
        serviceType: l.serviceType as IcStatementLine['serviceType'],
        person: l.personPublicId ? { publicId: l.personPublicId, displayName: l.personName! } : null, employmentPublicId: l.employmentPublicId,
        grade: l.grade, minutes: l.minutes, rateMinor: l.rateMinor, amountMinor: l.amountMinor, originalAmountMinor: l.originalAmountMinor,
        costPerHourMinor: costs ? l.costPerHourMinor : null, costMinor: costs ? l.costMinor : null,
        status: l.status as IcStatementLine['status'],
        dispute: l.disputedAt ? { reason: l.disputeReason!, by: people.get(l.disputedBy!)!, at: l.disputedAt.toISOString() } : null,
        resolution: l.resolvedAt ? { kind: l.resolution as 'corrected' | 'removed' | 'explained', reason: l.resolutionReason!, by: people.get(l.resolvedBy!)!, at: l.resolvedAt.toISOString() } : null,
        creditedMinor: credited.get(l.id) ?? 0,
        thread: events.filter((e) => e.lineId === l.id).map((e) => ({ kind: e.kind as IcStatementLine['thread'][number]['kind'], round: e.round, reason: e.reason,
          amountBeforeMinor: e.amountBeforeMinor, amountAfterMinor: e.amountAfterMinor, by: people.get(e.byPersonId)!, at: e.at.toISOString() })),
        tickets: tickets.filter((t) => t.lineId === l.id).map((t) => ({ publicId: t.publicId, number: t.number, title: t.title, minutes: t.minutes })),
        passedCostPublicId: l.passedCostPublicId,
        creditFor: l.creditId !== null ? sources.get(l.creditId) ?? null : null,
      })),
    };
  }

  private audit(tx: Tx, ctx: RequestContext, legalEntityId: number, entityPublicId: string, action: string, summary: string, details: Record<string, unknown>) {
    return this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action, entity: action === 'intercompany.credit_added' ? 'ic_credit' : 'ic_statement',
      entityPublicId, legalEntityId, summary, details });
  }
}

// ---- mapping ----

const notFound = () => new AppError('IC_STATEMENT_NOT_FOUND', 404, 'Statement not found');
const notPreparer = () => new AppError('IC_NOT_PREPARER', 403, 'The provider\'s head (or the CEO) does this');
const wrongStatus = (status: string, action: string, needed: string) =>
  new AppError('IC_STATEMENT_STATUS', 409, `The statement is ${status.replace(/_/g, ' ')}: it is ${action} only when ${needed}`);
const head = (j: JobRow | undefined): Head => ({ personId: j?.personId ?? -1, current: j !== undefined && isCurrentJob(j.status) });
const lineState = (l: LineRow) => ({ id: l.id, status: l.status as 'pending' | 'accepted' | 'disputed' | 'removed', resolution: l.resolution });
const statementPeopleIds = (s: StatementRow) => [s.preparedBy, s.approvedBy, s.acceptedBy, s.invoicedBy, s.closedBy];

/** Totals count every line but removed ones; minutes are the labour lines'. Costs: the CEO only. */
export function statementTotals(lines: Pick<LineRow, 'kind' | 'status' | 'amountMinor' | 'minutes' | 'costMinor'>[]) {
  const billed = lines.filter((l) => l.status !== 'removed');
  return {
    totalMinor: billed.reduce((t, l) => t + l.amountMinor, 0),
    minutes: billed.reduce((t, l) => t + (l.kind === 'labour' ? l.minutes ?? 0 : 0), 0),
    costMinor: billed.reduce((t, l) => t + (l.costMinor ?? 0), 0),
    costMissing: billed.some((l) => l.kind === 'labour' && l.costMinor === null),
  };
}

function toStatement(s: StatementRow, lines: LineRow[], people: Map<number, PersonRow>, costs: boolean): IcStatement {
  const totals = statementTotals(lines);
  const who = (id: number | null) => (id === null ? null : people.get(id)!);
  return {
    publicId: s.publicId, agreementPublicId: s.agreementPublicId, provider: s.provider, receiver: s.receiver, year: s.year, month: s.month,
    status: s.status as IcStatement['status'], currency: s.currency, round: s.round, totalMinor: totals.totalMinor, minutes: totals.minutes,
    costMinor: costs ? totals.costMinor : null,
    preparedBy: who(s.preparedBy)!, preparedAt: s.preparedAt.toISOString(),
    approved: s.approvedBy !== null ? { by: who(s.approvedBy)!, at: s.approvedAt!.toISOString(), as: s.approvedAs as 'head' | 'ceo' } : null,
    firstSentAt: s.firstSentAt?.toISOString() ?? null, sentAt: s.sentAt?.toISOString() ?? null, reviewDueOn: s.reviewDueOn,
    accepted: s.acceptedAt ? { at: s.acceptedAt.toISOString(), as: s.acceptedAs as 'receiver' | 'automatic', by: who(s.acceptedBy) } : null,
    invoice: s.invoiceNumber ? { number: s.invoiceNumber, on: s.invoicedOn!, by: who(s.invoicedBy)! } : null,
    closed: s.closedAt ? { paidOn: s.paidOn!, paymentRef: s.paymentRef!, by: who(s.closedBy)!, at: s.closedAt.toISOString() } : null,
  };
}
