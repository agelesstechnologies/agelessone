import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AdjustTimeRequest, AllocationQuery, DailyUpdate, DailyUpdateRequest, DayAllocation, MissingUpdate, MissingUpdatesQuery, PunchNotice, RunningTicket,
  TicketPunchInRequest, TicketPunchOutRequest, TicketPunchResult,
} from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { isManagement, RequestContext } from '../../../platform/http/request-context';
import { addDays, istDayStart, todayIst } from '../../../platform/time';
import { detectDocumentType, discardUpload, saveUpload } from '../../../platform/storage';
import { CoreFacade } from '../../core/core.facade';
import { HrmsFacade } from '../../hrms/hrms.facade';
import { TicketsRepository } from '../infrastructure/tickets.repository';
import { TicketTimeRepository } from '../infrastructure/ticket-time.repository';
import { punchedInAt, shareTime } from '../domain/share-time';
import { TICKETS } from '../domain/permissions';
import { TicketsService } from './tickets.service';
import { TicketUpload } from './ticket-work.service';

/** A device clock may run a little fast; anything later than this is refused. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_UPDATE_FILES = 5;
type EndReason = 'manual' | 'day_punch_out' | 'unfinished';

/**
 * Ticket time, as in Froid: while punched in for the day a person runs timers on the tickets they are assigned to
 * (several at once). The daily punch-out stops them all; a daily punch-in that becomes a missed punch (an automatic
 * punch-out, or open longer than the open-punch limit) closes them as unfinished, counting no time. Each work day the
 * time is shared between the tickets that ran together (tickets.time.split = equal) and stored per ticket, never more
 * than the day's attendance. Heads adjust it with a reason, in separate rows. Nobody edits a timelog or their own time.
 */
