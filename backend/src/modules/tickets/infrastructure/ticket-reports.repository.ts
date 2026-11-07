import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte, inArray, isNull, lt, lte, max, or, sql, SQL, sum } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DB, Db } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { departments, employments } from '../../hrms/people/schema';
import { workDays } from '../../hrms/attendance/schema';
import {
  ticketAssignees, ticketDailyUpdates, ticketEvents, tickets, ticketTimeAdjustments, ticketTimeAllocations, ticketTimelogs, ticketTypes,
} from '../schema';

/** Which tickets a report covers: every one, or those of the departments the caller heads. */
export type ReportScope = { all: true } | { all: false; departmentIds: number[] };

const supervisor = alias(persons, 'supervisor');
const primaryA = alias(ticketAssignees, 'primary_assignee');
const primaryJob = alias(employments, 'primary_job');
const primaryPerson = alias(persons, 'primary_person');
const istDate = (column: SQL | typeof tickets.createdAt) => sql<string>`to_char((${column} AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')`;
const weekOf = (column: typeof tickets.createdAt | typeof tickets.completedAt) =>
  sql<string>`to_char(date_trunc('week', ${column} AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')`;
const UNFINISHED = ['open', 'assigned', 'in_progress', 'on_hold'];

/** Reads for ticket reports (nothing is written here). */
@Injectable()
export class TicketReportsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Tickets of the company (if given) within the scope. */
  private inScope(companyId: number | null, scope: ReportScope): SQL | undefined {
    if (!scope.all && scope.departmentIds.length === 0) return sql`false`;
    return and(companyId === null ? undefined : eq(tickets.legalEntityId, companyId), scope.all ? undefined : inArray(tickets.departmentId, scope.departmentIds));
  }

  /** Allocated minutes (calculated + adjustments) per ticket and person over work dates from..to. */
  async allocated(tenantId: number, from: string, to: string, companyId: number | null, scope: ReportScope, personIds?: number[]) {
    const rows = new Map<string, { ticketId: number; personId: number; minutes: number }>();
    const add = (r: { ticketId: number; personId: number; minutes: string | null }) => {
      const k = `${r.ticketId}:${r.personId}`;
      const row = rows.get(k) ?? { ticketId: r.ticketId, personId: r.personId, minutes: 0 };
      row.minutes += Number(r.minutes ?? 0);
      rows.set(k, row);
    };
    for (const table of [ticketTimeAllocations, ticketTimeAdjustments]) {
      const got = await this.db.select({ ticketId: table.ticketId, personId: table.personId, minutes: sum(table.minutes) }).from(table)
        .innerJoin(tickets, eq(tickets.id, table.ticketId))
        .where(and(eq(table.tenantId, tenantId), gte(table.workDate, from), lte(table.workDate, to), this.inScope(companyId, scope),
          personIds ? (personIds.length ? inArray(table.personId, personIds) : sql`false`) : undefined))
        .groupBy(table.ticketId, table.personId);
      got.forEach(add);
    }
    return [...rows.values()].filter((r) => r.minutes !== 0);
  }

  /** What the reports show about tickets. */
  async ticketInfo(ids: number[]) {
    if (ids.length === 0) return new Map<number, never>();
    const rows = await this.db.select({
      id: tickets.id, publicId: tickets.publicId, number: tickets.number, title: tickets.title, details: tickets.typeDetails, customerId: tickets.customerId,
      departmentPublicId: departments.publicId, departmentName: departments.name,
      typePublicId: ticketTypes.publicId, typeCode: ticketTypes.code, typeName: ticketTypes.name, fields: ticketTypes.fields,
    }).from(tickets)
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, tickets.typeId))
      .where(inArray(tickets.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }

  async personRefs(ids: number[]) {
    if (ids.length === 0) return new Map<number, { publicId: string; displayName: string }>();
    const rows = await this.db.select({ id: persons.id, publicId: persons.publicId, displayName: persons.displayName }).from(persons).where(inArray(persons.id, ids));
    return new Map(rows.map((r) => [r.id, { publicId: r.publicId, displayName: r.displayName }]));
  }

  /** Attended minutes per person over from..to (stored work days, jobs of the company if given). */
  async attendance(tenantId: number, from: string, to: string, companyId: number | null, personIds?: number[]) {
    const rows = await this.db.select({ personId: workDays.personId, minutes: sum(workDays.workedMinutes) }).from(workDays)
      .where(and(eq(workDays.tenantId, tenantId), gte(workDays.workDate, from), lte(workDays.workDate, to),
        companyId === null ? undefined : eq(workDays.legalEntityId, companyId),
        personIds ? (personIds.length ? inArray(workDays.personId, personIds) : sql`false`) : undefined))
      .groupBy(workDays.personId);
    return new Map(rows.map((r) => [r.personId, Number(r.minutes ?? 0)]));
  }

  /** People with a job in one of the departments during from..to. */
  async peopleOfDepartments(departmentIds: number[], from: string, to: string): Promise<number[]> {
    if (departmentIds.length === 0) return [];
    const rows = await this.db.selectDistinct({ personId: employments.personId }).from(employments)
      .where(and(inArray(employments.departmentId, departmentIds), lte(employments.joinedOn, to), or(isNull(employments.exitOn), gte(employments.exitOn, from))));
    return rows.map((r) => r.personId);
  }

  /** Tickets as report lines: overdue (due before today, unfinished) or on hold. */
  async ticketLines(tenantId: number, which: 'overdue' | 'on_hold', today: string, companyId: number | null, scope: ReportScope) {
    return this.db.select({
      id: tickets.id, publicId: tickets.publicId, number: tickets.number, title: tickets.title, status: tickets.status, priority: tickets.priority,
      dueDate: tickets.dueDate, holdReason: tickets.holdReason, company: legalEntities.code, typeCode: ticketTypes.code, typeName: ticketTypes.name,
      departmentPublicId: departments.publicId, departmentName: departments.name, supervisorPublicId: supervisor.publicId, supervisorName: supervisor.displayName,
      primaryPublicId: primaryPerson.publicId, primaryName: primaryPerson.displayName,
    }).from(tickets)
      .innerJoin(legalEntities, eq(legalEntities.id, tickets.legalEntityId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, tickets.typeId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .innerJoin(supervisor, eq(supervisor.id, tickets.supervisorPersonId))
      .leftJoin(primaryA, and(eq(primaryA.ticketId, tickets.id), eq(primaryA.isPrimary, true), isNull(primaryA.endedAt)))
      .leftJoin(primaryJob, eq(primaryJob.id, primaryA.employmentId))
      .leftJoin(primaryPerson, eq(primaryPerson.id, primaryJob.personId))
      .where(and(eq(tickets.tenantId, tenantId), this.inScope(companyId, scope),
        which === 'overdue' ? and(lt(tickets.dueDate, today), inArray(tickets.status, UNFINISHED)) : eq(tickets.status, 'on_hold')))
      .orderBy(tickets.dueDate, tickets.number);
  }

  /** When each ticket was last put on hold. */
  async heldSince(ticketIds: number[]) {
    if (ticketIds.length === 0) return new Map<number, Date>();
    const rows = await this.db.select({ ticketId: ticketEvents.ticketId, at: max(ticketEvents.at) }).from(ticketEvents)
      .where(and(inArray(ticketEvents.ticketId, ticketIds), eq(ticketEvents.action, 'held'))).groupBy(ticketEvents.ticketId);
    return new Map(rows.map((r) => [r.ticketId, r.at!]));
  }

  /** Tickets created / completed per week (Monday, IST) and type, between the IST dates. */
  async weekly(tenantId: number, from: Date, to: Date, companyId: number | null, scope: ReportScope) {
    const count_ = (column: typeof tickets.createdAt | typeof tickets.completedAt, completed: boolean) => this.db.select({
      week: weekOf(column), typePublicId: ticketTypes.publicId, code: ticketTypes.code, name: max(ticketTypes.name), n: count(),
    }).from(tickets).innerJoin(ticketTypes, eq(ticketTypes.id, tickets.typeId))
      .where(and(eq(tickets.tenantId, tenantId), this.inScope(companyId, scope), gte(column, from), lt(column, to),
        completed ? eq(tickets.status, 'completed') : undefined))
      .groupBy(weekOf(column), ticketTypes.publicId, ticketTypes.code);
    return { created: await count_(tickets.createdAt, false), completed: await count_(tickets.completedAt, true) };
  }

  /**
   * (ticket, job, IST date) where a timer ran that day but no daily update was given for it, with the person, and the
   * allocated minutes of that ticket-day.
   */
  async missingUpdates(tenantId: number, from: Date, to: Date, companyId: number | null, scope: ReportScope) {
    const day = istDate(sql`${ticketTimelogs.startedAt}`);
    const rows = await this.db.selectDistinct({ ticketId: ticketTimelogs.ticketId, employmentId: ticketTimelogs.employmentId, personId: employments.personId, date: day })
      .from(ticketTimelogs)
      .innerJoin(tickets, eq(tickets.id, ticketTimelogs.ticketId))
      .innerJoin(employments, eq(employments.id, ticketTimelogs.employmentId))
      .leftJoin(ticketDailyUpdates, and(eq(ticketDailyUpdates.ticketId, ticketTimelogs.ticketId), eq(ticketDailyUpdates.employmentId, ticketTimelogs.employmentId),
        sql`${ticketDailyUpdates.workDate} = (${ticketTimelogs.startedAt} AT TIME ZONE 'Asia/Kolkata')::date`))
      .where(and(eq(ticketTimelogs.tenantId, tenantId), gte(ticketTimelogs.startedAt, from), lt(ticketTimelogs.startedAt, to), isNull(ticketDailyUpdates.id),
        this.inScope(companyId, scope)));
    if (rows.length === 0) return [];
    const allocated = await this.db.select({ ticketId: ticketTimeAllocations.ticketId, employmentId: ticketTimeAllocations.employmentId,
      date: sql<string>`to_char(${ticketTimeAllocations.workDate}, 'YYYY-MM-DD')`, minutes: ticketTimeAllocations.minutes })
      .from(ticketTimeAllocations).where(inArray(ticketTimeAllocations.ticketId, [...new Set(rows.map((r) => r.ticketId))]));
    return rows.map((r) => ({ ...r, minutes: allocated.find((a) => a.ticketId === r.ticketId && a.employmentId === r.employmentId && a.date === r.date)?.minutes ?? 0 }));
  }

  // ---- dashboard ----

  async openByTypeAndPriority(tenantId: number, companyId: number | null, scope: ReportScope) {
    return this.db.select({ code: ticketTypes.code, name: max(ticketTypes.name), priority: tickets.priority, n: count() }).from(tickets)
      .innerJoin(ticketTypes, eq(ticketTypes.id, tickets.typeId))
      .where(and(eq(tickets.tenantId, tenantId), this.inScope(companyId, scope), inArray(tickets.status, UNFINISHED)))
      .groupBy(ticketTypes.code, tickets.priority);
  }

  async countOverdue(tenantId: number, today: string, companyId: number | null, scope: ReportScope): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), this.inScope(companyId, scope), lt(tickets.dueDate, today), inArray(tickets.status, UNFINISHED)));
    return row.n;
  }

  /** Tickets completed between the instants, with their type, created and completed times. */
  async completedBetween(tenantId: number, from: Date, to: Date, companyId: number | null, scope: ReportScope) {
    return this.db.select({
      id: tickets.id, code: ticketTypes.code, name: ticketTypes.name, createdAt: tickets.createdAt, completedAt: tickets.completedAt,
    }).from(tickets).innerJoin(ticketTypes, eq(ticketTypes.id, tickets.typeId))
      .where(and(eq(tickets.tenantId, tenantId), this.inScope(companyId, scope), eq(tickets.status, 'completed'),
        gte(tickets.completedAt, from), lt(tickets.completedAt, to)));
  }

  /** Allocated minutes (calculated + adjustments) per ticket, over all work dates. */
  async workedMinutes(ticketIds: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (ticketIds.length === 0) return out;
    for (const table of [ticketTimeAllocations, ticketTimeAdjustments]) {
      const rows = await this.db.select({ ticketId: table.ticketId, minutes: sum(table.minutes) }).from(table)
        .where(inArray(table.ticketId, ticketIds)).groupBy(table.ticketId);
      for (const r of rows) out.set(r.ticketId, (out.get(r.ticketId) ?? 0) + Number(r.minutes ?? 0));
    }
    return out;
  }

  /** The oldest unfinished tickets, oldest first. */
  async oldestOpen(tenantId: number, companyId: number | null, scope: ReportScope, limit: number) {
    return this.db.select({
      publicId: tickets.publicId, number: tickets.number, title: tickets.title, status: tickets.status, priority: tickets.priority,
      dueDate: tickets.dueDate, createdDate: istDate(tickets.createdAt), code: ticketTypes.code, name: ticketTypes.name,
    }).from(tickets).innerJoin(ticketTypes, eq(ticketTypes.id, tickets.typeId))
      .where(and(eq(tickets.tenantId, tenantId), this.inScope(companyId, scope), inArray(tickets.status, UNFINISHED)))
      .orderBy(tickets.createdAt, tickets.number).limit(limit);
  }

  async countCompleted(tenantId: number, from: Date, to: Date, companyId: number | null, scope: ReportScope): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(tickets)
      .where(and(eq(tickets.tenantId, tenantId), this.inScope(companyId, scope), eq(tickets.status, 'completed'),
        gte(tickets.completedAt, from), lt(tickets.completedAt, to)));
    return row.n;
  }
}
