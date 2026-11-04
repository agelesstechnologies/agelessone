import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, ne, or } from 'drizzle-orm';
import { OvertimeRequestView, OvertimeStatus } from '@ageless/shared';
import { DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { employments } from '../../people/schema';
import { tickets } from '../../../tickets/schema';
import { overtimeRequests } from '../schema';

export interface NewOvertimeRequest {
  tenantId: number; publicId: string; personId: number; employmentId: number; legalEntityId: number; workDate: string;
  minutes: number; reason: string; ticketId: number | null; requestedBy: number; approverPersonId: number | null;
}

const requester = aliasedTable(persons, 'requester');
const approver = aliasedTable(persons, 'approver');
const decider = aliasedTable(persons, 'decider');

/** Writes only hrms.overtime_requests; reads people, jobs, companies and tickets. */
@Injectable()
export class OvertimeRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** By public id across tenants: a public id is unique everywhere, so a resend can be recognised. */
  async findOwner(publicId: string) {
    const [row] = await this.db.select({ tenantId: overtimeRequests.tenantId, requestedBy: overtimeRequests.requestedBy })
      .from(overtimeRequests).where(eq(overtimeRequests.publicId, publicId));
    return row;
  }

  async findTicket(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.tenantId, tenantId), eq(tickets.publicId, publicId)));
    return row;
  }

  async insert(tx: Tx, r: NewOvertimeRequest): Promise<void> {
    await tx.insert(overtimeRequests).values(r);
  }

  async lock(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({
      id: overtimeRequests.id, personId: overtimeRequests.personId, employmentId: overtimeRequests.employmentId,
      workDate: overtimeRequests.workDate, status: overtimeRequests.status, requestedBy: overtimeRequests.requestedBy,
      approverPersonId: overtimeRequests.approverPersonId,
    }).from(overtimeRequests).where(and(eq(overtimeRequests.tenantId, tenantId), eq(overtimeRequests.publicId, publicId))).for('update');
    return row && { ...row, status: row.status as OvertimeStatus };
  }

  async decide(tx: Tx, id: number, status: 'approved' | 'rejected', decidedBy: number, reason?: string): Promise<void> {
    await tx.update(overtimeRequests).set({ status, decidedBy, decidedAt: new Date(), decisionReason: reason ?? null }).where(eq(overtimeRequests.id, id));
  }

  async cancel(tx: Tx, id: number, cancelledBy: number): Promise<void> {
    await tx.update(overtimeRequests).set({ status: 'cancelled', cancelledBy, cancelledAt: new Date() }).where(eq(overtimeRequests.id, id));
  }

  async request(tenantId: number, publicId: string): Promise<OvertimeRequestView | undefined> {
    const [row] = await this.view().where(and(eq(overtimeRequests.tenantId, tenantId), eq(overtimeRequests.publicId, publicId)));
    return row && toView(row);
  }

  /** Requests about the person or filed by them, newest first. */
  async mine(personId: number, status?: OvertimeStatus): Promise<OvertimeRequestView[]> {
    const rows = await this.view().where(and(or(eq(overtimeRequests.personId, personId), eq(overtimeRequests.requestedBy, personId)),
      status ? eq(overtimeRequests.status, status) : undefined)).orderBy(desc(overtimeRequests.workDate), desc(overtimeRequests.id));
    return rows.map(toView);
  }

  /** Submitted requests naming the caller as approver (team), or anyone else's (all). */
  async toApprove(tenantId: number, personId: number, everyone: boolean): Promise<OvertimeRequestView[]> {
    const rows = await this.view().where(and(eq(overtimeRequests.tenantId, tenantId), eq(overtimeRequests.status, 'submitted'),
      everyone ? and(ne(overtimeRequests.personId, personId), ne(overtimeRequests.requestedBy, personId))
        : eq(overtimeRequests.approverPersonId, personId)))
      .orderBy(asc(overtimeRequests.workDate), asc(overtimeRequests.id));
    return rows.map(toView);
  }

  private view() {
    return this.db.select({
      publicId: overtimeRequests.publicId, personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, workDate: overtimeRequests.workDate,
      minutes: overtimeRequests.minutes, reason: overtimeRequests.reason, ticketPublicId: tickets.publicId, ticketNumber: tickets.number,
      status: overtimeRequests.status, requesterPublicId: requester.publicId, requesterName: requester.displayName,
      approverPublicId: approver.publicId, approverName: approver.displayName,
      deciderPublicId: decider.publicId, deciderName: decider.displayName,
      decidedAt: overtimeRequests.decidedAt, decisionReason: overtimeRequests.decisionReason,
      cancelledAt: overtimeRequests.cancelledAt, createdAt: overtimeRequests.createdAt,
    }).from(overtimeRequests)
      .innerJoin(persons, eq(persons.id, overtimeRequests.personId))
      .innerJoin(employments, eq(employments.id, overtimeRequests.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, overtimeRequests.legalEntityId))
      .innerJoin(requester, eq(requester.id, overtimeRequests.requestedBy))
      .leftJoin(tickets, eq(tickets.id, overtimeRequests.ticketId))
      .leftJoin(approver, eq(approver.id, overtimeRequests.approverPersonId))
      .leftJoin(decider, eq(decider.id, overtimeRequests.decidedBy))
      .$dynamic();
  }
}

interface ViewRow {
  publicId: string; personPublicId: string; personName: string; employmentPublicId: string; company: string; workDate: string;
  minutes: number; reason: string; ticketPublicId: string | null; ticketNumber: string | null; status: string;
  requesterPublicId: string; requesterName: string; approverPublicId: string | null; approverName: string | null;
  deciderPublicId: string | null; deciderName: string | null; decidedAt: Date | null; decisionReason: string | null;
  cancelledAt: Date | null; createdAt: Date;
}
function toView(r: ViewRow): OvertimeRequestView {
  return {
    publicId: r.publicId, person: { publicId: r.personPublicId, displayName: r.personName },
    employment: { publicId: r.employmentPublicId, company: r.company }, workDate: r.workDate, minutes: r.minutes, reason: r.reason,
    ticket: r.ticketPublicId ? { publicId: r.ticketPublicId, number: r.ticketNumber! } : null,
    status: r.status as OvertimeStatus, requestedBy: { publicId: r.requesterPublicId, displayName: r.requesterName },
    approver: r.approverPublicId ? { publicId: r.approverPublicId, displayName: r.approverName! } : null,
    decidedBy: r.deciderPublicId ? { publicId: r.deciderPublicId, displayName: r.deciderName! } : null,
    decidedAt: r.decidedAt?.toISOString() ?? null, decisionReason: r.decisionReason,
    cancelledAt: r.cancelledAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
  };
}
