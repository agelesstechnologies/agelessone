import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AddAdjustmentRequest, AddBankAccountRequest, AddSalaryRequest, BankAccount, BankAccountsQuery, CreateRunRequest, MarkRunPaidRequest,
  PayrollItem, PayrollRun, PayrollRunSummary, PayrollStatus, Payslip, RunsQuery, Salary, SalariesQuery, UpdateAdjustmentRequest,
} from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { isManagement, RequestContext, requireAll } from '../../../platform/http/request-context';
import { rupees, toCsv } from '../../../platform/csv';
import { PdfLine, textPdf } from '../../../platform/pdf';
import { CoreFacade } from '../../core/core.facade';
import { HrmsFacade } from '../../hrms/hrms.facade';
import { PayrollRepository, RunRow } from '../infrastructure/payroll.repository';
import { monthDates, netPay, payFor } from '../domain/pay';
import { inr, maskAccount, monthName } from '../domain/format';
import { PAYROLL } from '../domain/permissions';

type ItemRow = Awaited<ReturnType<PayrollRepository['items']>>[number];
type AdjustmentRow = Awaited<ReturnType<PayrollRepository['adjustmentsOf']>>[number];

/**
 * Use cases live here. One fixed monthly salary per job; one payroll run per company per month, made once that month's
 * attendance is locked. A draft is recalculated and adjusted freely; approval (by someone other than whoever prepared
 * it last) freezes it; then it is marked paid. Only the payroll roles see salaries and runs; everyone sees their own payslips.
 */
