import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AssigneeInput, CompletionRules, CreateTicketRequest, MyTicketsQuery, NumberSeries, NumberSeriesRequest, TicketDetail, TicketsQuery, TicketSummary,
  UpdateTicketRequest,
} from '@ageless/shared';
import { Conn, DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { isManagement, RequestContext, requireAll } from '../../../platform/http/request-context';
import { addDays, istDayStart, todayIst } from '../../../platform/time';
import { TicketTypesService } from './ticket-types.service';
import { TicketRow, TicketsRepository, Visibility } from '../infrastructure/tickets.repository';
import { checkDetails, FieldDef } from '../domain/type-details';
import { missingForCompletion } from '../domain/completion';
import { isFinished, Move, nextStatus, Status } from '../domain/lifecycle';
import { Caller, canComplete, canManage, canView, canWork, Relation } from '../domain/ticket-access';
import { TICKETS } from '../domain/permissions';

export type Warning = { code: string; message: string; employmentPublicId?: string };
type Check = 'view' | 'work' | 'manage' | 'complete';
type TicketRef = { id: number; tenantId: number; legalEntityId: number };
/** An assignee ready to store: a checked job. */
interface NewAssignee { employmentId: number; employmentPublicId: string; personId: number; isPrimary: boolean }
/** A ticket loaded for one action, with how the caller relates to it. */
export interface Loaded { t: TicketRow; caller: Caller; rel: Relation }

const CHECK = { view: canView, work: canWork, manage: canManage, complete: canComplete };
const formatNumber = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;
/** The IST date a ticket is scheduled for (leave is checked on it). */
const istDate = (d: Date) => todayIst(d);

/**
 * Tickets: one piece of work of a ticket type. Uses the type version it was created with; type details are checked
 * against that version's fields. Admin user and Management run every ticket; a department head runs their departments'
 * tickets; staff see and work on the tickets they are assigned to; HR views. Nothing is deleted, and every change
 * writes a timeline event in the same transaction.
 */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TicketsRepository) private readonly repo: TicketsRepository,
    @Inject(TicketTypesService) private readonly types: TicketTypesService,
  ) {}

  // ---- reading ----

  async list(ctx: RequestContext, q: TicketsQuery): Promise<TicketSummary[]> {
    const rows = await this.repo.list(ctx.tenantId, {
      company: q.company, typePublicId: q.type, status: q.status, departmentPublicId: q.department, assignee: q.assignee, customer: q.customer,
      priority: q.priority, overdueBefore: q.overdue ? todayIst() : undefined,
      from: q.from ? istDayStart(q.from) : undefined, to: q.to ? istDayStart(addDays(q.to, 1)) : undefined,
      limit: q.limit ?? 100, offset: q.offset ?? 0,
    }, await this.visibility(ctx));
    const out = rows.map(toSummary);
    return q.overdue === false ? out.filter((t) => !t.overdue) : out;
  }

  /** Tickets I am a current assignee of. */
  async mine(ctx: RequestContext, q: MyTicketsQuery): Promise<TicketSummary[]> {
    const rows = await this.repo.list(ctx.tenantId, { status: q.status, limit: 500, offset: 0 },
      { all: false, personId: ctx.personId, team: false, headedDepartmentIds: [] });
    return rows.map(toSummary);
  }

  async get(ctx: RequestContext, publicId: string): Promise<TicketDetail> {
    const { t } = await this.load(this.db, ctx, publicId, 'view');
    return this.detail(this.db, t.id);
  }

  // ---- creating and changing ----

  async create(ctx: RequestContext, req: CreateTicketRequest): Promise<{ ticket: TicketDetail; created: boolean }> {
    const publicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const tenant = await this.repo.tenantOfTicket(req.publicId);
      if (tenant === ctx.tenantId) {
        const { t } = await this.load(this.db, ctx, publicId, 'view');
        return { ticket: await this.detail(this.db, t.id), created: false };
      }
      if (tenant !== undefined) throw new AppError('TICKETS_DUPLICATE_ID', 409, 'This publicId is already used');
    }
    const company = await this.repo.findCompany(ctx.tenantId, req.company);
    if (!company) throw new AppError('TICKETS_UNKNOWN_COMPANY', 400, `Unknown company ${req.company}`);
    const type = await this.types.activeVersion(ctx.tenantId, req.typePublicId);
    if (type.legalEntityId !== company.id) throw new AppError('TICKETS_TYPE_OTHER_COMPANY', 400, `That ticket type belongs to another company than ${company.code}`);
    const dept = await this.repo.findDepartment(ctx.tenantId, req.departmentPublicId);
    if (!dept || dept.legalEntityId !== company.id) throw new AppError('TICKETS_UNKNOWN_DEPARTMENT', 400, `That department does not belong to ${company.code}`);
    const caller = this.caller(ctx);
    if (!canManage(caller, { headsDepartment: dept.headPersonId === ctx.personId, supervises: false, assignee: false, primary: false })) {
      throw new AppError('TICKETS_FORBIDDEN', 403, 'You can create tickets only for a department you head');
    }
    const supervisorId = await this.supervisorFor(ctx, company.id, req.supervisorPublicId, dept.headPersonId);
    const skillId = await this.skillFor(ctx, company.id, req.requiredSkillPublicId);
    const details = await this.checkedDetails(ctx, type.fields, req.details, null);
    const scheduledAt = new Date(req.scheduledAt);
    const planned = req.assignees
      ? await this.prepareAssignees(ctx, { legalEntityId: company.id, scheduledAt, requiredSkillId: skillId }, req.assignees, new Set())
      : { rows: [], warnings: [] };

    try {
      const id = await this.db.transaction(async (tx) => {
        const number = await this.nextNumber(tx, ctx.tenantId, company.id, company.code);
        const t = await this.repo.insertTicket(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: company.id, number, typeId: type.id,
          typeVersion: type.version, typeDetails: details, title: req.title, description: req.description ?? null, priority: req.priority,
          customerId: req.customerId ?? null, site: req.site ?? null, departmentId: dept.id, supervisorPersonId: supervisorId,
          requiredSkillId: skillId, scheduledAt, dueDate: req.dueDate ?? null, status: 'open', createdBy: ctx.personId });
        await this.event(tx, ctx.personId, { id: t.id, tenantId: ctx.tenantId, legalEntityId: company.id }, 'created', { number, type: type.code, typeVersion: type.version });
        if (planned.rows.length) await this.applyAssignees(tx, ctx.personId, await this.repo.ticketById(tx, t.id), planned.rows);
        return t.id;
      });
      return { ticket: await this.detail(this.db, id, planned.warnings), created: true };
    } catch (err) {
      if (violatedConstraint(err) === 'tickets_public_id_unique') return this.create(ctx, req); // the same request twice at once
      throw err;
    }
  }

  /** Change details (not after completion or cancellation). Type details are checked against the ticket's own type version. */
  async update(ctx: RequestContext, publicId: string, req: UpdateTicketRequest): Promise<TicketDetail> {
    return this.db.transaction(async (tx) => {
      const { t } = await this.load(tx, ctx, publicId, 'manage', true);
      this.requireUnfinished(t);
      const patch: Partial<TicketRow> = {};
      if (req.title !== undefined) patch.title = req.title;
      if (req.description !== undefined) patch.description = req.description;
      if (req.priority !== undefined) patch.priority = req.priority;
      if (req.customerId !== undefined) patch.customerId = req.customerId;
      if (req.site !== undefined) patch.site = req.site;
      if (req.scheduledAt !== undefined) patch.scheduledAt = new Date(req.scheduledAt);
      if (req.dueDate !== undefined) patch.dueDate = req.dueDate;
      if (req.supervisorPublicId !== undefined) patch.supervisorPersonId = await this.supervisorFor(ctx, t.legalEntityId, req.supervisorPublicId, null);
      if (req.requiredSkillPublicId !== undefined) patch.requiredSkillId = await this.skillFor(ctx, t.legalEntityId, req.requiredSkillPublicId ?? undefined);
      if (req.details !== undefined) {
        const type = await this.repo.typeVersion(tx, t.typeId);
        patch.typeDetails = await this.checkedDetails(ctx, type.fields as FieldDef[], req.details, t.id, tx);
      }
      const changed = Object.keys(patch).filter((k) => JSON.stringify(patch[k as keyof TicketRow]) !== JSON.stringify(t[k as keyof TicketRow]));
      if (changed.length) {
        await this.repo.updateTicket(tx, t.id, patch);
        await this.event(tx, ctx.personId, t, 'details_updated', { changed });
      }
      return this.detail(tx, t.id);
    });
  }

  /**
   * Set who works on the ticket (the whole list; people left out are taken off, never deleted). Exactly one primary.
   * Each must have an active job in the ticket's company and no approved leave on the scheduled date; a missing required
   * skill is only a warning. Nobody but Management adds themselves.
   */
  async assign(ctx: RequestContext, publicId: string, list: AssigneeInput[]): Promise<TicketDetail> {
    let warnings: Warning[] = [];
    const id = await this.db.transaction(async (tx) => {
      const { t } = await this.load(tx, ctx, publicId, 'manage', true);
      if (nextStatus(t.status as Status, 'assign') === null) throw this.wrongStatus(t, 'assign');
      const current = await this.repo.currentAssignees(tx, t.id);
      const planned = await this.prepareAssignees(ctx, t, list, new Set(current.map((a) => a.employmentPublicId)), tx);
      warnings = planned.warnings;
      await this.applyAssignees(tx, ctx.personId, t, planned.rows);
      return t.id;
    });
    return this.detail(this.db, id, warnings);
  }

  /** assigned → in_progress. The first ticket punch-in calls this too. */
  start(ctx: RequestContext, publicId: string): Promise<TicketDetail> {
    return this.move(ctx, publicId, 'start', 'work', {}, 'started');
  }

  hold(ctx: RequestContext, publicId: string, reason: string): Promise<TicketDetail> {
    return this.move(ctx, publicId, 'hold', 'manage', { holdReason: reason }, 'held', { reason });
  }

  resume(ctx: RequestContext, publicId: string): Promise<TicketDetail> {
    return this.move(ctx, publicId, 'resume', 'manage', { holdReason: null }, 'resumed');
  }

  cancel(ctx: RequestContext, publicId: string, reason: string): Promise<TicketDetail> {
    return this.move(ctx, publicId, 'cancel', 'manage', { cancelReason: reason, holdReason: null }, 'cancelled', { reason });
  }

  reopen(ctx: RequestContext, publicId: string, reason: string): Promise<TicketDetail> {
    return this.move(ctx, publicId, 'reopen', 'manage', { completedAt: null }, 'reopened', { reason });
  }

  /**
   * in_progress → completed, once the type version's completion rules are met (else 409 TICKETS_COMPLETION_INCOMPLETE
   * with details.missing). A QC ticket completed with a failed checklist item creates a rework production ticket.
   */
  async complete(ctx: RequestContext, publicId: string): Promise<TicketDetail> {
    const id = await this.db.transaction(async (tx) => {
      const { t } = await this.load(tx, ctx, publicId, 'complete', true);
      if (nextStatus(t.status as Status, 'complete') === null) throw this.wrongStatus(t, 'complete');
      const type = await this.repo.typeVersion(tx, t.typeId);
      const missing = await this.missing(tx, t, type);
      if (missing.length) throw new AppError('TICKETS_COMPLETION_INCOMPLETE', 409, `Not ready to complete: ${missing.join(', ')}`, { missing });
      await this.repo.updateTicket(tx, t.id, { status: 'completed', completedAt: new Date(), holdReason: null });
      await this.event(tx, ctx.personId, t, 'completed', { from: t.status, to: 'completed' });
      if (type.code === 'qc') await this.reworkIfFailed(tx, ctx, t);
      return t.id;
    });
    return this.detail(this.db, id);
  }

  // ---- number series (HR) ----

  async numberSeries(ctx: RequestContext): Promise<NumberSeries[]> {
    requireAll(ctx, TICKETS.numbering);
    return (await this.repo.series(ctx.tenantId)).map((s) => {
      const prefix = s.prefix ?? s.company;
      const next = s.nextNumber ?? 1;
      return { company: s.company, prefix, nextNumber: next, example: formatNumber(prefix, next) };
    });
  }

  /** Imported Froid tickets keep their numbers: set the next number after the highest imported one. */
  async setNumberSeries(ctx: RequestContext, companyCode: string, req: NumberSeriesRequest): Promise<NumberSeries> {
    requireAll(ctx, TICKETS.numbering);
    const company = await this.repo.findCompany(ctx.tenantId, companyCode);
    if (!company) throw new AppError('TICKETS_UNKNOWN_COMPANY', 404, `Unknown company ${companyCode}`);
    await this.repo.saveSeries(ctx.tenantId, company.id, req.prefix, req.nextNumber, ctx.personId);
    return { company: company.code, prefix: req.prefix, nextNumber: req.nextNumber, example: formatNumber(req.prefix, req.nextNumber) };
  }

  // ---- shared with TicketWorkService and TicketTimeService ----

  /** assigned → in_progress inside the caller's transaction (the first ticket punch-in). */
  async markStarted(tx: Tx, actorId: number, t: TicketRow, details: Record<string, unknown>): Promise<void> {
    await this.repo.updateTicket(tx, t.id, { status: 'in_progress' });
    await this.event(tx, actorId, t, 'started', { from: t.status, to: 'in_progress', ...details });
  }

  /** The ticket if the caller may see it (else 404 TICKETS_NOT_FOUND) and may do `check` on it (else 403 TICKETS_FORBIDDEN). */
  async load(conn: Conn, ctx: RequestContext, publicId: string, check: Check, lock = false): Promise<Loaded> {
    const t = await this.repo.findTicket(conn, ctx.tenantId, publicId, lock);
    if (!t) throw new AppError('TICKETS_NOT_FOUND', 404, 'Unknown ticket');
    const caller = this.caller(ctx);
    const assignees = await this.repo.currentAssignees(conn, t.id);
    const mine = assignees.find((a) => a.personId === ctx.personId);
    const rel: Relation = {
      headsDepartment: (await this.repo.departmentHead(conn, t.departmentId)) === ctx.personId,
      supervises: t.supervisorPersonId === ctx.personId, assignee: mine !== undefined, primary: mine?.isPrimary ?? false,
    };
    if (!canView(caller, rel)) throw new AppError('TICKETS_NOT_FOUND', 404, 'Unknown ticket');
    if (!CHECK[check](caller, rel)) {
      const why = { view: '', work: 'Only its assignees, its department head or admin can work on this ticket',
        manage: 'Only the department head, admin or Management can change this ticket', complete: 'Only the primary assignee, the department head or admin can complete this ticket' };
      throw new AppError('TICKETS_FORBIDDEN', 403, why[check]);
    }
    return { t, caller, rel };
  }

  caller(ctx: RequestContext): Caller {
    return { view: ctx.permissions[TICKETS.view], work: ctx.permissions[TICKETS.work], manage: ctx.permissions[TICKETS.manage], management: isManagement(ctx) };
  }

  requireUnfinished(t: TicketRow): void {
    if (isFinished(t.status as Status)) throw new AppError('TICKETS_FINISHED', 409, `Ticket ${t.number} is ${t.status}`);
  }

  async event(tx: Tx, actorId: number | null, t: TicketRef, action: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.repo.insertEvent(tx, { tenantId: t.tenantId, ticketId: t.id, legalEntityId: t.legalEntityId, actorPersonId: actorId, action, details });
  }

  /** Checks the people for a ticket (see assign). `already`: employment publicIds currently assigned (not re-checked for leave or self). */
  async prepareAssignees(ctx: RequestContext, t: { legalEntityId: number; scheduledAt: Date; requiredSkillId: number | null },
    list: AssigneeInput[], already: Set<string>, conn: Conn = this.db): Promise<{ rows: NewAssignee[]; warnings: Warning[] }> {
    const rows: NewAssignee[] = [];
    const warnings: Warning[] = [];
    const date = istDate(t.scheduledAt);
    for (const a of list) {
      const job = await this.repo.findEmployment(conn, ctx.tenantId, a.employmentPublicId);
      if (!job) throw new AppError('TICKETS_UNKNOWN_EMPLOYMENT', 400, `Unknown job ${a.employmentPublicId}`);
      if (job.legalEntityId !== t.legalEntityId) throw new AppError('TICKETS_ASSIGNEE_OTHER_COMPANY', 400, 'Assignees must work for the ticket\'s company', { employmentPublicId: job.publicId });
      if (job.status !== 'active') throw new AppError('TICKETS_ASSIGNEE_NOT_ACTIVE', 409, 'Assignees must be active employees', { employmentPublicId: job.publicId });
      if (!already.has(job.publicId)) {
        if (job.personId === ctx.personId && !isManagement(ctx)) {
          throw new AppError('TICKETS_SELF_ASSIGN', 403, 'You cannot assign yourself; Management can');
        }
        if (await this.repo.onApprovedLeave(job.id, date)) {
          throw new AppError('TICKETS_ASSIGNEE_ON_LEAVE', 409, `That person is on approved leave on ${date}`, { employmentPublicId: job.publicId, date });
        }
      }
      if (t.requiredSkillId !== null && !(await this.repo.hasSkill(job.personId, t.requiredSkillId))) {
        warnings.push({ code: 'TICKETS_ASSIGNEE_MISSING_SKILL', message: 'This person does not have the ticket\'s required skill', employmentPublicId: job.publicId });
      }
      rows.push({ employmentId: job.id, employmentPublicId: job.publicId, personId: job.personId, isPrimary: list.length === 1 || a.isPrimary === true });
    }
    return { rows, warnings };
  }

  /** Makes the current assignees exactly `rows`: ends the ones left out, then fixes the primary, then adds the new ones. */
  async applyAssignees(tx: Tx, actorId: number, t: TicketRow, rows: NewAssignee[]): Promise<void> {
    const current = await this.repo.currentAssignees(tx, t.id);
    const want = new Map(rows.map((r) => [r.employmentId, r]));
    const removed = current.filter((c) => !want.has(c.employmentId));
    for (const c of removed) await this.repo.endAssignee(tx, c.id, actorId);
    const kept = current.filter((c) => want.has(c.employmentId));
    for (const c of kept) if (c.isPrimary && !want.get(c.employmentId)!.isPrimary) await this.repo.setPrimary(tx, c.id, false);
    for (const c of kept) if (!c.isPrimary && want.get(c.employmentId)!.isPrimary) await this.repo.setPrimary(tx, c.id, true);
    const keptIds = new Set(kept.map((c) => c.employmentId));
    const added = rows.filter((r) => !keptIds.has(r.employmentId));
    for (const r of added) {
      await this.repo.insertAssignee(tx, { tenantId: t.tenantId, ticketId: t.id, employmentId: r.employmentId, legalEntityId: t.legalEntityId,
        isPrimary: r.isPrimary, assignedBy: actorId });
    }
    const primary = rows.find((r) => r.isPrimary)!.employmentPublicId;
    const before = current.find((c) => c.isPrimary)?.employmentPublicId ?? null;
    const status = nextStatus(t.status as Status, 'assign')!;
    if (!added.length && !removed.length && primary === before) return;
    if (status !== t.status) await this.repo.updateTicket(tx, t.id, { status });
    await this.event(tx, actorId, t, 'assignees_changed', {
      added: added.map((r) => r.employmentPublicId), removed: removed.map((c) => c.employmentPublicId), primary,
      ...(status !== t.status ? { from: t.status, to: status } : {}),
    });
  }

  /** The full view of a ticket. */
  async detail(conn: Conn, ticketId: number, warnings: Warning[] = []): Promise<TicketDetail> {
    const t = await this.repo.ticketById(conn, ticketId);
    const [summary, type, assignees, checklist, attachments, signoffs, links, events, reassigns] = await Promise.all([
      this.repo.summary(conn, ticketId), this.repo.typeVersion(conn, t.typeId), this.repo.currentAssignees(conn, ticketId),
      this.repo.latestChecklist(conn, ticketId), this.repo.attachments(conn, ticketId), this.repo.signoffs(conn, ticketId),
      this.repo.links(conn, ticketId), this.repo.events(conn, ticketId), this.repo.reassignRequests(conn, t.tenantId, { ticketId }),
    ]);
    const persons = await this.personRefs(conn, [t.createdBy, t.headApprovedBy]);
    const skill = t.requiredSkillId === null ? null : await this.skillRef(conn, t.requiredSkillId);
    const items = type.checklistItems as string[];
    return {
      ...toSummary(summary), description: t.description, details: t.typeDetails as Record<string, unknown>, projectId: null,
      holdReason: t.holdReason, cancelReason: t.cancelReason, requiredSkill: skill,
      headApproval: t.headApprovedBy && t.headApprovedAt ? { by: persons.get(t.headApprovedBy)!, at: t.headApprovedAt.toISOString() } : null,
      createdBy: persons.get(t.createdBy)!,
      typeRules: { fields: type.fields as TicketDetail['typeRules']['fields'], completionRules: rulesOf(type.completionRules), checklistItems: items },
      assignees: assignees.map(toAssignee),
      checklist: items.map((item) => {
        const r = checklist.get(item);
        return { item, result: (r?.result ?? null) as 'pass' | 'fail' | 'na' | null, note: r?.note ?? null,
          checkedBy: r ? { publicId: r.byPublicId, displayName: r.byName } : null, checkedAt: r?.checkedAt.toISOString() ?? null };
      }),
      attachments: attachments.map((a) => ({ publicId: a.publicId, kind: a.kind as 'photo' | 'file' | 'signoff', fileType: a.fileType,
        uploadedBy: { publicId: a.byPublicId, displayName: a.byName }, uploadedAt: a.uploadedAt.toISOString() })),
      signoffs: signoffs.map((s) => ({ publicId: s.publicId, signerName: s.signerName, signerRole: s.signerRole, signedAt: s.signedAt.toISOString(),
        photoPublicId: s.photoPublicId, recordedBy: { publicId: s.byPublicId, displayName: s.byName } })),
      links: links.map((l) => ({ direction: l.direction, kind: l.kind as 'follows' | 'rework_of',
        ticket: { publicId: l.publicId, number: l.number, title: l.title, status: l.status as Status } })),
      timeline: events.map((e) => ({ action: e.action, actor: e.actorPublicId ? { publicId: e.actorPublicId, displayName: e.actorName! } : null,
        at: e.at.toISOString(), details: (e.details ?? null) as Record<string, unknown> | null })),
      reassignRequests: reassigns.map(toReassign),
      missingForCompletion: isFinished(t.status as Status) ? [] : await this.missing(conn, t, type),
      warnings,
    };
  }

  // ---- helpers ----

  private async visibility(ctx: RequestContext): Promise<Visibility> {
    const c = this.caller(ctx);
    if (c.management || c.view === 'all' || c.manage === 'all') return { all: true };
    const team = c.view === 'team' || c.manage !== undefined;
    return { all: false, personId: ctx.personId, team, headedDepartmentIds: team ? await this.repo.departmentsHeadedBy(ctx.tenantId, ctx.personId) : [] };
  }

  private async move(ctx: RequestContext, publicId: string, mv: Move, check: Check, patch: Partial<TicketRow>, action: string,
    details: Record<string, unknown> = {}): Promise<TicketDetail> {
    const id = await this.db.transaction(async (tx) => {
      const { t } = await this.load(tx, ctx, publicId, check, true);
      const to = nextStatus(t.status as Status, mv);
      if (to === null) throw this.wrongStatus(t, mv);
      await this.repo.updateTicket(tx, t.id, { ...patch, status: to });
      await this.event(tx, ctx.personId, t, action, { from: t.status, to, ...details });
      return t.id;
    });
    return this.detail(this.db, id);
  }

  private wrongStatus(t: TicketRow, mv: Move): AppError {
    return new AppError('TICKETS_WRONG_STATUS', 409, `Ticket ${t.number} is ${t.status}; it cannot ${mv} now`, { status: t.status });
  }

  /** Smallest free number from the series' next number on (imported tickets may already hold some). */
  private async nextNumber(tx: Tx, tenantId: number, legalEntityId: number, companyCode: string): Promise<string> {
    const s = await this.repo.lockSeries(tx, tenantId, legalEntityId, companyCode.replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'T');
    let n = s.nextNumber;
    while (await this.repo.numberTaken(tx, legalEntityId, formatNumber(s.prefix, n))) n++;
    await this.repo.setNextNumber(tx, s.id, n + 1);
    return formatNumber(s.prefix, n);
  }

  private async supervisorFor(ctx: RequestContext, legalEntityId: number, publicId: string | undefined, fallback: number | null): Promise<number> {
    let id = fallback;
    if (publicId) {
      const p = await this.repo.findPerson(ctx.tenantId, publicId);
      if (!p) throw new AppError('TICKETS_UNKNOWN_SUPERVISOR', 400, 'Unknown supervisor');
      id = p.id;
    }
    if (id === null) throw new AppError('TICKETS_NO_SUPERVISOR', 400, 'The department has no head: name a supervisor');
    if (!(await this.repo.activeJob(this.db, id, legalEntityId))) {
      throw new AppError('TICKETS_SUPERVISOR_OTHER_COMPANY', 400, 'The supervisor must have an active job in the ticket\'s company');
    }
    return id;
  }

  private async skillFor(ctx: RequestContext, legalEntityId: number, publicId: string | undefined): Promise<number | null> {
    if (!publicId) return null;
    const s = await this.repo.findSkill(ctx.tenantId, publicId);
    if (!s || s.legalEntityId !== legalEntityId) throw new AppError('TICKETS_UNKNOWN_SKILL', 400, 'That skill is not in the ticket\'s company skills list');
    return s.id;
  }

  /** Validated type details (400 TICKETS_INVALID_DETAILS with details.errors). File values must be attachments of this ticket. */
  private async checkedDetails(ctx: RequestContext, fields: FieldDef[], details: Record<string, unknown>, ticketId: number | null,
    conn: Conn = this.db): Promise<Record<string, unknown>> {
    const r = checkDetails(fields, details, { filesLater: true });
    const known = await this.repo.existingPersons(ctx.tenantId, r.personIds);
    for (const id of r.personIds) if (!known.has(id)) r.errors.push(`${fields.find((f) => r.value[f.key] === id)?.key}: unknown person`);
    if (r.attachmentIds.length) {
      const mine = new Set(ticketId === null ? [] : (await this.repo.attachments(conn, ticketId)).map((a) => a.publicId));
      for (const id of r.attachmentIds) if (!mine.has(id)) r.errors.push(`${fields.find((f) => r.value[f.key] === id)?.key}: not a file of this ticket`);
    }
    if (r.errors.length) throw new AppError('TICKETS_INVALID_DETAILS', 400, `Type details do not fit the ticket type: ${r.errors.join('; ')}`, { errors: r.errors });
    return r.value;
  }

  private async missing(conn: Conn, t: TicketRow, type: { fields: unknown; completionRules: unknown; checklistItems: unknown }): Promise<string[]> {
    const [attachments, signoffs, checklist, dailyUpdates] = await Promise.all([
      this.repo.attachments(conn, t.id), this.repo.signoffs(conn, t.id), this.repo.latestChecklist(conn, t.id), this.repo.countEvents(conn, t.id, 'daily_update'),
    ]);
    return missingForCompletion(rulesOf(type.completionRules), {
      photos: attachments.filter((a) => a.kind === 'photo').length, files: attachments.filter((a) => a.kind === 'file').length,
      signoffs: signoffs.length, dailyUpdates, headApproved: t.headApprovedAt !== null,
      checklistItems: type.checklistItems as string[], answered: new Set(checklist.keys()),
      fields: type.fields as FieldDef[], details: t.typeDetails as Record<string, unknown>,
    });
  }

  /**
   * A QC ticket completed with any failed item: a production ticket "rework_of" the production ticket the QC ticket is
   * linked to (or of the QC ticket when there is none), assigned to that ticket's primary assignee (else the QC
   * ticket's supervisor, when they have an active job in the company). Skipped (and noted on the timeline) when the
   * company has no active production type.
   */
  private async reworkIfFailed(tx: Tx, ctx: RequestContext, qc: TicketRow): Promise<void> {
    const failed = [...(await this.repo.latestChecklist(tx, qc.id)).values()].filter((r) => r.result === 'fail').map((r) => r.item);
    if (failed.length === 0) return;
    const type = await this.types.activeVersionByCode(ctx.tenantId, qc.legalEntityId, 'production');
    if (!type) {
      await this.event(tx, null, qc, 'rework_skipped', { reason: 'The company has no active production ticket type', failed });
      return;
    }
    const link = (await this.repo.links(tx, qc.id)).find((l) => l.kind === 'follows' && l.typeCode === 'production');
    const source = link ? await this.repo.ticketById(tx, link.otherId) : null;
    const base = source ?? qc;
    const qcDetails = qc.typeDetails as Record<string, unknown>;
    const wanted: Record<string, unknown> = { ...(source ? (source.typeDetails as Record<string, unknown>) : {}) };
    if (wanted.item === undefined) wanted.item = qcDetails.checked_item ?? qc.title;
    const keys = new Set(type.fields.map((f) => f.key));
    const details = checkDetails(type.fields, Object.fromEntries(Object.entries(wanted).filter(([k]) => keys.has(k))), { filesLater: true });

    let assignee: NewAssignee | null = null;
    const primary = source ? (await this.repo.currentAssignees(tx, source.id)).find((a) => a.isPrimary && a.employmentStatus === 'active') : undefined;
    if (primary) assignee = { employmentId: primary.employmentId, employmentPublicId: primary.employmentPublicId, personId: primary.personId, isPrimary: true };
    else {
      const job = await this.repo.activeJob(tx, qc.supervisorPersonId, qc.legalEntityId);
      if (job) assignee = { employmentId: job.id, employmentPublicId: job.publicId, personId: qc.supervisorPersonId, isPrimary: true };
    }

    const number = await this.nextNumber(tx, qc.tenantId, qc.legalEntityId, (await this.companyCode(tx, qc)));
    const description = `Rework after QC ${qc.number}. Failed: ${failed.join('; ')}`.slice(0, 1000);
    const t = await this.repo.insertTicket(tx, { tenantId: qc.tenantId, legalEntityId: qc.legalEntityId, number, typeId: type.id, typeVersion: type.version,
      typeDetails: details.errors.length ? { item: String(wanted.item) } : details.value, title: `Rework: ${base.title}`.slice(0, 150), description,
      priority: qc.priority, customerId: base.customerId, site: base.site, projectId: base.projectId, departmentId: base.departmentId,
      supervisorPersonId: base.supervisorPersonId, scheduledAt: new Date(), status: 'open', createdBy: ctx.personId });
    const target = source ?? qc;
    await this.repo.insertLink(tx, { tenantId: qc.tenantId, fromTicketId: t.id, toTicketId: target.id, legalEntityId: qc.legalEntityId, kind: 'rework_of', createdBy: ctx.personId });
    await this.event(tx, ctx.personId, { id: t.id, tenantId: qc.tenantId, legalEntityId: qc.legalEntityId }, 'created', { number, type: 'production', automatic: true, qc: qc.number, reworkOf: target.number, failed });
    if (assignee) await this.applyAssignees(tx, ctx.personId, await this.repo.ticketById(tx, t.id), [assignee]);
    await this.event(tx, ctx.personId, qc, 'rework_created', { ticket: number, publicId: t.publicId, failed });
    if (source) await this.event(tx, ctx.personId, source, 'rework_created', { ticket: number, publicId: t.publicId, qc: qc.number });
  }

  private async companyCode(conn: Conn, t: TicketRow): Promise<string> {
    return (await this.repo.summary(conn, t.id)).company;
  }

  private async personRefs(conn: Conn, ids: (number | null)[]) {
    return this.repo.personRefs(conn, ids.filter((x): x is number => x !== null));
  }

  private skillRef(conn: Conn, id: number) {
    return this.repo.skillRef(conn, id);
  }
}

