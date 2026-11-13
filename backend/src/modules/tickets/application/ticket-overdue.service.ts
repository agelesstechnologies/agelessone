import { Inject, Injectable } from '@nestjs/common';
import type { OverdueAlert, OverdueAlertsQuery } from '@ageless/shared';
import { DB, Db } from '../../../platform/db/db.module';
import { RequestContext } from '../../../platform/http/request-context';
import { todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { TicketsRepository } from '../infrastructure/tickets.repository';
import { TicketsService } from './tickets.service';

type Alerted = Awaited<ReturnType<TicketsRepository['overdueAlerted']>>[number];

/** Whole days from one IST date to a later one. */
const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Overdue escalation, the way approvals escalate: an unfinished ticket past its due date alerts its department head
 * (and its supervisor) the day after; once it is policy tickets.overdue.ceo_after_days days overdue (3 for now) it is also
 * sent to the CEO. The daily job (tickets:daily) takes the steps; each is a timeline event. A new due date starts again.
 * There are no notifications yet: the alerts are lists (GET /tickets/overdue-alerts) on the Overview and the CEO dashboard.
 */
@Injectable()
export class TicketOverdueService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TicketsRepository) private readonly repo: TicketsRepository,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /** The daily step. Returns how many tickets alerted their head and how many were sent to the CEO. */
  async escalateOverdue(now: Date = new Date()): Promise<{ alerted: number; sentToCeo: number }> {
    const today = todayIst(now);
    const policy = new Map<string, number>();
    const ceoAfter = async (tenantId: number, companyId: number) => {
      const key = `${tenantId}:${companyId}`;
      if (!policy.has(key)) policy.set(key, await this.core.getPolicy(tenantId, 'tickets.overdue.ceo_after_days', companyId, today));
      return policy.get(key)!;
    };
    let alerted = 0, sentToCeo = 0;
    for (const t of await this.repo.overdueToEscalate(today)) {
      const due = t.dueDate!;
      const days = daysFrom(due, today);
      const fresh = t.overdueFor !== due;                                   // never alerted, or alerted about an earlier due date
      const toCeo = days >= await ceoAfter(t.tenantId, t.legalEntityId) && (fresh || t.escalatedAt === null);
      if (!fresh && !toCeo) continue;
      const ref = { id: t.id, tenantId: t.tenantId, legalEntityId: t.legalEntityId };
      await this.db.transaction(async (tx) => {
        if (fresh) {
          await this.repo.markOverdueAlerted(tx, t.id, due);
          await this.tickets.event(tx, null, ref, 'overdue_head_alerted', { dueDate: due, daysOverdue: days });
          alerted++;
        }
        if (toCeo) {
          await this.repo.markOverdueSentToCeo(tx, t.id);
          await this.tickets.event(tx, null, ref, 'overdue_sent_to_ceo', { dueDate: due, daysOverdue: days, reason: `Overdue for ${days} day${days === 1 ? '' : 's'}` });
          sentToCeo++;
        }
      });
    }
    return { alerted, sentToCeo };
  }

  /**
   * The overdue tickets the caller is alerted about: Management (the CEO) the ones sent to them; the admin user (tickets
   * of every department) all; anyone else the tickets of departments they head and the tickets they supervise.
   */
  async alerts(ctx: RequestContext, q: OverdueAlertsQuery): Promise<OverdueAlert[]> {
    const c = this.tickets.caller(ctx);
    const rows = c.management ? await this.repo.overdueAlerted(ctx.tenantId, null, true, q.company)
      : c.manage === 'all' ? await this.repo.overdueAlerted(ctx.tenantId, null, false, q.company)
        : await this.repo.overdueAlerted(ctx.tenantId,
          { personId: ctx.personId, headedDepartmentIds: await this.repo.departmentsHeadedBy(ctx.tenantId, ctx.personId) }, false, q.company);
    const today = todayIst();
    return rows.map((r) => toAlert(r, today));
  }
}

function toAlert({ row: r, alertedAt, sentAt }: Alerted, today: string): OverdueAlert {
  return {
    ticket: { publicId: r.publicId, number: r.number, title: r.title }, company: r.company, status: r.status as OverdueAlert['status'], priority: r.priority,
    department: { publicId: r.departmentPublicId, name: r.departmentName }, supervisor: { publicId: r.supervisorPublicId, displayName: r.supervisorName },
    primaryAssignee: r.primaryPersonPublicId ? { publicId: r.primaryPersonPublicId, displayName: r.primaryName! } : null,
    dueDate: r.dueDate!, daysOverdue: daysFrom(r.dueDate!, today),
    headAlertedAt: alertedAt.toISOString(), sentToCeoAt: sentAt?.toISOString() ?? null,
  };
}
