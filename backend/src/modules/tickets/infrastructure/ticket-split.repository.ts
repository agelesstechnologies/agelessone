import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, inArray, or, SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { persons } from '../../core/schema';
import { tickets, ticketTimeSplitLines, ticketTimeSplitRequests } from '../schema';

const owner = alias(persons, 'split_owner');
const decider = alias(persons, 'split_decider');

/** Writes tickets.ticket_time_split_requests and ticket_time_split_lines (split suggestions). */
@Injectable()
export class TicketSplitRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private requestFields() {
    return {
      id: ticketTimeSplitRequests.id, publicId: ticketTimeSplitRequests.publicId, tenantId: ticketTimeSplitRequests.tenantId,
      personId: ticketTimeSplitRequests.personId, employmentId: ticketTimeSplitRequests.employmentId, legalEntityId: ticketTimeSplitRequests.legalEntityId,
      workDate: ticketTimeSplitRequests.workDate, note: ticketTimeSplitRequests.note, status: ticketTimeSplitRequests.status,
      decidedAs: ticketTimeSplitRequests.decidedAs, decidedAt: ticketTimeSplitRequests.decidedAt, decisionReason: ticketTimeSplitRequests.decisionReason,
      createdAt: ticketTimeSplitRequests.createdAt,
      ownerPublicId: owner.publicId, ownerName: owner.displayName, deciderPublicId: decider.publicId, deciderName: decider.displayName,
    };
  }

  /** One suggestion by its publicId (locked for a decision when asked). */
  async byPublicId(conn: Conn, tenantId: number, publicId: string, lock = false) {
    const match = and(eq(ticketTimeSplitRequests.tenantId, tenantId), eq(ticketTimeSplitRequests.publicId, publicId));
    // lock the row on its own (a lock can't take the outer-joined decider), then read it with the names
    if (lock) await conn.select({ id: ticketTimeSplitRequests.id }).from(ticketTimeSplitRequests).where(match).for('update');
    const [row] = await conn.select(this.requestFields()).from(ticketTimeSplitRequests)
      .innerJoin(owner, eq(owner.id, ticketTimeSplitRequests.personId))
      .leftJoin(decider, eq(decider.id, ticketTimeSplitRequests.decidedBy))
      .where(match);
    return row;
  }

  /**
   * Suggestions newest first. who null: every one in the tenant; otherwise the person's own and those with a ticket of a
   * department they head or a ticket they supervise.
   */
  async list(conn: Conn, tenantId: number, who: { personId: number; headOf: number[] } | null, status?: string) {
    const visible: SQL | undefined = who === null ? undefined : or(
      eq(ticketTimeSplitRequests.personId, who.personId),
      exists(conn.select({ one: sql`1` }).from(ticketTimeSplitLines).innerJoin(tickets, eq(tickets.id, ticketTimeSplitLines.ticketId))
        .where(and(eq(ticketTimeSplitLines.requestId, ticketTimeSplitRequests.id), or(
          eq(tickets.supervisorPersonId, who.personId),
          who.headOf.length ? inArray(tickets.departmentId, who.headOf) : sql`false`)))),
    );
    return conn.select(this.requestFields()).from(ticketTimeSplitRequests)
      .innerJoin(owner, eq(owner.id, ticketTimeSplitRequests.personId))
      .leftJoin(decider, eq(decider.id, ticketTimeSplitRequests.decidedBy))
      .where(and(eq(ticketTimeSplitRequests.tenantId, tenantId), status ? eq(ticketTimeSplitRequests.status, status) : undefined, visible))
      .orderBy(desc(ticketTimeSplitRequests.createdAt), desc(ticketTimeSplitRequests.id)).limit(200);
  }

  /** The lines of the suggestions given, with each ticket's number, department and supervisor. */
  async lines(conn: Conn, requestIds: number[]) {
    if (requestIds.length === 0) return [];
    return conn.select({
      requestId: ticketTimeSplitLines.requestId, ticketId: ticketTimeSplitLines.ticketId, beforeMinutes: ticketTimeSplitLines.beforeMinutes,
      suggestedMinutes: ticketTimeSplitLines.suggestedMinutes, approvedMinutes: ticketTimeSplitLines.approvedMinutes,
      ticketPublicId: tickets.publicId, number: tickets.number, title: tickets.title,
      departmentId: tickets.departmentId, supervisorPersonId: tickets.supervisorPersonId,
    }).from(ticketTimeSplitLines).innerJoin(tickets, eq(tickets.id, ticketTimeSplitLines.ticketId))
      .where(inArray(ticketTimeSplitLines.requestId, requestIds)).orderBy(asc(tickets.number));
  }

  async insert(tx: Tx, request: typeof ticketTimeSplitRequests.$inferInsert,
    lines: Omit<typeof ticketTimeSplitLines.$inferInsert, 'requestId'>[]): Promise<void> {
    const [row] = await tx.insert(ticketTimeSplitRequests).values(request).returning({ id: ticketTimeSplitRequests.id });
    await tx.insert(ticketTimeSplitLines).values(lines.map((l) => ({ ...l, requestId: row.id })));
  }

  /** A pending suggestion is decided or cancelled (once: the service checks it is still pending under a lock). */
  async close(tx: Tx, id: number, v: {
    status: 'approved' | 'rejected' | 'cancelled'; decidedBy?: number; decidedAs?: 'head' | 'management'; decisionReason?: string | null; adjustmentBatchId?: string | null;
  }): Promise<void> {
    await tx.update(ticketTimeSplitRequests).set({
      status: v.status, decidedBy: v.decidedBy ?? null, decidedAs: v.decidedAs ?? null, decidedAt: v.decidedBy ? new Date() : null,
      decisionReason: v.decisionReason ?? null, adjustmentBatchId: v.adjustmentBatchId ?? null,
    }).where(and(eq(ticketTimeSplitRequests.id, id), eq(ticketTimeSplitRequests.status, 'pending')));
  }

  async setApproved(tx: Tx, requestId: number, ticketId: number, minutes: number): Promise<void> {
    await tx.update(ticketTimeSplitLines).set({ approvedMinutes: minutes })
      .where(and(eq(ticketTimeSplitLines.requestId, requestId), eq(ticketTimeSplitLines.ticketId, ticketId)));
  }
}
