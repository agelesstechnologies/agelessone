import { Inject, Injectable } from '@nestjs/common';
import { ApprovalCounts, ApprovalItem, ApprovalsInbox } from '@ageless/shared';
import { RequestContext } from '../../../../platform/http/request-context';
import { todayIst } from '../../../../platform/time';
import { LeaveService } from '../../leave/application/leave.service';
import { ExpensesService } from '../../expenses/application/expenses.service';
import { CorrectionsService } from '../../attendance/application/corrections.service';
import { OvertimeService } from '../../attendance/application/overtime.service';
import { daysBetween } from '../domain/dashboard';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Everything the caller can decide, in one list (oldest first): leave, expenses, corrections and overtime. Each module
 * decides what is the caller's to decide (named approver, the job's manager for expenses, HR or Management for anyone's);
 * never the caller's own requests.
 */
@Injectable()
export class ApprovalsInboxService {
  constructor(
    @Inject(LeaveService) private readonly leave: LeaveService,
    @Inject(ExpensesService) private readonly expenses: ExpensesService,
    @Inject(CorrectionsService) private readonly corrections: CorrectionsService,
    @Inject(OvertimeService) private readonly overtime: OvertimeService,
  ) {}

  async mine(ctx: RequestContext): Promise<ApprovalsInbox> {
    const now = new Date();
    const today = todayIst(now);
    const age = (submittedAt: string) => Math.max(0, daysBetween(todayIst(new Date(submittedAt)), today));
    const [leave, expenses, corrections, overtime] = await Promise.all([
      this.leave.toApprove(ctx), this.expenses.toApprove(ctx), this.corrections.toApprove(ctx), this.overtime.toApprove(ctx),
    ]);
    const items: ApprovalItem[] = [
      ...leave.map((r) => ({
        type: 'leave' as const, publicId: r.publicId, person: r.person, company: r.employment.company,
        fromDate: r.fromDate, toDate: r.toDate, amountPaise: null, currency: null,
        summary: `${r.leaveType.name}, ${r.days} day${r.days === 1 ? '' : 's'}`, submittedAt: r.createdAt, ageDays: age(r.createdAt),
      })),
      ...expenses.map((c) => ({
        type: 'expense' as const, publicId: c.publicId, person: c.person, company: c.employment.company,
        fromDate: c.spentOn, toDate: c.spentOn, amountPaise: c.amountPaise, currency: c.currency,
        summary: c.description ? `${c.category.name}: ${c.description}` : c.category.name, submittedAt: c.createdAt, ageDays: age(c.createdAt),
      })),
      ...corrections.map((c) => ({
        type: 'correction' as const, publicId: c.publicId, person: c.person, company: c.employment.company,
        fromDate: c.workDate, toDate: c.workDate, amountPaise: null, currency: null,
        summary: `Correction (${c.kind.replace('_', ' ')})`, submittedAt: c.createdAt, ageDays: age(c.createdAt),
      })),
      ...overtime.map((o) => ({
        type: 'overtime' as const, publicId: o.publicId, person: o.person, company: o.employment.company,
        fromDate: o.workDate, toDate: o.workDate, amountPaise: null, currency: null,
        summary: `Overtime ${plural(o.minutes, 'minute')}`, submittedAt: o.createdAt, ageDays: age(o.createdAt),
      })),
    ].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    return { asOf: now.toISOString(), counts: countsOf(leave.length, expenses.length, corrections.length, overtime.length), items };
  }

  /** Only the counts (for the dashboard). */
  async counts(ctx: RequestContext): Promise<ApprovalCounts> {
    return (await this.mine(ctx)).counts;
  }
}

function countsOf(leave: number, expense: number, correction: number, overtime: number): ApprovalCounts {
  // ticket reassignments: the tickets module is not built yet
  return { leave, expense, correction, overtime, ticketReassignment: null, total: leave + expense + correction + overtime };
}
