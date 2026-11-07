import { Inject, Injectable } from '@nestjs/common';
import { ApprovalCounts, ApprovalItem, ApprovalsInbox, ApprovalsQuery } from '@ageless/shared';
import { RequestContext } from '../../../../platform/http/request-context';
import { todayIst } from '../../../../platform/time';
import { waitedTooLong as reasonWaited } from '../../../../platform/escalation';
import { CoreFacade } from '../../../core/core.facade';
import { LeaveService } from '../../leave/application/leave.service';
import { ExpensesService } from '../../expenses/application/expenses.service';
import { CorrectionsService } from '../../attendance/application/corrections.service';
import { OvertimeService } from '../../attendance/application/overtime.service';
import { daysBetween } from '../domain/dashboard';
import { waitedTooLong } from '../domain/escalation';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Everything the caller can decide, in one list (oldest first): leave, expenses, corrections and overtime. Each module
 * decides what is the caller's to decide (named approver, the job's manager for expenses, HR or Management for anyone's);
 * never the caller's own requests. Filters: only requests sent to the CEO (escalated), only one company.
 */
@Injectable()
export class ApprovalsInboxService {
  constructor(
    @Inject(LeaveService) private readonly leave: LeaveService,
    @Inject(ExpensesService) private readonly expenses: ExpensesService,
    @Inject(CorrectionsService) private readonly corrections: CorrectionsService,
    @Inject(OvertimeService) private readonly overtime: OvertimeService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  async mine(ctx: RequestContext, q: ApprovalsQuery = {}): Promise<ApprovalsInbox> {
    const now = new Date();
    const today = todayIst(now);
    const age = (submittedAt: string) => Math.max(0, daysBetween(todayIst(new Date(submittedAt)), today));
    const [leave, expenses, corrections, overtime] = await Promise.all([
      this.leave.toApprove(ctx), this.expenses.toApprove(ctx), this.corrections.toApprove(ctx), this.overtime.toApprove(ctx),
    ]);
    const all: ApprovalItem[] = [
      ...leave.map((r) => ({
        type: 'leave' as const, publicId: r.publicId, person: r.person, company: r.employment.company,
        fromDate: r.fromDate, toDate: r.toDate, amountPaise: null, currency: null,
        summary: `${r.leaveType.name}, ${r.days} day${r.days === 1 ? '' : 's'}`, submittedAt: r.createdAt, ageDays: age(r.createdAt),
        escalation: r.escalation,
      })),
      ...expenses.map((c) => ({
        type: 'expense' as const, publicId: c.publicId, person: c.person, company: c.employment.company,
        fromDate: c.spentOn, toDate: c.spentOn, amountPaise: c.amountPaise, currency: c.currency,
        summary: c.description ? `${c.category.name}: ${c.description}` : c.category.name, submittedAt: c.createdAt, ageDays: age(c.createdAt),
        escalation: c.escalation,
      })),
      ...corrections.map((c) => ({
        type: 'correction' as const, publicId: c.publicId, person: c.person, company: c.employment.company,
        fromDate: c.workDate, toDate: c.workDate, amountPaise: null, currency: null,
        summary: `Correction (${c.kind.replace('_', ' ')})`, submittedAt: c.createdAt, ageDays: age(c.createdAt),
        escalation: c.escalation,
      })),
      ...overtime.map((o) => ({
        type: 'overtime' as const, publicId: o.publicId, person: o.person, company: o.employment.company,
        fromDate: o.workDate, toDate: o.workDate, amountPaise: null, currency: null,
        summary: `Overtime ${plural(o.minutes, 'minute')}`, submittedAt: o.createdAt, ageDays: age(o.createdAt),
        escalation: o.escalation,
      })),
    ];
    const items = all
      .filter((i) => q.escalated === undefined || (i.escalation !== null) === q.escalated)
      .filter((i) => q.company === undefined || i.company === q.company)
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    const n = (type: ApprovalItem['type']) => items.filter((i) => i.type === type).length;
    return { asOf: now.toISOString(), counts: countsOf(n('leave'), n('expense'), n('correction'), n('overtime')), items };
  }

  /** Only the counts (for the dashboard). */
  async counts(ctx: RequestContext): Promise<ApprovalCounts> {
    return (await this.mine(ctx)).counts;
  }

  /**
   * The daily job: every request still waiting for a decision for at least the company's escalate_after_days
   * (POLICY hrms.approvals.escalate_after_days, 5 for now) is sent to the CEO, with no forwarder. Returns how many.
   */
  async escalateWaiting(now: Date = new Date()): Promise<number> {
    const today = todayIst(now);
    const policy = new Map<string, number>();
    const afterDays = async (tenantId: number, companyId: number) => {
      const key = `${tenantId}:${companyId}`;
      if (!policy.has(key)) policy.set(key, await this.core.getPolicy(tenantId, 'hrms.approvals.escalate_after_days', companyId, today));
      return policy.get(key)!;
    };
    const createdBefore = new Date(now.getTime() - 86_400_000); // nothing younger than a day can have waited long enough
    let sent = 0;
    for (const source of [this.leave, this.expenses, this.corrections, this.overtime]) {
      for (const r of await source.waiting(createdBefore)) {
        const days = await afterDays(r.tenantId, r.legalEntityId);
        if (!waitedTooLong(todayIst(r.createdAt), today, days)) continue;
        await source.escalateAutomatically(r.id, reasonWaited(days));
        sent++;
      }
    }
    return sent;
  }
}

function countsOf(leave: number, expense: number, correction: number, overtime: number): ApprovalCounts {
  // ticket reassignments are decided on the ticket (tickets module), not counted here yet
  return { leave, expense, correction, overtime, ticketReassignment: null, total: leave + expense + correction + overtime };
}
