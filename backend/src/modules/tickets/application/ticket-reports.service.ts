import { Inject, Injectable } from '@nestjs/common';
import {
  AsOfQuery, HoursQuery, HoursReport, MissingUpdatesReport, MissingUpdatesReportQuery, OnHoldReport, OverdueReport, TicketDashboard,
  TicketDashboardQuery, TicketField, TicketStatus, UtilisationQuery, UtilisationReport, WeeklyQuery, WeeklyReport,
} from '@ageless/shared';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { addDays, istDayStart, todayIst } from '../../../platform/time';
import { toCsv } from '../../../platform/csv';
import { TicketsRepository } from '../infrastructure/tickets.repository';
import { ReportScope, TicketReportsRepository } from '../infrastructure/ticket-reports.repository';
import { TicketsService } from './tickets.service';

type CsvFile = { name: string; body: string };
type Line = Awaited<ReturnType<TicketReportsRepository['ticketLines']>>[number];
const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
const hoursText = (minutes: number) => (minutes / 60).toFixed(2);
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const total = (values: number[]) => values.reduce((a, b) => a + b, 0);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const NO_CUSTOMER = '(no customer)';

/**
 * Ticket reports and dashboard numbers, always from allocated time (the shared time per work day plus heads'
 * adjustments), never raw timer time. Department heads see their departments' tickets (and, for utilisation, the
 * people of their departments); HR, admin user and Management see everything; others none. Each report says its period,
 * company and when it was produced, and has a CSV with the same rows and totals.
 */
@Injectable()
export class TicketReportsService {
  constructor(
    @Inject(TicketReportsRepository) private readonly repo: TicketReportsRepository,
    @Inject(TicketsRepository) private readonly ticketsRepo: TicketsRepository,
    @Inject(TicketsService) private readonly tickets: TicketsService,
  ) {}

  // ---- hours ----

