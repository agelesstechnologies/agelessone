import { Inject, Injectable } from '@nestjs/common';
import {
  IcBalanceQuery, IcBalanceReport, IcBilledReport, IcDashboard, IcDisputesReport, IcMarginReport, IcReceiverCostReport, IcReportQuery, IcUnbilledReport,
} from '@ageless/shared';
import { DB, Db } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { addDays, todayIst } from '../../../platform/time';
import { rupees, toCsv } from '../../../platform/csv';
import { IntercompanyRepository } from '../infrastructure/intercompany.repository';
import { StatementRow, StatementsRepository } from '../infrastructure/statements.repository';
import { canSeeAgreement, isCurrentJob, monthEnd, monthOf, monthStart } from '../domain/agreements';
import { INTERCOMPANY } from '../domain/permissions';
import { statementTotals } from './statements.service';

type Csv = { name: string; body: string };
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
const hours = (minutes: number | null) => (minutes === null ? null : (minutes / 60).toFixed(2));
const projectText = (p: { kind: string; publicId: string } | null) => (p ? `${p.kind}:${p.publicId}` : '');

/**
 * Intercompany reports (JSON, or CSV with format=csv) and the CEO's dashboard cards. Rows come from the agreements the
 * caller sees (the two company heads, and the CEO with scope all). Margin and the dashboard: the CEO only.
 */
