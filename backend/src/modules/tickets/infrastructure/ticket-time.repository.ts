import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { persons, places } from '../../core/schema';
import { departments, employments } from '../../hrms/people/schema';
import {
  ticketAssignees, ticketAttachments, ticketDailyUpdates, tickets, ticketTimeAdjustments, ticketTimeAllocations, ticketTimelogs, ticketTypes,
} from '../schema';

const adjuster = alias(persons, 'adjuster');
const owner = alias(persons, 'owner');

/** Writes tickets.ticket_timelogs, ticket_time_allocations, ticket_time_adjustments and ticket_daily_updates. */
@Injectable()
export class TicketTimeRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The same lock the daily punch takes, so ticket and daily punches of one person never interleave. */
  async lockPerson(tx: Tx, personId: number): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${personId}::bigint)`);
  }

  async timelogOwner(publicId: string) {
    const [row] = await this.db.select({ tenantId: ticketTimelogs.tenantId, personId: employments.personId }).from(ticketTimelogs)
      .innerJoin(employments, eq(employments.id, ticketTimelogs.employmentId)).where(eq(ticketTimelogs.publicId, publicId));
    return row;
  }

  /** Timelogs by their public ids, with the ticket's number, description, type details and the type's fields. */
  async timelogsByPublicIds(conn: Conn, publicIds: string[]) {
    if (publicIds.length === 0) return [];
    return conn.select({
      publicId: ticketTimelogs.publicId, startedAt: ticketTimelogs.startedAt, placeId: ticketTimelogs.placeId,
      ticketPublicId: tickets.publicId, number: tickets.number, description: tickets.description, details: tickets.typeDetails, fields: ticketTypes.fields,
    }).from(ticketTimelogs)
      .innerJoin(tickets, eq(tickets.id, ticketTimelogs.ticketId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, tickets.typeId))
      .where(inArray(ticketTimelogs.publicId, publicIds));
  }

  /** The person's open timelogs, oldest first. */
  async running(conn: Conn, personId: number) {
    return conn.select({
      id: ticketTimelogs.id, publicId: ticketTimelogs.publicId, ticketId: ticketTimelogs.ticketId, employmentId: ticketTimelogs.employmentId,
      tenantId: ticketTimelogs.tenantId, legalEntityId: ticketTimelogs.legalEntityId, startedAt: ticketTimelogs.startedAt,
      ticketPublicId: tickets.publicId, number: tickets.number, title: tickets.title, status: tickets.status,
    }).from(ticketTimelogs)
      .innerJoin(employments, eq(employments.id, ticketTimelogs.employmentId))
      .innerJoin(tickets, eq(tickets.id, ticketTimelogs.ticketId))
      .where(and(eq(employments.personId, personId), isNull(ticketTimelogs.endedAt)))
      .orderBy(asc(ticketTimelogs.startedAt), asc(ticketTimelogs.id));
  }

  /** People with a timer running (for the daily check of forgotten ones). */
  async peopleWithRunningTimers(): Promise<{ personId: number; tenantId: number }[]> {
    return this.db.selectDistinct({ personId: employments.personId, tenantId: ticketTimelogs.tenantId }).from(ticketTimelogs)
      .innerJoin(employments, eq(employments.id, ticketTimelogs.employmentId)).where(isNull(ticketTimelogs.endedAt));
  }

  async insertTimelog(tx: Tx, v: typeof ticketTimelogs.$inferInsert): Promise<void> {
    await tx.insert(ticketTimelogs).values(v);
  }

  async closeTimelog(tx: Tx, id: number, endedAt: Date, endReason: 'manual' | 'day_punch_out' | 'unfinished'): Promise<void> {
    await tx.update(ticketTimelogs).set({ endedAt, endReason }).where(and(eq(ticketTimelogs.id, id), isNull(ticketTimelogs.endedAt)));
  }

  /** The person's timelogs touching [from, to), closed ones only or all, with their ticket. */
  async timelogs(conn: Conn, personId: number, from: Date, to: Date, closedOnly: boolean) {
    return conn.select({
      publicId: ticketTimelogs.publicId, ticketId: ticketTimelogs.ticketId, employmentId: ticketTimelogs.employmentId, legalEntityId: ticketTimelogs.legalEntityId,
      startedAt: ticketTimelogs.startedAt, endedAt: ticketTimelogs.endedAt, endReason: ticketTimelogs.endReason,
      ticketPublicId: tickets.publicId, number: tickets.number, title: tickets.title,
    }).from(ticketTimelogs)
      .innerJoin(employments, eq(employments.id, ticketTimelogs.employmentId))
      .innerJoin(tickets, eq(tickets.id, ticketTimelogs.ticketId))
      .where(and(eq(employments.personId, personId), lt(ticketTimelogs.startedAt, to),
        closedOnly ? and(isNotNull(ticketTimelogs.endedAt), gt(ticketTimelogs.endedAt, from)) : or(isNull(ticketTimelogs.endedAt), gt(ticketTimelogs.endedAt, from))))
      .orderBy(asc(ticketTimelogs.startedAt), asc(ticketTimelogs.id));
  }

  /** Every ticket punch on one ticket (all people), newest first, with the punch-in address once looked up. */
  async ticketTimelogs(conn: Conn, ticketId: number) {
    return conn.select({
      publicId: ticketTimelogs.publicId, startedAt: ticketTimelogs.startedAt, endedAt: ticketTimelogs.endedAt, endReason: ticketTimelogs.endReason,
      personPublicId: persons.publicId, displayName: persons.displayName, employeeCode: employments.employeeCode, address: places.address,
    }).from(ticketTimelogs)
      .innerJoin(employments, eq(employments.id, ticketTimelogs.employmentId))
      .innerJoin(persons, eq(persons.id, employments.personId))
      .leftJoin(places, eq(places.id, ticketTimelogs.placeId))
      .where(eq(ticketTimelogs.ticketId, ticketId))
      .orderBy(desc(ticketTimelogs.startedAt), desc(ticketTimelogs.id));
  }

  /** Counted minutes per person on one ticket: the calculated daily allocations plus reviewers' adjustments. */
  async ticketMinutesByPerson(conn: Conn, ticketId: number): Promise<{ personPublicId: string; displayName: string; minutes: number }[]> {
    const rows = await conn.execute<{ person_public_id: string; display_name: string; minutes: string }>(sql`
      SELECT p.public_id AS person_public_id, p.display_name, SUM(x.minutes) AS minutes FROM (
        SELECT person_id, minutes FROM ${ticketTimeAllocations} WHERE ticket_id = ${ticketId}
        UNION ALL
        SELECT person_id, minutes FROM ${ticketTimeAdjustments} WHERE ticket_id = ${ticketId}
      ) x JOIN ${persons} p ON p.id = x.person_id
      GROUP BY p.public_id, p.display_name HAVING SUM(x.minutes) > 0 ORDER BY SUM(x.minutes) DESC`);
    return rows.rows.map((r) => ({ personPublicId: r.person_public_id, displayName: r.display_name, minutes: Number(r.minutes) }));
  }

  /** Every reviewer's adjustment on one ticket (all people and days), in the order made. */
  async ticketAdjustments(conn: Conn, ticketId: number) {
    return conn.select({
      workDate: ticketTimeAdjustments.workDate, minutes: ticketTimeAdjustments.minutes, reason: ticketTimeAdjustments.reason,
      adjustedAs: ticketTimeAdjustments.adjustedAs, createdAt: ticketTimeAdjustments.createdAt,
      personPublicId: owner.publicId, personName: owner.displayName, byName: adjuster.displayName,
    }).from(ticketTimeAdjustments)
      .innerJoin(owner, eq(owner.id, ticketTimeAdjustments.personId))
      .innerJoin(adjuster, eq(adjuster.id, ticketTimeAdjustments.adjustedBy))
      .where(eq(ticketTimeAdjustments.ticketId, ticketId))
      .orderBy(asc(ticketTimeAdjustments.id));
  }

  // ---- allocations and adjustments ----

  async allocations(conn: Conn, personId: number, date: string) {
    return conn.select({
      ticketId: ticketTimeAllocations.ticketId, employmentId: ticketTimeAllocations.employmentId, legalEntityId: ticketTimeAllocations.legalEntityId,
      minutes: ticketTimeAllocations.minutes, ticketPublicId: tickets.publicId, number: tickets.number, title: tickets.title,
    }).from(ticketTimeAllocations).innerJoin(tickets, eq(tickets.id, ticketTimeAllocations.ticketId))
      .where(and(eq(ticketTimeAllocations.personId, personId), eq(ticketTimeAllocations.workDate, date)))
      .orderBy(asc(tickets.number));
  }

  async saveAllocation(tx: Tx, v: { tenantId: number; ticketId: number; employmentId: number; legalEntityId: number; personId: number; workDate: string; minutes: number }) {
    await tx.insert(ticketTimeAllocations).values(v).onConflictDoUpdate({
      target: [ticketTimeAllocations.ticketId, ticketTimeAllocations.employmentId, ticketTimeAllocations.workDate],
      set: { minutes: v.minutes, calculatedAt: new Date() },
    });
  }

  async adjustments(conn: Conn, personId: number, date: string) {
    return conn.select({
      batchId: ticketTimeAdjustments.batchId, ticketId: ticketTimeAdjustments.ticketId, employmentId: ticketTimeAdjustments.employmentId,
      legalEntityId: ticketTimeAdjustments.legalEntityId, minutes: ticketTimeAdjustments.minutes, reason: ticketTimeAdjustments.reason,
      adjustedAs: ticketTimeAdjustments.adjustedAs, createdAt: ticketTimeAdjustments.createdAt,
      ticketPublicId: tickets.publicId, number: tickets.number, title: tickets.title, byPublicId: adjuster.publicId, byName: adjuster.displayName,
    }).from(ticketTimeAdjustments)
      .innerJoin(tickets, eq(tickets.id, ticketTimeAdjustments.ticketId))
      .innerJoin(adjuster, eq(adjuster.id, ticketTimeAdjustments.adjustedBy))
      .where(and(eq(ticketTimeAdjustments.personId, personId), eq(ticketTimeAdjustments.workDate, date)))
      .orderBy(asc(ticketTimeAdjustments.id));
  }

  async insertAdjustments(tx: Tx, rows: (typeof ticketTimeAdjustments.$inferInsert)[]): Promise<void> {
    await tx.insert(ticketTimeAdjustments).values(rows);
  }

  /** The person's job on the ticket: their current assignment, else an earlier one. */
  async assignmentOf(conn: Conn, ticketId: number, personId: number): Promise<{ employmentId: number; current: boolean } | undefined> {
    const [row] = await conn.select({ employmentId: ticketAssignees.employmentId, endedAt: ticketAssignees.endedAt }).from(ticketAssignees)
      .innerJoin(employments, eq(employments.id, ticketAssignees.employmentId))
      .where(and(eq(ticketAssignees.ticketId, ticketId), eq(employments.personId, personId)))
      .orderBy(sql`${ticketAssignees.endedAt} IS NULL DESC`, desc(ticketAssignees.id)).limit(1);
    return row ? { employmentId: row.employmentId, current: row.endedAt === null } : undefined;
  }

  /** Departments (by id) of tickets the person has time on that day. */
  async departmentsOfDay(conn: Conn, personId: number, date: string): Promise<{ departmentId: number; supervisorPersonId: number }[]> {
    return conn.selectDistinct({ departmentId: tickets.departmentId, supervisorPersonId: tickets.supervisorPersonId }).from(ticketTimeAllocations)
      .innerJoin(tickets, eq(tickets.id, ticketTimeAllocations.ticketId))
      .where(and(eq(ticketTimeAllocations.personId, personId), eq(ticketTimeAllocations.workDate, date)));
  }

  // ---- daily updates ----

  async dailyUpdateOwner(publicId: string) {
    const [row] = await this.db.select({ tenantId: ticketDailyUpdates.tenantId, ticketId: ticketDailyUpdates.ticketId, personId: employments.personId })
      .from(ticketDailyUpdates).innerJoin(employments, eq(employments.id, ticketDailyUpdates.employmentId)).where(eq(ticketDailyUpdates.publicId, publicId));
    return row;
  }

  async insertDailyUpdate(tx: Tx, v: typeof ticketDailyUpdates.$inferInsert): Promise<{ id: number; publicId: string }> {
    const [row] = await tx.insert(ticketDailyUpdates).values(v).returning({ id: ticketDailyUpdates.id, publicId: ticketDailyUpdates.publicId });
    return row;
  }

  async insertAttachment(tx: Tx, v: typeof ticketAttachments.$inferInsert): Promise<void> {
    await tx.insert(ticketAttachments).values(v);
  }

  async dailyUpdates(conn: Conn, ticketId: number, publicId?: string) {
    const rows = await conn.select({
      id: ticketDailyUpdates.id, publicId: ticketDailyUpdates.publicId, workDate: ticketDailyUpdates.workDate, note: ticketDailyUpdates.note,
      percentComplete: ticketDailyUpdates.percentComplete, createdAt: ticketDailyUpdates.createdAt, personPublicId: owner.publicId, personName: owner.displayName,
    }).from(ticketDailyUpdates)
      .innerJoin(employments, eq(employments.id, ticketDailyUpdates.employmentId))
      .innerJoin(owner, eq(owner.id, employments.personId))
      .where(and(eq(ticketDailyUpdates.ticketId, ticketId), publicId ? eq(ticketDailyUpdates.publicId, publicId) : undefined))
      .orderBy(desc(ticketDailyUpdates.workDate), desc(ticketDailyUpdates.id));
    const files = rows.length === 0 ? [] : await conn.select({ dailyUpdateId: ticketAttachments.dailyUpdateId, publicId: ticketAttachments.publicId,
      kind: ticketAttachments.kind, fileType: ticketAttachments.fileType }).from(ticketAttachments)
      .where(inArray(ticketAttachments.dailyUpdateId, rows.map((r) => r.id))).orderBy(asc(ticketAttachments.id));
    return rows.map((r) => ({ ...r, attachments: files.filter((f) => f.dailyUpdateId === r.id) }));
  }

  /**
   * Who had ticket time on a date (a timer started that IST day) without a daily update on that ticket for the date.
   * departmentIds null: every department.
   */
  async withoutUpdate(conn: Conn, tenantId: number, date: string, from: Date, to: Date, who: { personId?: number; departmentIds?: number[] | null }) {
    if (who.departmentIds && who.departmentIds.length === 0) return [];
    const rows = await conn.selectDistinct({
      ticketId: tickets.id, ticketPublicId: tickets.publicId, number: tickets.number, title: tickets.title,
      departmentPublicId: departments.publicId, departmentName: departments.name,
      employmentId: ticketTimelogs.employmentId, personId: owner.id, personPublicId: owner.publicId, personName: owner.displayName,
    }).from(ticketTimelogs)
      .innerJoin(tickets, eq(tickets.id, ticketTimelogs.ticketId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .innerJoin(employments, eq(employments.id, ticketTimelogs.employmentId))
      .innerJoin(owner, eq(owner.id, employments.personId))
      .leftJoin(ticketDailyUpdates, and(eq(ticketDailyUpdates.ticketId, ticketTimelogs.ticketId), eq(ticketDailyUpdates.employmentId, ticketTimelogs.employmentId),
        eq(ticketDailyUpdates.workDate, date)))
      .where(and(eq(ticketTimelogs.tenantId, tenantId), gte(ticketTimelogs.startedAt, from), lt(ticketTimelogs.startedAt, to), isNull(ticketDailyUpdates.id),
        who.personId === undefined ? undefined : eq(employments.personId, who.personId),
        who.departmentIds ? inArray(tickets.departmentId, who.departmentIds) : undefined))
      .orderBy(asc(tickets.number), asc(owner.displayName));
    const minutes = rows.length === 0 ? [] : await conn.select({ ticketId: ticketTimeAllocations.ticketId, employmentId: ticketTimeAllocations.employmentId,
      minutes: ticketTimeAllocations.minutes }).from(ticketTimeAllocations)
      .where(and(eq(ticketTimeAllocations.workDate, date), inArray(ticketTimeAllocations.ticketId, rows.map((r) => r.ticketId))));
    return rows.map((r) => ({ ...r, minutes: minutes.find((m) => m.ticketId === r.ticketId && m.employmentId === r.employmentId)?.minutes ?? 0 }));
  }
}