  async hours(ctx: RequestContext, q: HoursQuery): Promise<HoursReport> {
    const { scope, companyId } = await this.access(ctx, q.company);
    const allocated = await this.repo.allocated(ctx.tenantId, q.from, q.to, companyId, scope);
    const info = await this.repo.ticketInfo([...new Set(allocated.map((a) => a.ticketId))]);
    const people = await this.repo.personRefs([...new Set(allocated.map((a) => a.personId))]);
    const groups = new Map<string, { key: string | null; label: string; minutes: number }>();
    for (const a of allocated) {
      const t = info.get(a.ticketId)!;
      const [key, label] = ((): [string | null, string] => {
        switch (q.by) {
          case 'ticket': return [t.publicId, `${t.number} ${t.title}`];
          case 'type': return [t.typePublicId, t.typeName];
          case 'person': return [people.get(a.personId)!.publicId, people.get(a.personId)!.displayName];
          case 'department': return [t.departmentPublicId, t.departmentName];
          default: return [null, customerOf(t) ?? NO_CUSTOMER];
        }
      })();
      const id = key ?? `name:${label}`;
      const g = groups.get(id) ?? { key, label, minutes: 0 };
      g.minutes += a.minutes;
      groups.set(id, g);
    }
    const rows = [...groups.values()].sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label))
      .map((g) => ({ ...g, hours: hours(g.minutes) }));
    const minutes = total(rows.map((r) => r.minutes));
    return { report: 'hours', company: q.company ?? null, from: q.from, to: q.to, producedAt: new Date().toISOString(), by: q.by, rows,
      totals: { minutes, hours: hours(minutes) } };
  }

  hoursCsv(r: HoursReport): CsvFile {
    const label = { ticket: 'Ticket', type: 'Ticket type', person: 'Person', department: 'Department', customer: 'Customer' }[r.by];
    return this.csv(r, `Ticket hours by ${r.by}`, [label, 'Minutes', 'Hours'],
      [...r.rows.map((x) => [x.label, x.minutes, hoursText(x.minutes)]), ['TOTAL', r.totals.minutes, hoursText(r.totals.minutes)]]);
  }

  // ---- utilisation and unallocated time ----

  async utilisation(ctx: RequestContext, q: UtilisationQuery): Promise<UtilisationReport> {
    const { scope, companyId } = await this.access(ctx, q.company);
    const people = scope.all ? undefined : await this.repo.peopleOfDepartments(scope.departmentIds, q.from, q.to);
    const attendance = await this.repo.attendance(ctx.tenantId, q.from, q.to, companyId, people);
    const ticket = new Map<number, number>();
    for (const a of await this.repo.allocated(ctx.tenantId, q.from, q.to, companyId, { all: true }, people)) ticket.set(a.personId, (ticket.get(a.personId) ?? 0) + a.minutes);
    const ids = [...new Set([...(people ?? []), ...attendance.keys(), ...ticket.keys()])];
    const refs = await this.repo.personRefs(ids);
    const line = (att: number, tick: number) => ({ attendanceMinutes: att, ticketMinutes: tick, unallocatedMinutes: att - tick, utilisationPercent: percent(tick, att) });
    const rows = ids.map((id) => ({ person: refs.get(id)!, ...line(attendance.get(id) ?? 0, ticket.get(id) ?? 0) }))
      .filter((r) => r.attendanceMinutes !== 0 || r.ticketMinutes !== 0)
      .sort((a, b) => a.person.displayName.localeCompare(b.person.displayName));
    return { report: 'utilisation', company: q.company ?? null, from: q.from, to: q.to, producedAt: new Date().toISOString(), rows,
      totals: line(total(rows.map((r) => r.attendanceMinutes)), total(rows.map((r) => r.ticketMinutes))) };
  }

  utilisationCsv(r: UtilisationReport): CsvFile {
    const cells = (x: UtilisationReport['totals']) => [x.attendanceMinutes, hoursText(x.attendanceMinutes), x.ticketMinutes, hoursText(x.ticketMinutes),
      x.unallocatedMinutes, hoursText(x.unallocatedMinutes), x.utilisationPercent === null ? '' : x.utilisationPercent.toFixed(1)];
    return this.csv(r, 'Ticket utilisation', ['Person', 'Attendance minutes', 'Attendance hours', 'Ticket minutes', 'Ticket hours',
      'Unallocated minutes', 'Unallocated hours', 'Utilisation %'], [...r.rows.map((x) => [x.person.displayName, ...cells(x)]), ['TOTAL', ...cells(r.totals)]]);
  }

  // ---- overdue and on hold (as of today) ----

  async overdue(ctx: RequestContext, q: AsOfQuery): Promise<OverdueReport> {
    const { scope, companyId } = await this.access(ctx, q.company);
    const today = todayIst();
    const rows = (await this.repo.ticketLines(ctx.tenantId, 'overdue', today, companyId, scope)).map((l) => ({ ...toLine(l), daysOverdue: daysBetween(l.dueDate!, today) }));
    return { report: 'overdue', company: q.company ?? null, from: today, to: today, producedAt: new Date().toISOString(), rows, totals: { tickets: rows.length } };
  }

  overdueCsv(r: OverdueReport): CsvFile {
    return this.csv(r, 'Overdue tickets', [...LINE_HEADER, 'Days overdue'], [...r.rows.map((x) => [...lineCells(x), x.daysOverdue]), ['TOTAL', r.totals.tickets]]);
  }

  async onHold(ctx: RequestContext, q: AsOfQuery): Promise<OnHoldReport> {
    const { scope, companyId } = await this.access(ctx, q.company);
    const today = todayIst();
    const lines = await this.repo.ticketLines(ctx.tenantId, 'on_hold', today, companyId, scope);
    const since = await this.repo.heldSince(lines.map((l) => l.id));
    const rows = lines.map((l) => ({ ...toLine(l), holdReason: l.holdReason ?? '', heldSince: since.get(l.id)?.toISOString() ?? null }));
    return { report: 'on_hold', company: q.company ?? null, from: today, to: today, producedAt: new Date().toISOString(), rows, totals: { tickets: rows.length } };
  }

  onHoldCsv(r: OnHoldReport): CsvFile {
    return this.csv(r, 'Tickets on hold', [...LINE_HEADER, 'Hold reason', 'On hold since'],
      [...r.rows.map((x) => [...lineCells(x), x.holdReason, x.heldSince]), ['TOTAL', r.totals.tickets]]);
  }

  // ---- created vs completed per week ----

  async weekly(ctx: RequestContext, q: WeeklyQuery): Promise<WeeklyReport> {
    const { scope, companyId } = await this.access(ctx, q.company);
    const { created, completed } = await this.repo.weekly(ctx.tenantId, istDayStart(q.from), istDayStart(addDays(q.to, 1)), companyId, scope);
    const rows = new Map<string, WeeklyReport['rows'][number]>();
    const row = (week: string, type: string, code: string, name: string | null) => {
      const k = `${week}:${type}`;
      const r = rows.get(k) ?? { weekStart: week, type: { code, name: name ?? code }, created: 0, completed: 0 };
      rows.set(k, r);
      return r;
    };
    for (const c of created) row(c.week, c.typePublicId, c.code, c.name).created += c.n;
    for (const c of completed) row(c.week, c.typePublicId, c.code, c.name).completed += c.n;
    const list = [...rows.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.type.code.localeCompare(b.type.code));
    return { report: 'weekly', company: q.company ?? null, from: q.from, to: q.to, producedAt: new Date().toISOString(), rows: list,
      totals: { created: total(list.map((r) => r.created)), completed: total(list.map((r) => r.completed)) } };
  }

  weeklyCsv(r: WeeklyReport): CsvFile {
    return this.csv(r, 'Tickets created and completed per week', ['Week starting', 'Type', 'Created', 'Completed'],
      [...r.rows.map((x) => [x.weekStart, x.type.name, x.created, x.completed]), ['TOTAL', '', r.totals.created, r.totals.completed]]);
  }

  // ---- missing daily updates per person ----

  async missingUpdates(ctx: RequestContext, q: MissingUpdatesReportQuery): Promise<MissingUpdatesReport> {
    const { scope, companyId } = await this.access(ctx, q.company);
    const found = await this.repo.missingUpdates(ctx.tenantId, istDayStart(q.from), istDayStart(addDays(q.to, 1)), companyId, scope);
    const refs = await this.repo.personRefs([...new Set(found.map((f) => f.personId))]);
    const per = new Map<number, { missingUpdates: number; tickets: Set<number>; minutes: number }>();
    for (const f of found) {
      const p = per.get(f.personId) ?? { missingUpdates: 0, tickets: new Set<number>(), minutes: 0 };
      p.missingUpdates++;
      p.tickets.add(f.ticketId);
      p.minutes += f.minutes;
      per.set(f.personId, p);
    }
    const rows = [...per].map(([id, p]) => ({ person: refs.get(id)!, missingUpdates: p.missingUpdates, tickets: p.tickets.size, minutes: p.minutes }))
      .sort((a, b) => b.missingUpdates - a.missingUpdates || a.person.displayName.localeCompare(b.person.displayName));
    return { report: 'missing_updates', company: q.company ?? null, from: q.from, to: q.to, producedAt: new Date().toISOString(), rows,
      totals: { missingUpdates: total(rows.map((r) => r.missingUpdates)), minutes: total(rows.map((r) => r.minutes)) } };
  }

  missingUpdatesCsv(r: MissingUpdatesReport): CsvFile {
    return this.csv(r, 'Missing daily updates', ['Person', 'Missing updates (ticket-days)', 'Tickets', 'Allocated minutes on them'],
      [...r.rows.map((x) => [x.person.displayName, x.missingUpdates, x.tickets, x.minutes]), ['TOTAL', r.totals.missingUpdates, '', r.totals.minutes]]);
  }

  // ---- dashboard ----

  /** Open tickets by type and priority, overdue, completed this month vs last month (IST). */
  async dashboard(ctx: RequestContext, q: TicketDashboardQuery): Promise<TicketDashboard> {
    const { scope, companyId } = await this.access(ctx, q.company);
    const today = todayIst();
    const month = today.slice(0, 7);
    const monthStart = `${month}-01`;
    const lastStart = addMonths(monthStart, -1);
    const nextStart = addMonths(monthStart, 1);
    const open = await this.repo.openByTypeAndPriority(ctx.tenantId, companyId, scope);
    const byType = new Map<string, { type: { code: string; name: string }; count: number }>();
    const byPriority = new Map<number, number>();
    for (const o of open) {
      const t = byType.get(o.code) ?? { type: { code: o.code, name: o.name ?? o.code }, count: 0 };
      t.count += o.n;
      byType.set(o.code, t);
      byPriority.set(o.priority, (byPriority.get(o.priority) ?? 0) + o.n);
    }
    return {
      company: q.company ?? null, producedAt: new Date().toISOString(), month, lastMonth: lastStart.slice(0, 7),
      open: total(open.map((o) => o.n)),
      openByType: [...byType.values()].sort((a, b) => b.count - a.count || a.type.code.localeCompare(b.type.code)),
      openByPriority: [...byPriority].map(([priority, count]) => ({ priority, count })).sort((a, b) => a.priority - b.priority),
      openByTypeAndPriority: open.map((o) => ({ type: { code: o.code, name: o.name ?? o.code }, priority: o.priority, count: o.n }))
        .sort((a, b) => a.type.code.localeCompare(b.type.code) || a.priority - b.priority),
      overdue: await this.repo.countOverdue(ctx.tenantId, today, companyId, scope),
      completedThisMonth: await this.repo.countCompleted(ctx.tenantId, istDayStart(monthStart), istDayStart(nextStart), companyId, scope),
      completedLastMonth: await this.repo.countCompleted(ctx.tenantId, istDayStart(lastStart), istDayStart(monthStart), companyId, scope),
    };
  }

  // ---- helpers ----

  /** Everything for HR, admin user and Management; a head's departments; nobody else (403). The company, if named. */
  private async access(ctx: RequestContext, companyCode: string | undefined): Promise<{ scope: ReportScope; companyId: number | null }> {
    const c = this.tickets.caller(ctx);
    let scope: ReportScope = { all: true };
    if (!(c.management || c.view === 'all' || c.manage === 'all')) {
      const heads = await this.ticketsRepo.departmentsHeadedBy(ctx.tenantId, ctx.personId);
      if (heads.length === 0) throw new AppError('TICKETS_FORBIDDEN', 403, 'Ticket reports are for department heads, HR, admin user and Management');
      scope = { all: false, departmentIds: heads };
    }
    if (!companyCode) return { scope, companyId: null };
    const company = await this.ticketsRepo.findCompany(ctx.tenantId, companyCode);
    if (!company) throw new AppError('TICKETS_UNKNOWN_COMPANY', 400, `Unknown company ${companyCode}`);
    return { scope, companyId: company.id };
  }

  private csv(r: { report: string; company: string | null; from: string; to: string; producedAt: string }, name: string, header: string[],
    rows: (string | number | null)[][]): CsvFile {
    const period = r.report === 'overdue' || r.report === 'on_hold' ? `as of ${r.from}` : `${r.from} to ${r.to}`;
    const body = toCsv([['Report', name], ['Company', r.company ?? 'All companies'], ['Period', period], ['Produced at', r.producedAt]], header, rows);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { name: `${slug}-${r.company ?? 'all'}-${r.from}-${r.to}.csv`, body };
  }
}