@Injectable()
export class TicketTimeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TicketTimeRepository) private readonly repo: TicketTimeRepository,
    @Inject(TicketsRepository) private readonly ticketsRepo: TicketsRepository,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(HrmsFacade) private readonly hrms: HrmsFacade,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {
    hrms.onWorkDayChanged(async (tx, change) => {
      await this.sync(tx, change.tenantId, change.personId);
      await this.recalculate(tx, change.tenantId, change.personId, change.date);
    });
    hrms.onPunchStored((tx, punch) => (punch.kind === 'out' ? this.updateNotice(tx, punch.tenantId, punch.personId, todayIst(punch.at)) : Promise.resolve([])));
  }

  // ---- ticket punch ----

  /** Starts a timer on each ticket in one transaction. Items already stored (same publicId) are not stored again. */
  async punchIn(ctx: RequestContext, req: TicketPunchInRequest): Promise<{ result: TicketPunchResult; created: boolean }> {
    const at = this.deviceTime(req.occurredAt);
    const fresh: TicketPunchInRequest['items'] = [];
    for (const item of req.items) {
      const owner = await this.repo.timelogOwner(item.publicId);
      if (!owner) fresh.push(item);
      else if (owner.tenantId !== ctx.tenantId || owner.personId !== ctx.personId) throw new AppError('TICKETS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    if (fresh.length === 0) return { result: { started: 0, stopped: 0, running: await this.running(ctx) }, created: false };
    try {
      await this.db.transaction(async (tx) => {
        await this.repo.lockPerson(tx, ctx.personId);
        await this.requirePunchedIn(tx, ctx, at);
        const running = await this.repo.running(tx, ctx.personId);
        for (const item of fresh) {
          const { t } = await this.tickets.load(tx, ctx, item.ticketPublicId, 'view', true);
          const job = await this.repo.assignmentOf(tx, t.id, ctx.personId);
          if (!job?.current) throw new AppError('TICKETS_NOT_ASSIGNEE', 403, `You are not assigned to ${t.number}`);
          if (running.some((r) => r.ticketId === t.id)) throw new AppError('TICKETS_ALREADY_RUNNING', 409, `${t.number} is already running`);
          if (t.status === 'assigned') await this.tickets.markStarted(tx, ctx.personId, t, { by: 'ticket_punch' });
          else if (t.status !== 'in_progress') throw new AppError('TICKETS_WRONG_STATUS', 409, `Ticket ${t.number} is ${t.status}`, { status: t.status });
          await this.repo.insertTimelog(tx, { tenantId: t.tenantId, publicId: item.publicId, ticketId: t.id, employmentId: job.employmentId,
            legalEntityId: t.legalEntityId, startedAt: at });
          await this.tickets.event(tx, ctx.personId, t, 'time_started', { timelog: item.publicId, at: at.toISOString() });
        }
      });
    } catch (err) {
      if (violatedConstraint(err) === 'ticket_timelogs_public_id_unique') return this.punchIn(ctx, req); // the same request twice at once
      throw err;
    }
    return { result: { started: fresh.length, stopped: 0, running: await this.running(ctx) }, created: true };
  }

  /** Stops the caller's timers on the tickets given (or all). */
  async punchOut(ctx: RequestContext, req: TicketPunchOutRequest): Promise<TicketPunchResult> {
    const at = this.deviceTime(req.occurredAt);
    let stopped = 0;
    await this.db.transaction(async (tx) => {
      await this.repo.lockPerson(tx, ctx.personId);
      const running = await this.repo.running(tx, ctx.personId);
      const targets = req.all ? running : req.tickets!.map((id) => {
        const r = running.find((x) => x.ticketPublicId === id);
        if (!r) throw new AppError('TICKETS_NOT_RUNNING', 409, 'No timer of yours runs on that ticket', { ticketPublicId: id });
        return r;
      });
      const dates = new Set<string>();
      for (const r of targets) {
        if (at < r.startedAt) throw new AppError('TICKETS_PUNCH_OUT_BEFORE_START', 400, `${r.number} was started at ${r.startedAt.toISOString()}`);
        await this.close(tx, ctx.personId, r, at, 'manual');
        dates.add(todayIst(r.startedAt));
        stopped++;
      }
      for (const d of dates) await this.recalculate(tx, ctx.tenantId, ctx.personId, d);
    });
    return { started: 0, stopped, running: await this.running(ctx) };
  }

  async running(ctx: RequestContext): Promise<RunningTicket[]> {
    return (await this.repo.running(this.db, ctx.personId)).map((r) => ({
      timelogPublicId: r.publicId, startedAt: r.startedAt.toISOString(),
      ticket: { publicId: r.ticketPublicId, number: r.number, title: r.title, status: r.status as RunningTicket['ticket']['status'] },
    }));
  }

  /**
   * Daily job (and tests): timers of people whose daily punch-in became a missed punch by `now` (open longer than the
   * open-punch limit) are closed as unfinished. Returns how many were closed.
   */
  async closeForgotten(now = new Date()): Promise<number> {
    let closed = 0;
    for (const p of await this.repo.peopleWithRunningTimers()) {
      closed += await this.db.transaction(async (tx) => {
        await this.repo.lockPerson(tx, p.personId);
        const last = await this.hrms.latestPunch(tx, p.personId);
        if (punchedInAt(last, now, await this.maxOpenHours(p.tenantId, last?.legalEntityId ?? null, now))) return 0;
        const running = await this.repo.running(tx, p.personId);
        for (const r of running) await this.close(tx, null, r, r.startedAt, 'unfinished');
        for (const d of new Set(running.map((r) => todayIst(r.startedAt)))) await this.recalculate(tx, p.tenantId, p.personId, d);
        return running.length;
      });
    }
    return closed;
  }

  // ---- following the daily punch ----

  /**
   * After the person's work day changed: timers that can no longer run are closed. The daily punch-out stops them at its
   * time (day_punch_out); an automatic punch-out, or a punch-in that came after them, leaves them unfinished (closed at
   * their own start — the last complete punch they had — so they add no time).
   */
  private async sync(tx: Tx, tenantId: number, personId: number): Promise<void> {
    const running = await this.repo.running(tx, personId);
    if (running.length === 0) return;
    const last = await this.hrms.latestPunch(tx, personId);
    const dates = new Set<string>();
    for (const r of running) {
      let end: { at: Date; reason: EndReason } | null = null;
      if (!last || last.auto) end = { at: r.startedAt, reason: 'unfinished' };
      else if (last.kind === 'out') end = last.at >= r.startedAt ? { at: last.at, reason: 'day_punch_out' } : { at: r.startedAt, reason: 'unfinished' };
      else if (last.at > r.startedAt) end = { at: r.startedAt, reason: 'unfinished' };
      if (end) {
        await this.close(tx, null, r, end.at, end.reason);
        dates.add(todayIst(r.startedAt));
      }
    }
    for (const d of dates) await this.recalculate(tx, tenantId, personId, d);
  }

  /**
   * Shares the person's closed ticket time of one work day (IST date) between the tickets and stores it per ticket.
   * Only time inside attended periods counts, and never more than the day's attended minutes.
   */
  async recalculate(tx: Tx, tenantId: number, personId: number, date: string): Promise<void> {
    await this.core.getPolicy(tenantId, 'tickets.time.split', null, date); // 'equal' is the only rule so far
    const { periods, workedMinutes } = await this.hrms.attendedPeriods(tx, personId, date);
    const logs = await this.repo.timelogs(tx, personId, istDayStart(date), istDayStart(addDays(date, 2)), true);
    const minutes = shareTime(logs.map((l) => ({ ticket: l.ticketId, start: l.startedAt.getTime(), end: l.endedAt!.getTime() })),
      periods.map((p) => ({ start: p.start.getTime(), end: p.end.getTime() })), workedMinutes);
    const stored = await this.repo.allocations(tx, personId, date);
    for (const [ticketId, m] of minutes) {
      const l = logs.find((x) => x.ticketId === ticketId)!;
      await this.repo.saveAllocation(tx, { tenantId, ticketId, employmentId: l.employmentId, legalEntityId: l.legalEntityId, personId, workDate: date, minutes: m });
    }
    for (const s of stored) {
      if (!minutes.has(s.ticketId) && s.minutes !== 0) {
        await this.repo.saveAllocation(tx, { tenantId, ticketId: s.ticketId, employmentId: s.employmentId, legalEntityId: s.legalEntityId, personId, workDate: date, minutes: 0 });
      }
    }
  }

  /** At the daily punch-out: today's tickets the person worked on without a daily update (the app asks; nothing is refused). */
  private async updateNotice(tx: Tx, tenantId: number, personId: number, date: string): Promise<PunchNotice[]> {
    const rows = await this.repo.withoutUpdate(tx, tenantId, date, istDayStart(date), istDayStart(addDays(date, 1)), { personId });
    if (rows.length === 0) return [];
    return [{ code: 'TICKETS_DAILY_UPDATE_MISSING', message: 'Add today\'s update for these tickets',
      items: rows.map((r) => ({ publicId: r.ticketPublicId, label: `${r.number} ${r.title}` })) }];
  }

  // ---- daily updates ----

  /** Note and percent complete for one ticket and day, with up to 5 photos (JPEG, PNG) or files (PDF). One per person, ticket and day. */
  async addDailyUpdate(ctx: RequestContext, ticketPublicId: string, req: DailyUpdateRequest, files: TicketUpload[] = []): Promise<{ update: DailyUpdate; created: boolean }> {
    if (req.publicId) {
      const owner = await this.repo.dailyUpdateOwner(req.publicId);
      if (owner && (owner.tenantId !== ctx.tenantId || owner.personId !== ctx.personId)) throw new AppError('TICKETS_DUPLICATE_ID', 409, 'This publicId is already used');
      if (owner) return { update: (await this.updatesOf(owner.ticketId, req.publicId))[0], created: false };
    }
    if (files.length > MAX_UPDATE_FILES) throw new AppError('TICKETS_TOO_MANY_FILES', 400, `At most ${MAX_UPDATE_FILES} files`);
    const types = files.map((f) => {
      const type = detectDocumentType(f.buffer);
      if (!type) throw new AppError('TICKETS_FILE_TYPE', 400, 'Only JPEG, PNG or PDF files are accepted');
      return type;
    });
    const date = req.workDate ?? todayIst();
    if (date > todayIst()) throw new AppError('TICKETS_DATE_IN_FUTURE', 400, 'An update is for today or an earlier day');
    const { t: before } = await this.tickets.load(this.db, ctx, ticketPublicId, 'work');
    this.tickets.requireUnfinished(before);
    const job = (await this.repo.assignmentOf(this.db, before.id, ctx.personId))?.employmentId
      ?? (await this.ticketsRepo.activeJob(this.db, ctx.personId, before.legalEntityId))?.id;
    if (job === undefined) throw new AppError('TICKETS_NOT_ASSIGNEE', 403, 'You have no job in this ticket\'s company');
    const paths: string[] = [];
    try {
      for (const [i, f] of files.entries()) paths.push(await saveUpload('tickets', types[i], f.buffer));
      const publicId = await this.db.transaction(async (tx) => {
        const { t } = await this.tickets.load(tx, ctx, ticketPublicId, 'work', true);
        this.tickets.requireUnfinished(t);
        const u = await this.repo.insertDailyUpdate(tx, { tenantId: t.tenantId, publicId: req.publicId ?? randomUUID(), ticketId: t.id, employmentId: job,
          legalEntityId: t.legalEntityId, workDate: date, note: req.note, percentComplete: req.percentComplete });
        for (const [i, path] of paths.entries()) {
          await this.repo.insertAttachment(tx, { tenantId: t.tenantId, ticketId: t.id, legalEntityId: t.legalEntityId, kind: types[i] === 'pdf' ? 'file' : 'photo',
            filePath: path, fileType: types[i], dailyUpdateId: u.id, uploadedBy: ctx.personId });
        }
        await this.tickets.event(tx, ctx.personId, t, 'daily_update', { date, percentComplete: req.percentComplete, note: req.note, files: paths.length });
        return u.publicId;
      });
      return { update: (await this.updatesOf(before.id, publicId))[0], created: true };
    } catch (err) {
      for (const p of paths) await discardUpload(p);
      if (violatedConstraint(err) === 'ticket_daily_updates_one_per_day') throw new AppError('TICKETS_UPDATE_EXISTS', 409, `You already gave the update for ${date}`);
      throw err;
    }
  }

  async dailyUpdates(ctx: RequestContext, ticketPublicId: string): Promise<DailyUpdate[]> {
    const { t } = await this.tickets.load(this.db, ctx, ticketPublicId, 'view');
    return this.updatesOf(t.id);
  }

  /**
   * Who worked on a ticket that day without giving its update (default yesterday): for the department head the next
   * day. Heads see their departments; HR, admin user and Management every department; anyone else only themselves.
   */
  async missingUpdates(ctx: RequestContext, q: MissingUpdatesQuery): Promise<MissingUpdate[]> {
    const date = q.date ?? addDays(todayIst(), -1);
    const c = this.tickets.caller(ctx);
    const everything = c.management || c.view === 'all' || c.manage === 'all';
    const heads = everything ? null : await this.ticketsRepo.departmentsHeadedBy(ctx.tenantId, ctx.personId);
    const who = everything ? { departmentIds: null } : heads!.length ? { departmentIds: heads } : { personId: ctx.personId };
    const rows = await this.repo.withoutUpdate(this.db, ctx.tenantId, date, istDayStart(date), istDayStart(addDays(date, 1)), who);
    return rows.map((r) => ({ date, ticket: { publicId: r.ticketPublicId, number: r.number, title: r.title },
      person: { publicId: r.personPublicId, displayName: r.personName }, department: { publicId: r.departmentPublicId, name: r.departmentName }, minutes: r.minutes }));
  }

  // ---- time per day and the head's adjustments ----

  async allocation(ctx: RequestContext, q: AllocationQuery): Promise<DayAllocation> {
    const person = await this.ticketsRepo.findPerson(ctx.tenantId, q.person);
    if (!person) throw new AppError('TICKETS_UNKNOWN_PERSON', 404, 'Unknown person');
    if (person.id !== ctx.personId && !(await this.reviews(ctx, person.id, q.date))) {
      throw new AppError('TICKETS_FORBIDDEN', 403, 'Only the person, the heads of their tickets\' departments, HR, admin and Management see this');
    }
    return this.dayView(ctx.tenantId, person.id, q.date);
  }

  /**
   * Moves minutes between the person's tickets for one day, with a reason; stored as adjustment rows (timelogs and the
   * calculated allocation stay). Each ticket stays at 0 or more and the day within its attended minutes. Department
   * heads for their departments' tickets; Management for any. Nobody adjusts their own time.
   */
  async adjust(ctx: RequestContext, req: AdjustTimeRequest): Promise<DayAllocation> {
    const person = await this.ticketsRepo.findPerson(ctx.tenantId, req.personPublicId);
    if (!person) throw new AppError('TICKETS_UNKNOWN_PERSON', 404, 'Unknown person');
    if (person.id === ctx.personId) throw new AppError('TICKETS_SELF_ADJUST', 403, 'Nobody adjusts their own time');
    const management = isManagement(ctx) || ctx.permissions[TICKETS.timeAdjust] === 'all';
    await this.db.transaction(async (tx) => {
      await this.repo.lockPerson(tx, person.id);
      const planned: { t: NonNullable<Awaited<ReturnType<TicketsRepository['findTicket']>>>; employmentId: number; minutes: number }[] = [];
      for (const c of req.changes) {
        const t = await this.ticketsRepo.findTicket(tx, ctx.tenantId, c.ticketPublicId);
        if (!t) throw new AppError('TICKETS_NOT_FOUND', 404, 'Unknown ticket');
        if (!management && t.supervisorPersonId !== ctx.personId && (await this.ticketsRepo.departmentHead(tx, t.departmentId)) !== ctx.personId) {
          throw new AppError('TICKETS_FORBIDDEN', 403, `${t.number} is not a ticket of a department you head`);
        }
        const job = await this.repo.assignmentOf(tx, t.id, person.id);
        if (!job) throw new AppError('TICKETS_NOT_ON_TICKET', 400, `That person has never been assigned to ${t.number}`);
        planned.push({ t, employmentId: job.employmentId, minutes: c.minutes });
      }
      const totals = new Map<number, number>();
      for (const a of await this.repo.allocations(tx, person.id, req.date)) totals.set(a.ticketId, (totals.get(a.ticketId) ?? 0) + a.minutes);
      for (const a of await this.repo.adjustments(tx, person.id, req.date)) totals.set(a.ticketId, (totals.get(a.ticketId) ?? 0) + a.minutes);
      for (const p of planned) {
        const next = (totals.get(p.t.id) ?? 0) + p.minutes;
        if (next < 0) throw new AppError('TICKETS_ADJUST_NEGATIVE', 400, `${p.t.number} would have less than 0 minutes`, { ticket: p.t.publicId, minutes: next });
        totals.set(p.t.id, next);
      }
      const { workedMinutes } = await this.hrms.attendedPeriods(tx, person.id, req.date);
      const total = [...totals.values()].reduce((a, b) => a + b, 0);
      if (total > workedMinutes) {
        throw new AppError('TICKETS_ADJUST_OVER_ATTENDANCE', 400, `Ticket time would be ${total} minutes; the day has ${workedMinutes} attended minutes`,
          { totalMinutes: total, attendanceMinutes: workedMinutes });
      }
      const batchId = randomUUID();
      const adjustedAs = isManagement(ctx) ? 'management' : 'head';
      await this.repo.insertAdjustments(tx, planned.map((p) => ({ tenantId: ctx.tenantId, batchId, ticketId: p.t.id, employmentId: p.employmentId,
        legalEntityId: p.t.legalEntityId, personId: person.id, workDate: req.date, minutes: p.minutes, reason: req.reason, adjustedBy: ctx.personId, adjustedAs })));
      for (const p of planned) {
        await this.tickets.event(tx, ctx.personId, p.t, 'time_adjusted', { person: req.personPublicId, date: req.date, minutes: p.minutes, reason: req.reason, adjustedAs });
      }
    });
    return this.dayView(ctx.tenantId, person.id, req.date);
  }

  // ---- helpers ----

  private async dayView(tenantId: number, personId: number, date: string): Promise<DayAllocation> {
    const [person] = [...(await this.ticketsRepo.personRefs(this.db, [personId])).values()];
    const [allocations, adjustments, logs, attended] = await Promise.all([
      this.repo.allocations(this.db, personId, date), this.repo.adjustments(this.db, personId, date),
      this.repo.timelogs(this.db, personId, istDayStart(date), istDayStart(addDays(date, 1)), false), this.hrms.attendedPeriods(this.db, personId, date),
    ]);
    const ref = (r: { ticketPublicId: string; number: string; title: string }) => ({ publicId: r.ticketPublicId, number: r.number, title: r.title });
    const rows = new Map<number, DayAllocation['rows'][number]>();
    for (const a of allocations) rows.set(a.ticketId, { ticket: ref(a), calculatedMinutes: a.minutes, adjustedMinutes: 0, minutes: a.minutes });
    for (const a of adjustments) {
      const row = rows.get(a.ticketId) ?? { ticket: ref(a), calculatedMinutes: 0, adjustedMinutes: 0, minutes: 0 };
      row.adjustedMinutes += a.minutes;
      row.minutes += a.minutes;
      rows.set(a.ticketId, row);
    }
    const list = [...rows.values()].filter((r) => r.calculatedMinutes !== 0 || r.adjustedMinutes !== 0);
    return {
      person, date, attendanceMinutes: attended.workedMinutes, totalMinutes: list.reduce((a, b) => a + b.minutes, 0), rows: list,
      adjustments: adjustments.map((a) => ({ batchId: a.batchId, ticket: ref(a), minutes: a.minutes, reason: a.reason,
        adjustedBy: { publicId: a.byPublicId, displayName: a.byName }, adjustedAs: a.adjustedAs as 'head' | 'management', at: a.createdAt.toISOString() })),
      timelogs: logs.filter((l) => todayIst(l.startedAt) === date).map((l) => ({ publicId: l.publicId, ticket: ref(l), startedAt: l.startedAt.toISOString(),
        endedAt: l.endedAt?.toISOString() ?? null, endReason: (l.endReason ?? null) as EndReason | null })),
    };
  }

  /** May the caller review this person's day: HR, admin, Management, or the head / supervisor of one of its tickets. */
  private async reviews(ctx: RequestContext, personId: number, date: string): Promise<boolean> {
    const c = this.tickets.caller(ctx);
    if (c.management || c.view === 'all' || c.manage === 'all') return true;
    const heads = new Set(await this.ticketsRepo.departmentsHeadedBy(ctx.tenantId, ctx.personId));
    return (await this.repo.departmentsOfDay(this.db, personId, date)).some((d) => heads.has(d.departmentId) || d.supervisorPersonId === ctx.personId);
  }

  private async updatesOf(ticketId: number, publicId?: string): Promise<DailyUpdate[]> {
    return (await this.repo.dailyUpdates(this.db, ticketId, publicId)).map((u) => ({ publicId: u.publicId, workDate: u.workDate,
      person: { publicId: u.personPublicId, displayName: u.personName }, note: u.note, percentComplete: u.percentComplete,
      attachments: u.attachments.map((a) => ({ publicId: a.publicId, kind: a.kind, fileType: a.fileType })), createdAt: u.createdAt.toISOString() }));
  }

  private async close(tx: Tx, actorId: number | null, r: { id: number; publicId: string; ticketId: number; tenantId: number; legalEntityId: number },
    at: Date, reason: EndReason): Promise<void> {
    await this.repo.closeTimelog(tx, r.id, at, reason);
    await this.tickets.event(tx, actorId, { id: r.ticketId, tenantId: r.tenantId, legalEntityId: r.legalEntityId }, 'time_stopped',
      { timelog: r.publicId, at: at.toISOString(), reason });
  }

  private async requirePunchedIn(tx: Tx, ctx: RequestContext, at: Date): Promise<void> {
    const last = await this.hrms.latestPunch(tx, ctx.personId);
    if (!punchedInAt(last, at, await this.maxOpenHours(ctx.tenantId, last?.legalEntityId ?? null, at))) {
      throw new AppError('TICKETS_NOT_PUNCHED_IN', 409, 'Punch in for the day first');
    }
  }

  private maxOpenHours(tenantId: number, companyId: number | null, at: Date): Promise<number> {
    return this.core.getPolicy(tenantId, 'hrms.attendance.max_open_punch_hours', companyId, todayIst(at));
  }

  private deviceTime(value: string | undefined): Date {
    const at = value ? new Date(value) : new Date();
    if (at.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw new AppError('TICKETS_TIME_IN_FUTURE', 400, 'The time is in the future');
    return at;
  }
}