@Injectable()
export class PayrollService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PayrollRepository) private readonly repo: PayrollRepository,
    @Inject(HrmsFacade) private readonly hrms: HrmsFacade,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  health() { return { module: 'payroll', ok: true }; }

  // ---- salaries and bank accounts ----

  async salaries(ctx: RequestContext, q: SalariesQuery): Promise<Salary[]> {
    this.requireStaff(ctx);
    return (await this.repo.salaries(ctx.tenantId, q)).map(toSalary);
  }

  /** A job's salary from a date. Nothing is edited: a change is a new row. The same publicId again: the stored row. */
  async addSalary(ctx: RequestContext, req: AddSalaryRequest): Promise<{ salary: Salary; created: boolean }> {
    requireAll(ctx, PAYROLL.prepare);
    const publicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const tenant = await this.repo.findSalaryTenant(req.publicId);
      if (tenant === ctx.tenantId) return { salary: toSalary((await this.repo.salaries(ctx.tenantId, { publicId }))[0]), created: false };
      if (tenant !== undefined) throw new AppError('PAYROLL_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const job = await this.job(ctx, req.employmentPublicId);
    try {
      await this.repo.insertSalary({ tenantId: ctx.tenantId, publicId, employmentId: job.id, legalEntityId: job.legalEntityId,
        monthlyAmountPaise: req.monthlyAmountPaise, effectiveFrom: req.effectiveFrom, note: req.note, createdBy: ctx.personId });
    } catch (err) {
      if (violatedConstraint(err) === 'salaries_employment_from_unique') throw new AppError('PAYROLL_SALARY_EXISTS', 409, 'This job already has a salary from that date');
      throw err;
    }
    return { salary: toSalary((await this.repo.salaries(ctx.tenantId, { publicId }))[0]), created: true };
  }

  async bankAccounts(ctx: RequestContext, q: BankAccountsQuery): Promise<BankAccount[]> {
    this.requireStaff(ctx);
    return (await this.repo.bankAccounts(ctx.tenantId, q)).map(toBankAccount);
  }

  async addBankAccount(ctx: RequestContext, req: AddBankAccountRequest): Promise<{ account: BankAccount; created: boolean }> {
    requireAll(ctx, PAYROLL.prepare);
    const publicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const tenant = await this.repo.findBankTenant(req.publicId);
      if (tenant === ctx.tenantId) return { account: toBankAccount((await this.repo.bankAccounts(ctx.tenantId, { publicId }))[0]), created: false };
      if (tenant !== undefined) throw new AppError('PAYROLL_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const job = await this.job(ctx, req.employmentPublicId);
    try {
      await this.repo.insertBankAccount({ tenantId: ctx.tenantId, publicId, employmentId: job.id, legalEntityId: job.legalEntityId,
        accountHolder: req.accountHolder, accountNumber: req.accountNumber, ifsc: req.ifsc, effectiveFrom: req.effectiveFrom, createdBy: ctx.personId });
    } catch (err) {
      if (violatedConstraint(err) === 'bank_accounts_employment_from_unique') throw new AppError('PAYROLL_BANK_EXISTS', 409, 'This job already has bank details from that date');
      throw err;
    }
    return { account: toBankAccount((await this.repo.bankAccounts(ctx.tenantId, { publicId }))[0]), created: true };
  }

  // ---- runs ----

  async runs(ctx: RequestContext, q: RunsQuery): Promise<PayrollRunSummary[]> {
    this.requireStaff(ctx);
    return (await this.repo.runs(ctx.tenantId, q)).map(toSummary);
  }

  async run(ctx: RequestContext, publicId: string): Promise<PayrollRun> {
    this.requireStaff(ctx);
    return this.view(ctx.tenantId, publicId);
  }

  /**
   * The company's run for a month — only once that month's attendance is locked (HRMS_MONTH_NOT_LOCKED). It pays every
   * job held in the month that has a salary in force. Asking again for the same month answers the existing run.
   */
  async createRun(ctx: RequestContext, req: CreateRunRequest): Promise<{ run: PayrollRun; created: boolean }> {
    requireAll(ctx, PAYROLL.prepare);
    const company = await this.repo.findCompany(ctx.tenantId, req.company);
    if (!company) throw new AppError('PAYROLL_UNKNOWN_COMPANY', 400, `Unknown company ${req.company}`);
    const existing = await this.repo.findRun(ctx.tenantId, company.id, req.year, req.month);
    if (existing) return { run: await this.view(ctx.tenantId, existing.publicId), created: false };
    await this.requireLockedMonth(this.db, company.id, req.year, req.month);
    let publicId: string;
    try {
      publicId = await this.db.transaction(async (tx) => {
        const run = await this.repo.insertRun(tx, { tenantId: ctx.tenantId, legalEntityId: company.id, year: req.year, month: req.month, preparedBy: ctx.personId });
        await this.calculate(tx, ctx.tenantId, { id: run.id, legalEntityId: company.id, company: company.code, year: req.year, month: req.month });
        return run.publicId;
      });
    } catch (err) {
      if (violatedConstraint(err) === 'payroll_runs_company_month_unique') return this.createRun(ctx, req); // the same request twice at once
      throw err;
    }
    return { run: await this.view(ctx.tenantId, publicId), created: true };
  }

  /** Draft only: recalculate every person's pay from salaries and the locked attendance; adjustments are kept. */
  async recalculate(ctx: RequestContext, publicId: string): Promise<PayrollRun> {
    requireAll(ctx, PAYROLL.prepare);
    await this.db.transaction(async (tx) => {
      const run = await this.draftRun(tx, ctx, publicId);
      await this.requireLockedMonth(tx, run.legalEntityId, run.year, run.month);
      await this.calculate(tx, ctx.tenantId, run);
      await this.repo.setPrepared(tx, run.id, ctx.personId);
    });
    return this.view(ctx.tenantId, publicId);
  }

  /** Payroll Approver: freezes the run. Never by whoever prepared it last (created, recalculated or adjusted it). */
  async approve(ctx: RequestContext, publicId: string): Promise<PayrollRun> {
    requireAll(ctx, PAYROLL.approve);
    await this.db.transaction(async (tx) => {
      const run = await this.draftRun(tx, ctx, publicId);
      if (run.preparedBy === ctx.personId) throw new AppError('PAYROLL_SELF_APPROVAL', 403, 'Nobody approves a payroll run they prepared');
      if ((await this.repo.items(tx, { runIds: [run.id] })).length === 0) throw new AppError('PAYROLL_RUN_EMPTY', 409, 'Nobody is paid in this run');
      await this.repo.approve(tx, run.id, ctx.personId);
    });
    return this.view(ctx.tenantId, publicId);
  }

  async markPaid(ctx: RequestContext, publicId: string, req: MarkRunPaidRequest): Promise<PayrollRun> {
    requireAll(ctx, PAYROLL.prepare);
    await this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, ctx, publicId);
      if (run.status !== 'approved') throw new AppError('PAYROLL_RUN_NOT_APPROVED', 409, 'Only an approved run can be marked paid');
      await this.repo.markPaid(tx, run.id, new Date(req.paidAt), req.bankRef);
    });
    return this.view(ctx.tenantId, publicId);
  }

  // ---- adjustments (draft only) ----

  async addAdjustment(ctx: RequestContext, itemPublicId: string, req: AddAdjustmentRequest): Promise<{ run: PayrollRun; created: boolean }> {
    requireAll(ctx, PAYROLL.prepare);
    const publicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const owner = await this.repo.findAdjustmentTenant(req.publicId);
      if (owner && owner.tenantId !== ctx.tenantId) throw new AppError('PAYROLL_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    let runPublicId = '';
    let created = true;
    await this.db.transaction(async (tx) => {
      const item = await this.repo.lockItem(tx, ctx.tenantId, itemPublicId);
      if (!item) throw new AppError('PAYROLL_ITEM_NOT_FOUND', 404, 'Payroll line not found');
      runPublicId = item.runPublicId;
      const run = await this.draftRun(tx, ctx, item.runPublicId);
      if (req.publicId && (await this.repo.findAdjustmentTenant(req.publicId))) { created = false; return; } // sent again
      await this.repo.insertAdjustment(tx, { tenantId: ctx.tenantId, publicId, itemId: item.id, kind: req.kind, label: req.label,
        amountPaise: req.amountPaise, note: req.note, createdBy: ctx.personId });
      await this.retotal(tx, item.id, item.salaryForMonthPaise);
      await this.repo.setPrepared(tx, run.id, ctx.personId);
    });
    return { run: await this.view(ctx.tenantId, runPublicId), created };
  }

  async updateAdjustment(ctx: RequestContext, publicId: string, req: UpdateAdjustmentRequest): Promise<PayrollRun> {
    return this.changeAdjustment(ctx, publicId, (tx, id) => this.repo.updateAdjustment(tx, id, req));
  }

  async removeAdjustment(ctx: RequestContext, publicId: string): Promise<PayrollRun> {
    return this.changeAdjustment(ctx, publicId, (tx, id) => this.repo.deleteAdjustment(tx, id));
  }

  // ---- payslips and files ----

  /** My payslips from approved or paid runs, newest first. */
  async payslipsMine(ctx: RequestContext): Promise<Payslip[]> {
    const items = await this.repo.items(this.db, { personId: ctx.personId });
    const runs = new Map((await this.repo.runs(ctx.tenantId, {})).filter((r) => r.status !== 'draft').map((r) => [r.id, r]));
    const mine = items.filter((i) => runs.has(i.runId));
    const adjustments = await this.repo.adjustmentsOf(this.db, mine.map((i) => i.id));
    return mine.map((i) => ({ run: payslipRun(runs.get(i.runId)!), item: toItem(i, adjustments) }))
      .sort((a, b) => b.run.year - a.run.year || b.run.month - a.run.month);
  }

  /** The payslip PDF: for the person themselves, or the payroll roles. Only from an approved or paid run. */
  async payslipPdf(ctx: RequestContext, itemPublicId: string): Promise<{ name: string; data: Buffer }> {
    const [item] = await this.repo.items(this.db, { itemPublicId });
    if (!item || (await this.repo.runs(ctx.tenantId, {})).every((r) => r.id !== item.runId)) throw new AppError('PAYROLL_ITEM_NOT_FOUND', 404, 'Payslip not found');
    if (item.personId !== ctx.personId && !this.isStaff(ctx)) throw new AppError('FORBIDDEN', 403, 'You can only see your own payslip');
    const run = (await this.repo.runs(ctx.tenantId, {})).find((r) => r.id === item.runId)!;
    if (run.status === 'draft') throw new AppError('PAYROLL_RUN_NOT_APPROVED', 409, 'Payslips are ready once the run is approved');
    const p = toItem(item, await this.repo.adjustmentsOf(this.db, [item.id]));
    const lines: PdfLine[] = [
      { text: run.companyName, bold: true, size: 15 },
      { text: `Payslip - ${monthName(run.year, run.month)}`, bold: true, size: 12, gapBefore: 4 },
      { text: `Status: ${run.status}`, value: `Produced at: ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC`, size: 9 },
      { text: `Employee: ${p.person.displayName}`, value: `Code: ${p.employment.employeeCode}`, gapBefore: 10 },
      { text: 'Monthly salary', value: inr(p.monthlySalaryPaise), gapBefore: 12 },
      { text: `Days in month (basis) / days employed`, value: `${p.daysInMonth} / ${p.employedDays}` },
      { text: `Loss-of-pay days`, value: String(p.absentDays) },
      { text: 'Loss of pay', value: `- ${inr(p.lopAmountPaise)}` },
      { text: 'Salary for the month', value: inr(p.salaryForMonthPaise), bold: true },
      ...p.adjustments.map((a, i) => ({ text: `${a.kind === 'addition' ? 'Addition' : 'Deduction'}: ${a.label}`,
        value: `${a.kind === 'addition' ? '+' : '-'} ${inr(a.amountPaise)}`, gapBefore: i === 0 ? 8 : 0 })),
      { text: 'Net pay', value: inr(p.netPayPaise), bold: true, size: 12, gapBefore: 12 },
    ];
    return { name: `payslip-${run.company}-${run.year}-${String(run.month).padStart(2, '0')}-${p.employment.employeeCode}.pdf`, data: textPdf(lines) };
  }

  /** Salary register CSV: one line per person with every figure, and a TOTAL line. Approved or paid runs only. */
  async registerCsv(ctx: RequestContext, publicId: string): Promise<{ name: string; body: string }> {
    this.requireStaff(ctx);
    const run = await this.view(ctx.tenantId, publicId, true);
    const cols = (i: PayrollItem) => [i.monthlySalaryPaise, i.lopAmountPaise, i.salaryForMonthPaise, i.additionsTotalPaise, i.deductionsTotalPaise, i.netPayPaise];
    const sum = run.items.reduce((t, i) => cols(i).map((v, k) => t[k] + v), [0, 0, 0, 0, 0, 0]);
    const body = toCsv(this.about(run, 'Salary register'),
      ['Employee code', 'Name', 'Monthly salary', 'Days in month', 'Days employed', 'Loss-of-pay days', 'Loss of pay', 'Salary for month',
        'Additions', 'Deductions', 'Net pay', 'Adjustments'],
      [
        ...run.items.map((i) => [i.employment.employeeCode, i.person.displayName, rupees(i.monthlySalaryPaise), i.daysInMonth, i.employedDays, i.absentDays,
          rupees(i.lopAmountPaise), rupees(i.salaryForMonthPaise), rupees(i.additionsTotalPaise), rupees(i.deductionsTotalPaise), rupees(i.netPayPaise),
          i.adjustments.map((a) => `${a.kind === 'addition' ? '+' : '-'}${a.label} ${rupees(a.amountPaise)}`).join('; ')]),
        ['TOTAL', `${run.items.length} people`, rupees(sum[0]), '', '', '', rupees(sum[1]), rupees(sum[2]), rupees(sum[3]), rupees(sum[4]), rupees(sum[5]), ''],
      ]);
    return { name: `salary-register-${run.company}-${run.year}-${String(run.month).padStart(2, '0')}.csv`, body };
  }

  /** Bank upload CSV: name, account, IFSC, amount for everyone with bank details; those without are counted on top. */
  async bankCsv(ctx: RequestContext, publicId: string): Promise<{ name: string; body: string }> {
    this.requireStaff(ctx);
    const run = await this.view(ctx.tenantId, publicId, true);
    const items = await this.repo.items(this.db, { runIds: [(await this.repo.runs(ctx.tenantId, { publicId }))[0].id] });
    const { to } = monthDates(run.year, run.month);
    const banks = new Map((await this.repo.bankInForce(items.map((i) => i.employmentId), to)).map((b) => [b.employmentId, b]));
    const payable = items.filter((i) => banks.has(i.employmentId) && i.netPayPaise > 0);
    const missing = items.filter((i) => !banks.has(i.employmentId)).map((i) => i.employeeCode);
    const body = toCsv(
      [...this.about(run, 'Bank upload'), ['Without bank details', missing.length ? missing.join(' ') : 'none'],
        ['Total', rupees(payable.reduce((s, i) => s + i.netPayPaise, 0))]],
      ['Name', 'Account number', 'IFSC', 'Amount', 'Employee code', 'Narration'],
      payable.map((i) => {
        const b = banks.get(i.employmentId)!;
        return [b.accountHolder, b.accountNumber, b.ifsc, rupees(i.netPayPaise), i.employeeCode, `Salary ${monthName(run.year, run.month)}`];
      }));
    return { name: `bank-upload-${run.company}-${run.year}-${String(run.month).padStart(2, '0')}.csv`, body };
  }

  // ---- inside ----

  /**
   * Every person's pay for the run's month: jobs held in the month with a salary in force on its last day, absent days
   * (absences + unpaid leave) from HRMS, loss-of-pay basis from policy. Existing adjustments are kept.
   */
  private async calculate(tx: Tx, tenantId: number, run: { id: number; legalEntityId: number; company: string; year: number; month: number }) {
    const { from, to } = monthDates(run.year, run.month);
    const jobs = await this.repo.jobsInMonth(tx, run.legalEntityId, from, to);
    const salaryOf = new Map((await this.repo.salariesInForce(tx, jobs.map((j) => j.id), to)).map((s) => [s.employmentId, s.monthlyAmountPaise]));
    const absent = await this.hrms.absentDaysForPayroll(tenantId, run.company, from, to);
    const basis = await this.core.getPolicy(tenantId, 'payroll.lop_basis', run.legalEntityId, to);
    const existing = await this.repo.items(tx, { runIds: [run.id] });
    const adjustments = await this.repo.adjustmentsOf(tx, existing.map((i) => i.id));
    const paid = jobs.filter((j) => salaryOf.has(j.id));
    for (const j of paid) {
      const pay = payFor({ monthlyPaise: salaryOf.get(j.id)!, year: run.year, month: run.month, joinedOn: j.joinedOn, exitOn: j.exitOn,
        absentDays: absent[j.publicId] ?? 0, basis });
      const item = existing.find((i) => i.employmentId === j.id);
      const totals = netPay(pay.salaryForMonthPaise, item ? adjustments.filter((a) => a.itemId === item.id).map(adj) : []);
      if (totals.netPaise < 0) throw new AppError('PAYROLL_NET_NEGATIVE', 409, `Deductions are more than the pay of ${j.personName}`);
      await this.repo.upsertItem(tx, {
        tenantId, runId: run.id, employmentId: j.id, legalEntityId: run.legalEntityId, monthlySalaryPaise: salaryOf.get(j.id)!,
        daysInMonth: pay.daysInMonth, employedDays: pay.employedDays, absentDays: pay.absentDays, lopAmountPaise: pay.lopPaise,
        salaryForMonthPaise: pay.salaryForMonthPaise, additionsTotalPaise: totals.additionsPaise, deductionsTotalPaise: totals.deductionsPaise,
        netPayPaise: totals.netPaise,
      });
    }
    await this.repo.removeItemsExcept(tx, run.id, paid.map((j) => j.id));
  }

  /** An item's additions, deductions and net pay from its adjustments. */
  private async retotal(tx: Tx, itemId: number, salaryForMonthPaise: number): Promise<void> {
    const t = netPay(salaryForMonthPaise, (await this.repo.adjustmentsOf(tx, [itemId])).map(adj));
    if (t.netPaise < 0) throw new AppError('PAYROLL_NET_NEGATIVE', 409, 'Deductions would be more than the pay');
    await this.repo.setItemTotals(tx, itemId, { additionsTotalPaise: t.additionsPaise, deductionsTotalPaise: t.deductionsPaise, netPayPaise: t.netPaise });
  }

  private async changeAdjustment(ctx: RequestContext, publicId: string, change: (tx: Tx, id: number) => Promise<void>): Promise<PayrollRun> {
    requireAll(ctx, PAYROLL.prepare);
    let runPublicId = '';
    await this.db.transaction(async (tx) => {
      const a = await this.repo.findAdjustment(tx, ctx.tenantId, publicId);
      if (!a) throw new AppError('PAYROLL_ADJUSTMENT_NOT_FOUND', 404, 'Adjustment not found');
      const item = (await this.repo.lockItem(tx, ctx.tenantId, a.itemPublicId))!;
      runPublicId = item.runPublicId;
      const run = await this.draftRun(tx, ctx, item.runPublicId);
      await change(tx, a.id);
      await this.retotal(tx, item.id, item.salaryForMonthPaise);
      await this.repo.setPrepared(tx, run.id, ctx.personId);
    });
    return this.view(ctx.tenantId, runPublicId);
  }

  private async view(tenantId: number, publicId: string, approvedOnly = false): Promise<PayrollRun> {
    const [r] = await this.repo.runs(tenantId, { publicId });
    if (!r) throw new AppError('PAYROLL_RUN_NOT_FOUND', 404, 'Payroll run not found');
    if (approvedOnly && r.status === 'draft') throw new AppError('PAYROLL_RUN_NOT_APPROVED', 409, 'Files are ready once the run is approved');
    const items = await this.repo.items(this.db, { runIds: [r.id] });
    const adjustments = await this.repo.adjustmentsOf(this.db, items.map((i) => i.id));
    let withoutSalary: PayrollRun['withoutSalary'] = [];
    if (r.status === 'draft') {
      const { from, to } = monthDates(r.year, r.month);
      const jobs = await this.repo.jobsInMonth(this.db, r.legalEntityId, from, to);
      const withSalary = new Set((await this.repo.salariesInForce(this.db, jobs.map((j) => j.id), to)).map((s) => s.employmentId));
      withoutSalary = jobs.filter((j) => !withSalary.has(j.id)).map((j) => ({
        person: { publicId: j.personPublicId, displayName: j.personName }, employment: { publicId: j.publicId, company: r.company, employeeCode: j.employeeCode },
      }));
    }
    return { ...toSummary(r), items: items.map((i) => toItem(i, adjustments)), withoutSalary };
  }

  private about(run: PayrollRun, report: string): [string, string][] {
    return [['Report', report], ['Company', run.company], ['Month', monthName(run.year, run.month)], ['Status', run.status],
      ['Produced at', new Date().toISOString()]];
  }

  private async lockRun(tx: Tx, ctx: RequestContext, publicId: string) {
    const run = await this.repo.lockRun(tx, ctx.tenantId, publicId);
    if (!run) throw new AppError('PAYROLL_RUN_NOT_FOUND', 404, 'Payroll run not found');
    return run;
  }

  private async draftRun(tx: Tx, ctx: RequestContext, publicId: string) {
    const run = await this.lockRun(tx, ctx, publicId);
    if (run.status !== 'draft') throw new AppError('PAYROLL_RUN_NOT_DRAFT', 409, `The run is ${run.status}: nothing in it can change`);
    return run;
  }

  private async requireLockedMonth(conn: Conn, legalEntityId: number, year: number, month: number): Promise<void> {
    if (!(await this.repo.isMonthLocked(conn, legalEntityId, year, month))) {
      throw new AppError('HRMS_MONTH_NOT_LOCKED', 409, `Lock ${monthName(year, month)} attendance for the company first`);
    }
  }

  private async job(ctx: RequestContext, publicId: string) {
    const job = await this.repo.findEmployment(ctx.tenantId, publicId);
    if (!job) throw new AppError('HRMS_EMPLOYMENT_NOT_FOUND', 404, 'Employment not found');
    return job;
  }

  private isStaff(ctx: RequestContext): boolean {
    return ctx.permissions[PAYROLL.prepare] === 'all' || ctx.permissions[PAYROLL.approve] === 'all' || isManagement(ctx);
  }

  /** Salaries, bank details and runs: only the payroll roles. */
  private requireStaff(ctx: RequestContext): void {
    if (!this.isStaff(ctx)) throw new AppError('FORBIDDEN', 403, 'Only the payroll roles see salaries and payroll runs');
  }
}