const LINE_HEADER = ['Ticket', 'Title', 'Company', 'Type', 'Status', 'Priority', 'Department', 'Supervisor', 'Primary assignee', 'Due date'];

function toLine(l: Line) {
  return {
    ticket: { publicId: l.publicId, number: l.number, title: l.title }, company: l.company, type: { code: l.typeCode, name: l.typeName },
    status: l.status as TicketStatus, priority: l.priority, department: { publicId: l.departmentPublicId, name: l.departmentName },
    supervisor: { publicId: l.supervisorPublicId, displayName: l.supervisorName },
    primaryAssignee: l.primaryPublicId ? { publicId: l.primaryPublicId, displayName: l.primaryName! } : null, dueDate: l.dueDate,
  };
}

function lineCells(x: ReturnType<typeof toLine>): (string | number | null)[] {
  return [x.ticket.number, x.ticket.title, x.company, x.type.name, x.status, x.priority, x.department.name, x.supervisor.displayName,
    x.primaryAssignee?.displayName ?? null, x.dueDate];
}

/** The customer of a ticket: its type's customer field (text until the customer register exists). */
function customerOf(t: { fields: unknown; details: unknown }): string | null {
  const key = (t.fields as TicketField[]).find((f) => f.type === 'customer')?.key;
  const v = key ? (t.details as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** The first day of the month n months away (YYYY-MM-01). */
function addMonths(firstOfMonth: string, n: number): string {
  const d = new Date(`${firstOfMonth}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