const rulesOf = (v: unknown) => CompletionRules.parse(v ?? {});

type SummaryRow = Awaited<ReturnType<TicketsRepository['list']>>[number];
type AssigneeRow = Awaited<ReturnType<TicketsRepository['currentAssignees']>>[number];
type ReassignRow = Awaited<ReturnType<TicketsRepository['reassignRequests']>>[number];

export function toSummary(r: SummaryRow): TicketSummary {
  const finished = r.status === 'completed' || r.status === 'cancelled';
  return {
    publicId: r.publicId, number: r.number, company: r.company, title: r.title, priority: r.priority, status: r.status as Status,
    type: { publicId: r.typePublicId, version: r.typeVersion, code: r.typeCode, name: r.typeName },
    department: { publicId: r.departmentPublicId, name: r.departmentName },
    supervisor: { publicId: r.supervisorPublicId, displayName: r.supervisorName },
    primaryAssignee: r.primaryJobPublicId ? {
      employmentPublicId: r.primaryJobPublicId, employeeCode: r.primaryCode!, person: { publicId: r.primaryPersonPublicId!, displayName: r.primaryName! },
      isPrimary: true, assignedAt: r.primaryAssignedAt!.toISOString(), assignedBy: { publicId: r.primaryAssignerPublicId!, displayName: r.primaryAssignerName! },
    } : null,
    customerId: r.customerId, site: r.site, scheduledAt: r.scheduledAt.toISOString(), dueDate: r.dueDate,
    overdue: !finished && r.dueDate !== null && r.dueDate < todayIst(), completedAt: r.completedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
  };
}

function toAssignee(a: AssigneeRow) {
  return { employmentPublicId: a.employmentPublicId, employeeCode: a.employeeCode, person: { publicId: a.personPublicId, displayName: a.personName },
    isPrimary: a.isPrimary, assignedAt: a.assignedAt.toISOString(), assignedBy: { publicId: a.assignerPublicId, displayName: a.assignerName } };
}

export function toReassign(r: ReassignRow) {
  const ref = (publicId: string | null, name: string | null) => (publicId ? { publicId, displayName: name! } : null);
  return {
    publicId: r.publicId, ticketPublicId: r.ticketPublicId, ticketNumber: r.ticketNumber, requestedBy: { publicId: r.requesterPublicId, displayName: r.requesterName },
    reason: r.reason, status: r.status as 'pending' | 'approved' | 'rejected', approver: ref(r.approverPublicId, r.approverName),
    newAssignee: ref(r.newPublicId, r.newName), decidedBy: ref(r.deciderPublicId, r.deciderName),
    decidedAs: (r.decidedAs ?? null) as 'approver' | 'management' | null, decidedAt: r.decidedAt?.toISOString() ?? null,
    decisionReason: r.decisionReason, createdAt: r.createdAt.toISOString(),
  };
}