const adj = (a: AdjustmentRow) => ({ kind: a.kind as 'addition' | 'deduction', amountPaise: a.amountPaise });

function toSalary(r: Awaited<ReturnType<PayrollRepository['salaries']>>[number]): Salary {
  return {
    publicId: r.publicId, person: { publicId: r.personPublicId, displayName: r.personName },
    employment: { publicId: r.employmentPublicId, company: r.company, employeeCode: r.employeeCode },
    monthlyAmountPaise: r.monthlyAmountPaise, currency: r.currency, effectiveFrom: r.effectiveFrom, note: r.note,
    createdBy: { publicId: r.creatorPublicId, displayName: r.creatorName }, createdAt: r.createdAt.toISOString(),
  };
}

function toBankAccount(r: Awaited<ReturnType<PayrollRepository['bankAccounts']>>[number]): BankAccount {
  return {
    publicId: r.publicId, person: { publicId: r.personPublicId, displayName: r.personName },
    employment: { publicId: r.employmentPublicId, company: r.company, employeeCode: r.employeeCode },
    accountHolder: r.accountHolder, accountNumberMasked: maskAccount(r.accountNumber), ifsc: r.ifsc,
    effectiveFrom: r.effectiveFrom, createdAt: r.createdAt.toISOString(),
  };
}

