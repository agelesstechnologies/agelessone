import { Inject, Injectable } from '@nestjs/common';
import type { ApproveSplitRequest, ReasonRequest, SplitSuggestion, SplitSuggestionsQuery, SuggestSplitRequest } from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { isManagement, RequestContext } from '../../../platform/http/request-context';
import { addDays, todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { HrmsFacade } from '../../hrms/hrms.facade';
import { TicketsRepository } from '../infrastructure/tickets.repository';
import { TicketSplitRepository } from '../infrastructure/ticket-split.repository';
import { proportional } from '../domain/split-suggestion';
import { TICKETS } from '../domain/permissions';
import { TicketsService } from './tickets.service';
import { TicketTimeService } from './ticket-time.service';

type Request = NonNullable<Awaited<ReturnType<TicketSplitRepository['byPublicId']>>>;
type Line = Awaited<ReturnType<TicketSplitRepository['lines']>>[number];
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Split suggestions. The equal split of a day's ticket time (tickets.time.split) is often not how the time went, and the
 * person may not change their own time. So they suggest another split (minutes per ticket, adding up to what those
 * tickets have now); it changes nothing until the department head (or Management) approves it — stored as that head's
 * adjustment (ticket_time_adjustments), so every report uses it — or rejects it. With no suggestion the equal split stands.
 */
@Injectable()
export class TicketSplitService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TicketSplitRepository) private readonly repo: TicketSplitRepository,
    @Inject(TicketsRepository) private readonly ticketsRepo: TicketsRepository,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(TicketTimeService) private readonly time: TicketTimeService,
    @Inject(HrmsFacade) private readonly hrms: HrmsFacade,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /**
   * The caller suggests another split of their ticket time on a finished day (today after the daily punch-out, or up to
   * tickets.time.suggest_days back). At least two of their tickets that day; the minutes add up to what those tickets
   * have now; one pending suggestion per job and day. The same publicId again answers the stored suggestion.
   */
  async suggest(ctx: RequestContext, req: SuggestSplitRequest): Promise<{ suggestion: SplitSuggestion; created: boolean }> {
    const stored = await this.repo.byPublicId(this.db, ctx.tenantId, req.publicId);
    if (stored) {
      if (stored.personId !== ctx.personId) throw new AppError('TICKETS_DUPLICATE_ID', 409, 'This publicId is already used');
      return { suggestion: (await this.views(ctx, [stored]))[0]!, created: false };
    }
    const today = todayIst();
    if (req.date > today) throw new AppError('TICKETS_DATE_IN_FUTURE', 400, 'A split is for today or an earlier day');
    try {
      await this.db.transaction(async (tx) => {
        const days = await this.core.getPolicy(ctx.tenantId, 'tickets.time.suggest_days', null, today);
        if (req.date < addDays(today, -days)) {
          throw new AppError('TICKETS_SPLIT_TOO_OLD', 400, days === 0 ? 'A split can be suggested for today only' : `A split can be suggested for the last ${days} days only`);
        }
        if (req.date === today) {
          const last = await this.hrms.latestPunch(tx, ctx.personId);
          if (last?.kind === 'in' && todayIst(last.at) === today) {
            throw new AppError('TICKETS_DAY_NOT_FINISHED', 409, 'Punch out for the day first: the split is made from the finished day');
          }
        }
        const day = await this.time.minutesOfDay(tx, ctx.personId, req.date);
        const lines: { t: NonNullable<Awaited<ReturnType<TicketsRepository['findTicket']>>>; before: number; suggested: number; employmentId: number }[] = [];
        for (const x of req.tickets) {
          const t = await this.ticketsRepo.findTicket(tx, ctx.tenantId, x.ticketPublicId);
          const mine = t ? day.get(t.id) : undefined;
          if (!t || !mine) throw new AppError('TICKETS_SPLIT_UNKNOWN_TICKET', 400, `You have no ticket time on ${t?.number ?? 'that ticket'} on ${req.date}`, { ticketPublicId: x.ticketPublicId });
          lines.push({ t, before: mine.minutes, suggested: x.minutes, employmentId: mine.employmentId });
        }
        if (new Set(lines.map((l) => l.employmentId)).size > 1) {
          throw new AppError('TICKETS_SPLIT_TWO_JOBS', 400, 'Suggest the split of one company\'s tickets at a time');
        }
        const before = sum(lines.map((l) => l.before));
        const suggested = sum(lines.map((l) => l.suggested));
        if (before === 0) throw new AppError('TICKETS_SPLIT_NOTHING', 400, 'These tickets have no time to share on that day');
        if (suggested !== before) {
          throw new AppError('TICKETS_SPLIT_TOTAL', 400, `The minutes must add up to ${before} (what these tickets have now); they add up to ${suggested}`,
            { totalMinutes: before, givenMinutes: suggested });
        }
        if (lines.every((l) => l.suggested === l.before)) throw new AppError('TICKETS_SPLIT_UNCHANGED', 400, 'This is the split you have now');
        const job = lines[0]!;
        await this.repo.insert(tx, {
          tenantId: ctx.tenantId, publicId: req.publicId, personId: ctx.personId, employmentId: job.employmentId, legalEntityId: job.t.legalEntityId,
          workDate: req.date, note: req.note ?? null,
        }, lines.map((l) => ({ ticketId: l.t.id, employmentId: l.employmentId, legalEntityId: l.t.legalEntityId, beforeMinutes: l.before, suggestedMinutes: l.suggested })));
        for (const l of lines) {
          await this.tickets.event(tx, ctx.personId, l.t, 'time_split_suggested', { suggestion: req.publicId, date: req.date, before: l.before, suggested: l.suggested });
        }
      });
    } catch (err) {
      const constraint = violatedConstraint(err);
      if (constraint === 'ticket_time_split_requests_public_id_unique') return this.suggest(ctx, req);   // the same request twice at once
      if (constraint === 'ticket_time_split_requests_one_pending') {
        throw new AppError('TICKETS_SPLIT_PENDING', 409, 'A suggestion for that day is already waiting for the head; cancel it to make another');
      }
      throw err;
    }
    return { suggestion: (await this.views(ctx, [(await this.repo.byPublicId(this.db, ctx.tenantId, req.publicId))!]))[0]!, created: true };
  }

  /** My suggestions and the ones I may decide (heads: tickets of departments they head or supervise); Management, HR, admin: all. */
  async list(ctx: RequestContext, q: SplitSuggestionsQuery): Promise<SplitSuggestion[]> {
    const c = this.tickets.caller(ctx);
    const everyone = c.management || c.view === 'all' || c.manage === 'all' || ctx.permissions[TICKETS.timeAdjust] === 'all';
    const headOf = everyone ? [] : await this.ticketsRepo.departmentsHeadedBy(ctx.tenantId, ctx.personId);
    return this.views(ctx, await this.repo.list(this.db, ctx.tenantId, everyone ? null : { personId: ctx.personId, headOf }, q.status));
  }

  /**
   * Approve: the suggested split (in proportion to what the tickets have now, if that changed) or the head's own minutes
   * (the same tickets, the same total, with a reason), stored as the head's adjustment of the person's day.
   */
  async approve(ctx: RequestContext, publicId: string, req: ApproveSplitRequest): Promise<SplitSuggestion> {
    await this.db.transaction(async (tx) => {
      const r = await this.pending(tx, ctx, publicId);
      const lines = await this.repo.lines(tx, [r.id]);
      await this.mustDecide(ctx, r, lines);
      const day = await this.time.minutesOfDay(tx, r.personId, r.workDate);
      const now = lines.map((l) => day.get(l.ticketId)?.minutes ?? 0);
      const total = sum(now);
      let target: number[];
      if (req.tickets) {
        const given = new Map(req.tickets.map((x) => [x.ticketPublicId, x.minutes]));
        if (given.size !== lines.length || lines.some((l) => !given.has(l.ticketPublicId))) {
          throw new AppError('TICKETS_SPLIT_TICKETS', 400, 'Give minutes for exactly the tickets of the suggestion');
        }
        target = lines.map((l) => given.get(l.ticketPublicId)!);
        if (sum(target) !== total) {
          throw new AppError('TICKETS_SPLIT_TOTAL', 400, `The minutes must add up to ${total} (what these tickets have now); they add up to ${sum(target)}`,
            { totalMinutes: total, givenMinutes: sum(target) });
        }
      } else {
        target = proportional(lines.map((l) => l.suggestedMinutes), total);
      }
      const changes = lines.map((l, i) => ({ ticketPublicId: l.ticketPublicId, minutes: target[i]! - now[i]! })).filter((x) => x.minutes !== 0);
      const reason = clip(req.tickets
        ? `Split suggested by ${r.ownerName}, changed by the head: ${req.reason}`
        : `Split suggested by ${r.ownerName}${r.note ? `: ${r.note}` : ''}${req.reason ? ` (${req.reason})` : ''}`, 500);
      const batchId = changes.length ? await this.time.applyAdjustments(tx, ctx, { id: r.personId, publicId: r.ownerPublicId }, r.workDate, changes, reason) : null;
      await this.repo.close(tx, r.id, { status: 'approved', decidedBy: ctx.personId, decidedAs: isManagement(ctx) ? 'management' : 'head',
        decisionReason: req.reason ?? null, adjustmentBatchId: batchId });
      for (const [i, l] of lines.entries()) await this.repo.setApproved(tx, r.id, l.ticketId, target[i]!);
    });
    return this.one(ctx, publicId);
  }

  /** Reject with a reason: nothing changes, the split stays as it is. */
  async reject(ctx: RequestContext, publicId: string, req: ReasonRequest): Promise<SplitSuggestion> {
    await this.db.transaction(async (tx) => {
      const r = await this.pending(tx, ctx, publicId);
      const lines = await this.repo.lines(tx, [r.id]);
      await this.mustDecide(ctx, r, lines);
      await this.repo.close(tx, r.id, { status: 'rejected', decidedBy: ctx.personId, decidedAs: isManagement(ctx) ? 'management' : 'head', decisionReason: req.reason });
      await this.eventOn(tx, ctx, lines, r, 'time_split_rejected', { reason: req.reason });
    });
    return this.one(ctx, publicId);
  }

  /** The person withdraws their pending suggestion (e.g. to make another). */
  async cancel(ctx: RequestContext, publicId: string): Promise<SplitSuggestion> {
    await this.db.transaction(async (tx) => {
      const r = await this.repo.byPublicId(tx, ctx.tenantId, publicId, true);
      if (!r || r.personId !== ctx.personId) throw new AppError('TICKETS_SPLIT_NOT_FOUND', 404, 'Unknown suggestion');
      if (r.status !== 'pending') throw new AppError('TICKETS_SPLIT_DECIDED', 409, `This suggestion is already ${r.status}`);
      await this.repo.close(tx, r.id, { status: 'cancelled' });
      await this.eventOn(tx, ctx, await this.repo.lines(tx, [r.id]), r, 'time_split_cancelled', {});
    });
    return this.one(ctx, publicId);
  }

  // ---- helpers ----

  /** The suggestion, locked, still pending, and not the caller's own (who may decide it is checked next). */
  private async pending(tx: Tx, ctx: RequestContext, publicId: string): Promise<Request> {
    const r = await this.repo.byPublicId(tx, ctx.tenantId, publicId, true);
    if (!r) throw new AppError('TICKETS_SPLIT_NOT_FOUND', 404, 'Unknown suggestion');
    if (r.personId === ctx.personId) throw new AppError('TICKETS_SELF_APPROVAL', 403, 'Nobody decides their own split');
    if (r.status !== 'pending') throw new AppError('TICKETS_SPLIT_DECIDED', 409, `This suggestion is already ${r.status}`);
    return r;
  }

  /** Management (or tickets.time.adjust with scope all) decides any; a head only when they head or supervise every ticket of it. */
  private async mustDecide(ctx: RequestContext, r: Request, lines: Line[]): Promise<void> {
    if (!(await this.mayDecide(ctx, r, lines))) {
      throw new AppError('TICKETS_FORBIDDEN', 403, 'Only the head of these tickets\' department, their supervisor or Management decides this');
    }
  }

  private async mayDecide(ctx: RequestContext, r: { personId: number; status: string }, lines: Line[], headOf?: Set<number>): Promise<boolean> {
    if (r.status !== 'pending' || r.personId === ctx.personId) return false;
    if (isManagement(ctx) || ctx.permissions[TICKETS.timeAdjust] === 'all') return true;
    if (ctx.permissions[TICKETS.timeAdjust] === undefined) return false;
    const heads = headOf ?? new Set(await this.ticketsRepo.departmentsHeadedBy(ctx.tenantId, ctx.personId));
    return lines.every((l) => l.supervisorPersonId === ctx.personId || (l.departmentId !== null && heads.has(l.departmentId)));
  }

  private async one(ctx: RequestContext, publicId: string): Promise<SplitSuggestion> {
    return (await this.views(ctx, [(await this.repo.byPublicId(this.db, ctx.tenantId, publicId))!]))[0]!;
  }

  private async views(ctx: RequestContext, rows: Request[]): Promise<SplitSuggestion[]> {
    const lines = await this.repo.lines(this.db, rows.map((r) => r.id));
    const headOf = new Set(await this.ticketsRepo.departmentsHeadedBy(ctx.tenantId, ctx.personId));
    return Promise.all(rows.map(async (r) => {
      const own = lines.filter((l) => l.requestId === r.id);
      return {
        publicId: r.publicId, person: { publicId: r.ownerPublicId, displayName: r.ownerName }, date: r.workDate, note: r.note,
        status: r.status as SplitSuggestion['status'],
        rows: own.map((l) => ({ ticket: { publicId: l.ticketPublicId, number: l.number, title: l.title },
          beforeMinutes: l.beforeMinutes, suggestedMinutes: l.suggestedMinutes, approvedMinutes: l.approvedMinutes })),
        createdAt: r.createdAt.toISOString(),
        decidedBy: r.deciderPublicId ? { publicId: r.deciderPublicId, displayName: r.deciderName! } : null,
        decidedAs: (r.decidedAs ?? null) as SplitSuggestion['decidedAs'], decidedAt: r.decidedAt?.toISOString() ?? null, decisionReason: r.decisionReason,
        canDecide: await this.mayDecide(ctx, r, own, headOf),
      };
    }));
  }

  private async eventOn(tx: Tx, ctx: RequestContext, lines: Line[], r: Request, action: string, details: Record<string, unknown>): Promise<void> {
    for (const l of lines) {
      const t = await this.ticketsRepo.findTicket(tx, ctx.tenantId, l.ticketPublicId);
      if (t) await this.tickets.event(tx, ctx.personId, t, action, { suggestion: r.publicId, date: r.workDate, ...details });
    }
  }
}