@Injectable()
export class IcReportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(IntercompanyRepository) private readonly ic: IntercompanyRepository,
    @Inject(StatementsRepository) private readonly repo: StatementsRepository,
  ) {}

  /** Billed hours and amounts: every line (but removed ones) of statements past draft. */
  async billed(ctx: RequestContext, q: IcReportQuery): Promise<IcBilledReport> {
    const statements = await this.statements(ctx, q);
    const lines = (await this.repo.lines(this.db, statements.map((s) => s.id))).filter((l) => l.status !== 'removed');
    const of = new Map(statements.map((s) => [s.id, s]));
    const rows = lines.map((l) => {
      const s = of.get(l.statementId)!;
      return { month: ym(s.year, s.month), provider: s.provider, receiver: s.receiver, statementPublicId: s.publicId, status: s.status as IcBilledReport['rows'][number]['status'],
        kind: l.kind as IcBilledReport['rows'][number]['kind'], serviceType: l.serviceType as IcBilledReport['rows'][number]['serviceType'],
        project: project(l), person: l.personName, grade: l.grade, minutes: l.minutes, rateMinor: l.rateMinor, amountMinor: l.amountMinor };
    });
    return { from: q.from, to: q.to, rows, totalMinutes: rows.reduce((t, r) => t + (r.kind === 'labour' ? r.minutes ?? 0 : 0), 0),
      totalMinor: rows.reduce((t, r) => t + r.amountMinor, 0) };
  }

  billedCsv(r: IcBilledReport): Csv {
    return { name: `intercompany-billed-${r.from}-${r.to}.csv`, body: toCsv(about('Billed hours and amounts', r), ['Month', 'Provider', 'Receiver', 'Status',
      'Line', 'Service', 'Project', 'Person', 'Grade', 'Hours', 'Rate per hour', 'Amount'],
    [...r.rows.map((x) => [x.month, x.provider, x.receiver, x.status, x.kind, x.serviceType, projectText(x.project), x.person, x.grade, hours(x.minutes),
      x.rateMinor === null ? null : rupees(x.rateMinor), rupees(x.amountMinor)]),
    ['TOTAL', '', '', '', '', '', '', '', '', hours(r.totalMinutes), '', rupees(r.totalMinor)]]) };
  }

  /** Billable ticket time in months with no statement past draft for its two companies. */
  async unbilled(ctx: RequestContext, q: IcReportQuery): Promise<IcUnbilledReport> {
    const pairs = await this.visiblePairs(ctx);
    const companies = await this.repo.companies(this.db, ctx.tenantId);
    const code = q.company?.toUpperCase();
    const time = (await this.repo.billableTime(this.db, ctx.tenantId, monthStart(monthOf(`${q.from}-01`)), monthEnd(monthOf(`${q.to}-01`))))
      .filter((t) => (pairs === 'all' || pairs.has(`${t.providerId}|${t.receiverId}`))
        && (!code || companies.get(t.providerId) === code || companies.get(t.receiverId) === code));
    const billed = await this.repo.billedPairMonths(this.db, ctx.tenantId, q.from, q.to);
    const open = time.filter((t) => !billed.has(`${t.providerId}|${t.receiverId}|${t.workDate.slice(0, 7)}`));
    const groups = new Map<string, { month: string; providerId: number; receiverId: number; ticketId: number; employmentId: number; minutes: number }>();
    for (const t of open) {
      const k = `${t.workDate.slice(0, 7)}|${t.ticketId}|${t.employmentId}`;
      const g = groups.get(k) ?? { month: t.workDate.slice(0, 7), providerId: t.providerId, receiverId: t.receiverId, ticketId: t.ticketId, employmentId: t.employmentId, minutes: 0 };
      g.minutes += t.minutes;
      groups.set(k, g);
    }
    const list = [...groups.values()];
    const [tickets, jobs] = await Promise.all([
      this.repo.billableTickets(this.db, ctx.tenantId, { ticketIds: [...new Set(list.map((g) => g.ticketId))] }),
      this.ic.jobs(this.db, list.map((g) => g.employmentId)),
    ]);
    const ticketOf = new Map(tickets.map((t) => [t.ticketId, t]));
    const rows = list.map((g) => {
      const t = ticketOf.get(g.ticketId)!;
      const j = jobs.get(g.employmentId)!;
      return { month: g.month, provider: companies.get(g.providerId)!, receiver: companies.get(g.receiverId)!,
        ticket: { publicId: t.publicId, number: t.number, title: t.title }, serviceType: t.serviceType as IcUnbilledReport['rows'][number]['serviceType'],
        project: { kind: t.linkKind as 'project' | 'design_request', publicId: t.linkPublicId }, person: { publicId: j.personPublicId, displayName: j.displayName },
        minutes: g.minutes };
    }).sort((a, b) => a.month.localeCompare(b.month) || a.ticket.number.localeCompare(b.ticket.number) || a.person.displayName.localeCompare(b.person.displayName));
    return { from: q.from, to: q.to, rows, totalMinutes: rows.reduce((t, r) => t + r.minutes, 0) };
  }

  unbilledCsv(r: IcUnbilledReport): Csv {
    return { name: `intercompany-unbilled-${r.from}-${r.to}.csv`, body: toCsv(about('Unbilled billable hours', r), ['Month', 'Provider', 'Receiver', 'Ticket',
      'Title', 'Service', 'Project', 'Person', 'Hours'],
    [...r.rows.map((x) => [x.month, x.provider, x.receiver, x.ticket.number, x.ticket.title, x.serviceType, projectText(x.project), x.person.displayName, hours(x.minutes)]),
      ['TOTAL', '', '', '', '', '', '', '', hours(r.totalMinutes)]]) };
  }

  /** Every disputed line (the latest dispute and how the provider answered it). */
  async disputes(ctx: RequestContext, q: IcReportQuery): Promise<IcDisputesReport> {
    const statements = await this.statements(ctx, q);
    const of = new Map(statements.map((s) => [s.id, s]));
    const lines = await this.repo.lines(this.db, statements.map((s) => s.id), { disputedOnly: true });
    const people = await this.ic.persons(this.db, lines.flatMap((l) => [l.disputedBy, l.resolvedBy]));
    return { from: q.from, to: q.to, rows: lines.map((l) => {
      const s = of.get(l.statementId)!;
      return { month: ym(s.year, s.month), provider: s.provider, receiver: s.receiver, statementPublicId: s.publicId, linePublicId: l.publicId,
        description: l.description, amountMinor: l.amountMinor, originalAmountMinor: l.originalAmountMinor, reason: l.disputeReason!,
        disputedBy: people.get(l.disputedBy!)!, disputedAt: l.disputedAt!.toISOString(),
        resolution: l.resolution as IcDisputesReport['rows'][number]['resolution'], resolutionReason: l.resolutionReason,
        resolvedBy: l.resolvedBy === null ? null : people.get(l.resolvedBy)!, resolvedAt: l.resolvedAt?.toISOString() ?? null,
        lineStatus: l.status as IcDisputesReport['rows'][number]['lineStatus'] };
    }) };
  }

  disputesCsv(r: IcDisputesReport): Csv {
    return { name: `intercompany-disputes-${r.from}-${r.to}.csv`, body: toCsv(about('Disputes', r), ['Month', 'Provider', 'Receiver', 'Line', 'Amount',
      'Amount before', 'Dispute', 'Disputed by', 'Disputed at', 'Answer', 'Answer reason', 'Answered by', 'Line status'],
    r.rows.map((x) => [x.month, x.provider, x.receiver, x.description, rupees(x.amountMinor), x.originalAmountMinor === null ? null : rupees(x.originalAmountMinor),
      x.reason, x.disputedBy.displayName, x.disputedAt, x.resolution, x.resolutionReason, x.resolvedBy?.displayName ?? null, x.lineStatus])) };
  }

  /** The CEO only: what was billed against what it cost (payroll cost of the hours, passed-on costs at cost). */
  async margin(ctx: RequestContext, q: IcReportQuery): Promise<IcMarginReport> {
    this.requireCeo(ctx);
    const statements = await this.statements(ctx, q);
    const lines = await this.repo.lines(this.db, statements.map((s) => s.id));
    const rows = statements.map((s) => {
      const t = statementTotals(lines.filter((l) => l.statementId === s.id));
      const margin = t.totalMinor - t.costMinor;
      return { month: ym(s.year, s.month), provider: s.provider, receiver: s.receiver, statementPublicId: s.publicId, status: s.status as IcMarginReport['rows'][number]['status'],
        billedMinor: t.totalMinor, costMinor: t.costMinor, marginMinor: margin,
        marginPercent: t.totalMinor === 0 ? null : Math.round((margin * 10_000) / t.totalMinor) / 100, costMissing: t.costMissing };
    });
    const sum = (k: 'billedMinor' | 'costMinor' | 'marginMinor') => rows.reduce((t, r) => t + r[k], 0);
    return { from: q.from, to: q.to, rows, billedMinor: sum('billedMinor'), costMinor: sum('costMinor'), marginMinor: sum('marginMinor') };
  }

  marginCsv(r: IcMarginReport): Csv {
    return { name: `intercompany-margin-${r.from}-${r.to}.csv`, body: toCsv(about('Margin (CEO only)', r), ['Month', 'Provider', 'Receiver', 'Status', 'Billed',
      'Cost', 'Margin', 'Margin %', 'Cost missing'],
    [...r.rows.map((x) => [x.month, x.provider, x.receiver, x.status, rupees(x.billedMinor), rupees(x.costMinor), rupees(x.marginMinor), x.marginPercent, x.costMissing]),
      ['TOTAL', '', '', '', rupees(r.billedMinor), rupees(r.costMinor), rupees(r.marginMinor), '', '']]) };
  }

  /** What each receiver pays per project: hours, labour, passed-on costs and credits (statements past draft). */
  async receiverCost(ctx: RequestContext, q: IcReportQuery): Promise<IcReceiverCostReport> {
    const statements = await this.statements(ctx, q);
    const of = new Map(statements.map((s) => [s.id, s]));
    const groups = new Map<string, IcReceiverCostReport['rows'][number]>();
    for (const l of (await this.repo.lines(this.db, statements.map((s) => s.id))).filter((x) => x.status !== 'removed')) {
      const s = of.get(l.statementId)!;
      const p = project(l);
      const k = `${s.receiver}|${s.provider}|${projectText(p)}`;
      const g = groups.get(k) ?? { receiver: s.receiver, provider: s.provider, project: p, minutes: 0, labourMinor: 0, passedCostsMinor: 0, creditsMinor: 0, totalMinor: 0 };
      if (l.kind === 'labour') { g.minutes += l.minutes ?? 0; g.labourMinor += l.amountMinor; }
      if (l.kind === 'passed_cost') g.passedCostsMinor += l.amountMinor;
      if (l.kind === 'credit') g.creditsMinor += l.amountMinor;
      g.totalMinor += l.amountMinor;
      groups.set(k, g);
    }
    const rows = [...groups.values()].sort((a, b) => a.receiver.localeCompare(b.receiver) || projectText(a.project).localeCompare(projectText(b.project)));
    return { from: q.from, to: q.to, rows, totalMinor: rows.reduce((t, r) => t + r.totalMinor, 0) };
  }

  receiverCostCsv(r: IcReceiverCostReport): Csv {
    return { name: `intercompany-receiver-cost-${r.from}-${r.to}.csv`, body: toCsv(about('Receiver\'s cost by project', r), ['Receiver', 'Provider', 'Project',
      'Hours', 'Labour', 'Passed-on costs', 'Credits', 'Total'],
    [...r.rows.map((x) => [x.receiver, x.provider, projectText(x.project), hours(x.minutes), rupees(x.labourMinor), rupees(x.passedCostsMinor),
      rupees(x.creditsMinor), rupees(x.totalMinor)]), ['TOTAL', '', '', '', '', '', '', rupees(r.totalMinor)]]) };
  }

  /**
   * The intercompany balance as of today: every invoice not yet paid (statement invoiced, not closed), its due date
   * (invoice date + the agreement's payment terms) and days overdue, and what each receiver owes each provider.
   */
  async balance(ctx: RequestContext, q: IcBalanceQuery): Promise<IcBalanceReport> {
    const today = todayIst();
    const visible = await this.visibleAgreementIds(ctx);
    const statements = (await this.repo.statements(this.db, ctx.tenantId, { status: 'invoiced' }))
      .filter((s) => (visible === 'all' || visible.has(s.agreementId)) && (!q.company || [s.provider, s.receiver].includes(q.company.toUpperCase())));
    const terms = new Map((await this.ic.agreements(this.db, ctx.tenantId, {})).map((a) => [a.id, a.paymentTermsDays]));
    const lines = await this.repo.lines(this.db, statements.map((s) => s.id));
    const rows = statements.map((s) => {
      const dueOn = addDays(s.invoicedOn!, terms.get(s.agreementId) ?? 0);
      const overdueDays = today > dueOn ? Math.round((Date.parse(today) - Date.parse(dueOn)) / 86_400_000) : 0;
      return { provider: s.provider, receiver: s.receiver, month: ym(s.year, s.month), statementPublicId: s.publicId, invoiceNumber: s.invoiceNumber!,
        invoicedOn: s.invoicedOn!, dueOn, amountMinor: statementTotals(lines.filter((l) => l.statementId === s.id)).totalMinor, overdueDays };
    }).sort((a, b) => a.provider.localeCompare(b.provider) || a.receiver.localeCompare(b.receiver) || a.dueOn.localeCompare(b.dueOn));
    const pairs = new Map<string, IcBalanceReport['pairs'][number]>();
    for (const r of rows) {
      const p = pairs.get(`${r.provider}|${r.receiver}`) ?? { provider: r.provider, receiver: r.receiver, amountMinor: 0, overdueMinor: 0 };
      p.amountMinor += r.amountMinor;
      if (r.overdueDays > 0) p.overdueMinor += r.amountMinor;
      pairs.set(`${r.provider}|${r.receiver}`, p);
    }
    return { asOf: today, rows, pairs: [...pairs.values()], totalMinor: rows.reduce((t, r) => t + r.amountMinor, 0) };
  }

  balanceCsv(r: IcBalanceReport): Csv {
    return { name: `intercompany-balance-${r.asOf}.csv`, body: toCsv([['Report', 'Intercompany balance (invoiced, not yet paid)'], ['As of', r.asOf],
      ['Produced', new Date().toISOString()]], ['Provider', 'Receiver', 'Month', 'Invoice', 'Invoice date', 'Due', 'Days overdue', 'Amount'],
    [...r.rows.map((x) => [x.provider, x.receiver, x.month, x.invoiceNumber, x.invoicedOn, x.dueOn, x.overdueDays, rupees(x.amountMinor)]),
      ['TOTAL', '', '', '', '', '', '', rupees(r.totalMinor)]]) };
  }

  /** The CEO's cards: billed this month (statements first sent this month, IST), unbilled hours, intercompany balance (invoiced, unpaid). */
  async dashboard(ctx: RequestContext): Promise<IcDashboard> {
    this.requireCeo(ctx);
    const today = todayIst();
    const month = today.slice(0, 7);
    const all = await this.repo.statements(this.db, ctx.tenantId, { notDraft: true });
    const lines = await this.repo.lines(this.db, all.map((s) => s.id));
    const total = (s: StatementRow) => statementTotals(lines.filter((l) => l.statementId === s.id)).totalMinor;
    const sentThisMonth = all.filter((s) => s.firstSentAt && todayIst(s.firstSentAt).startsWith(month));
    const balances = new Map<string, { provider: string; receiver: string; amountMinor: number }>();
    for (const s of all.filter((x) => x.status === 'invoiced')) {
      const b = balances.get(`${s.provider}|${s.receiver}`) ?? { provider: s.provider, receiver: s.receiver, amountMinor: 0 };
      b.amountMinor += total(s);
      balances.set(`${s.provider}|${s.receiver}`, b);
    }
    const billed = await this.repo.billedPairMonths(this.db, ctx.tenantId, '2000-01', month);
    const unbilled = (await this.repo.billableTime(this.db, ctx.tenantId, '2000-01-01', today))
      .filter((t) => !billed.has(`${t.providerId}|${t.receiverId}|${t.workDate.slice(0, 7)}`)).reduce((s, t) => s + t.minutes, 0);
    const list = [...balances.values()];
    return { asOf: new Date().toISOString(), month, billedThisMonthMinor: sentThisMonth.reduce((s, x) => s + total(x), 0), unbilledMinutes: unbilled,
      balanceMinor: list.reduce((s, b) => s + b.amountMinor, 0), balances: list };
  }

  // ---- helpers ----

  private seesAll(ctx: RequestContext): boolean {
    return ctx.permissions[INTERCOMPANY.view] === 'all' || ctx.permissions[INTERCOMPANY.manage] === 'all';
  }

  private requireCeo(ctx: RequestContext): void {
    if (!this.seesAll(ctx)) throw new AppError('IC_CEO_ONLY', 403, 'Only the CEO sees this');
  }

  /** Statements past draft in the months, of agreements the caller sees (and the company, either side, when given). */
  private async statements(ctx: RequestContext, q: IcReportQuery): Promise<StatementRow[]> {
    const rows = await this.repo.statements(this.db, ctx.tenantId, { from: q.from, to: q.to, notDraft: true });
    const visible = await this.visibleAgreementIds(ctx);
    return rows.filter((s) => (visible === 'all' || visible.has(s.agreementId)) && (!q.company || [s.provider, s.receiver].includes(q.company.toUpperCase())))
      .sort((a, b) => a.year - b.year || a.month - b.month || a.provider.localeCompare(b.provider));
  }

  private async visibleAgreementIds(ctx: RequestContext): Promise<'all' | Set<number>> {
    if (this.seesAll(ctx)) return 'all';
    const agreements = await this.ic.agreements(this.db, ctx.tenantId, {});
    const jobs = await this.ic.jobs(this.db, agreements.flatMap((a) => [a.providerHeadEmploymentId, a.receiverHeadEmploymentId]));
    const head = (id: number) => {
      const j = jobs.get(id);
      return { personId: j?.personId ?? -1, current: j !== undefined && isCurrentJob(j.status) };
    };
    return new Set(agreements.filter((a) => canSeeAgreement({ personId: ctx.personId, seesAll: false },
      { provider: head(a.providerHeadEmploymentId), receiver: head(a.receiverHeadEmploymentId) })).map((a) => a.id));
  }

  /** Provider|receiver pairs of the agreements the caller sees ('all' for the CEO). */
  private async visiblePairs(ctx: RequestContext): Promise<'all' | Set<string>> {
    const ids = await this.visibleAgreementIds(ctx);
    if (ids === 'all') return 'all';
    const agreements = (await this.ic.agreements(this.db, ctx.tenantId, {})).filter((a) => ids.has(a.id));
    return new Set(agreements.map((a) => `${a.legalEntityId}|${a.receiverLegalEntityId}`));
  }
}

const project = (l: { projectKind: string | null; projectPublicId: string | null }) =>
  l.projectKind && l.projectPublicId ? { kind: l.projectKind as 'project' | 'design_request', publicId: l.projectPublicId } : null;
const about = (title: string, r: { from: string; to: string }): [string, string][] =>
  [['Report', title], ['Months', `${r.from} to ${r.to}`], ['Produced', new Date().toISOString()]];