function toSummary(r: RunRow): PayrollRunSummary {
  return {
    publicId: r.publicId, company: r.company, year: r.year, month: r.month, status: r.status as PayrollStatus, currency: r.currency,
    preparedBy: { publicId: r.preparerPublicId, displayName: r.preparerName }, preparedAt: r.preparedAt.toISOString(),
    approvedBy: r.approverPublicId ? { publicId: r.approverPublicId, displayName: r.approverName! } : null,
    approvedAt: r.approvedAt?.toISOString() ?? null, paidAt: r.paidAt?.toISOString() ?? null, bankRef: r.bankRef,
    totals: { people: r.people, salaryForMonthPaise: r.salaryForMonthPaise, additionsPaise: r.additionsPaise, deductionsPaise: r.deductionsPaise, netPaise: r.netPaise },
  };
}

function toItem(i: ItemRow, adjustments: AdjustmentRow[]): PayrollItem {
  return {
    publicId: i.publicId, person: { publicId: i.personPublicId, displayName: i.personName },
    employment: { publicId: i.employmentPublicId, company: i.company, employeeCode: i.employeeCode }, currency: i.currency,
    monthlySalaryPaise: i.monthlySalaryPaise, daysInMonth: i.daysInMonth, employedDays: i.employedDays, absentDays: Number(i.absentDays),
    lopAmountPaise: i.lopAmountPaise, salaryForMonthPaise: i.salaryForMonthPaise, additionsTotalPaise: i.additionsTotalPaise,
    deductionsTotalPaise: i.deductionsTotalPaise, netPayPaise: i.netPayPaise,
    adjustments: adjustments.filter((a) => a.itemId === i.id).map(({ itemId: _i, kind, ...a }) => ({ ...a, kind: kind as 'addition' | 'deduction' })),
  };
}

function payslipRun(r: RunRow): Payslip['run'] {
  return { publicId: r.publicId, company: r.company, companyName: r.companyName, year: r.year, month: r.month, status: r.status as PayrollStatus };
}
