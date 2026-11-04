import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, gte, inArray, lt, ne, or } from 'drizzle-orm';
import { Correction, CorrectionKind, CorrectionStatus } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { employments } from '../../people/schema';
import { attendanceCorrections, attendanceEvents, attendanceExclusions } from '../schema';

export interface NewCorrection {
  tenantId: number; publicId: string; personId: number; employmentId: number; legalEntityId: number; workDate: string;
  kind: string; requestedIn: Date | null; requestedOut: Date | null; punchIdsToExclude: string[]; reason: string;
  requestedBy: number; approverPersonId: number | null;
}

const requester = aliasedTable(persons, 'requester');
const approver = aliasedTable(persons, 'approver');
const decider = aliasedTable(persons, 'decider');

/** Writes only hrms.attendance_corrections and hrms.attendance_exclusions (insert only); reads punches, days, people, jobs. */
@Injectable()
export class CorrectionsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** By public id across tenants: a public id is unique everywhere, so a resend can be recognised. */
  async findOwner(publicId: string) {
    const [row] = await this.db.select({ tenantId: attendanceCorrections.tenantId, requestedBy: attendanceCorrections.requestedBy })
      .from(attendanceCorrections).where(eq(attendanceCorrections.publicId, publicId));
    return row;
  }

  /** The job's punches in [from, to) with these public ids, and whether a correction already left them out. */
  async punchesByPublicId(conn: Conn, employmentId: number, from: Date, to: Date, publicIds: string[]) {
    if (publicIds.length === 0) return [];
    return conn.select({ id: attendanceEvents.id, publicId: attendanceEvents.publicId, excludedBy: attendanceExclusions.id })
      .from(attendanceEvents).leftJoin(attendanceExclusions, eq(attendanceExclusions.punchId, attendanceEvents.id))
      .where(and(eq(attendanceEvents.employmentId, employmentId), gte(attendanceEvents.occurredAt, from), lt(attendanceEvents.occurredAt, to),
        inArray(attendanceEvents.publicId, publicIds)));
  }

  async insert(tx: Tx, c: NewCorrection): Promise<void> {
    await tx.insert(attendanceCorrections).values(c);
  }

  async lock(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({
      id: attendanceCorrections.id, personId: attendanceCorrections.personId, employmentId: attendanceCorrections.employmentId,
      workDate: attendanceCorrections.workDate, requestedIn: attendanceCorrections.requestedIn, requestedOut: attendanceCorrections.requestedOut,
      punchIdsToExclude: attendanceCorrections.punchIdsToExclude, reason: attendanceCorrections.reason,
      status: attendanceCorrections.status, requestedBy: attendanceCorrections.requestedBy, approverPersonId: attendanceCorrections.approverPersonId,
    }).from(attendanceCorrections).where(and(eq(attendanceCorrections.tenantId, tenantId), eq(attendanceCorrections.publicId, publicId))).for('update');
    return row && { ...row, status: row.status as CorrectionStatus };
  }

  async decide(tx: Tx, id: number, status: 'approved' | 'rejected', decidedBy: number, reason?: string): Promise<void> {
    await tx.update(attendanceCorrections).set({ status, decidedBy, decidedAt: new Date(), decisionReason: reason ?? null }).where(eq(attendanceCorrections.id, id));
  }

  async cancel(tx: Tx, id: number, cancelledBy: number): Promise<void> {
    await tx.update(attendanceCorrections).set({ status: 'cancelled', cancelledBy, cancelledAt: new Date() }).where(eq(attendanceCorrections.id, id));
  }

  async insertExclusions(tx: Tx, rows: { tenantId: number; punchId: number; correctionId: number; reason: string }[]): Promise<void> {
    if (rows.length) await tx.insert(attendanceExclusions).values(rows);
  }

  async correction(tenantId: number, publicId: string): Promise<Correction | undefined> {
    const [row] = await this.view().where(and(eq(attendanceCorrections.tenantId, tenantId), eq(attendanceCorrections.publicId, publicId)));
    return row && toView(row);
  }

  /** Corrections about the person or filed by them, newest first. */
  async mine(personId: number, status?: CorrectionStatus): Promise<Correction[]> {
    const rows = await this.view().where(and(or(eq(attendanceCorrections.personId, personId), eq(attendanceCorrections.requestedBy, personId)),
      status ? eq(attendanceCorrections.status, status) : undefined)).orderBy(desc(attendanceCorrections.workDate), desc(attendanceCorrections.id));
    return rows.map(toView);
  }

  /** Submitted corrections naming the caller as approver (team), or anyone else's (all). */
  async toApprove(tenantId: number, personId: number, everyone: boolean): Promise<Correction[]> {
    const rows = await this.view().where(and(eq(attendanceCorrections.tenantId, tenantId), eq(attendanceCorrections.status, 'submitted'),
      everyone ? and(ne(attendanceCorrections.personId, personId), ne(attendanceCorrections.requestedBy, personId))
        : eq(attendanceCorrections.approverPersonId, personId)))
      .orderBy(asc(attendanceCorrections.workDate), asc(attendanceCorrections.id));
    return rows.map(toView);
  }

  private view() {
    return this.db.select({
      publicId: attendanceCorrections.publicId, personPublicId: persons.publicId, personName: persons.displayName,
      employmentPublicId: employments.publicId, company: legalEntities.code, workDate: attendanceCorrections.workDate,
      kind: attendanceCorrections.kind, requestedIn: attendanceCorrections.requestedIn, requestedOut: attendanceCorrections.requestedOut,
      punchIdsToExclude: attendanceCorrections.punchIdsToExclude, reason: attendanceCorrections.reason, status: attendanceCorrections.status,
      requesterPublicId: requester.publicId, requesterName: requester.displayName,
      approverPublicId: approver.publicId, approverName: approver.displayName,
      deciderPublicId: decider.publicId, deciderName: decider.displayName,
      decidedAt: attendanceCorrections.decidedAt, decisionReason: attendanceCorrections.decisionReason,
      cancelledAt: attendanceCorrections.cancelledAt, createdAt: attendanceCorrections.createdAt,
    }).from(attendanceCorrections)
      .innerJoin(persons, eq(persons.id, attendanceCorrections.personId))
      .innerJoin(employments, eq(employments.id, attendanceCorrections.employmentId))
      .innerJoin(legalEntities, eq(legalEntities.id, attendanceCorrections.legalEntityId))
      .innerJoin(requester, eq(requester.id, attendanceCorrections.requestedBy))
      .leftJoin(approver, eq(approver.id, attendanceCorrections.approverPersonId))
      .leftJoin(decider, eq(decider.id, attendanceCorrections.decidedBy))
      .$dynamic();
  }
}

interface ViewRow {
  publicId: string; personPublicId: string; personName: string; employmentPublicId: string; company: string; workDate: string;
  kind: string; requestedIn: Date | null; requestedOut: Date | null; punchIdsToExclude: string[]; reason: string; status: string;
  requesterPublicId: string; requesterName: string; approverPublicId: string | null; approverName: string | null;
  deciderPublicId: string | null; deciderName: string | null; decidedAt: Date | null; decisionReason: string | null;
  cancelledAt: Date | null; createdAt: Date;
}
function toView(r: ViewRow): Correction {
  return {
    publicId: r.publicId, person: { publicId: r.personPublicId, displayName: r.personName },
    employment: { publicId: r.employmentPublicId, company: r.company }, workDate: r.workDate, kind: r.kind as CorrectionKind,
    requestedIn: r.requestedIn?.toISOString() ?? null, requestedOut: r.requestedOut?.toISOString() ?? null,
    punchIdsToExclude: r.punchIdsToExclude, reason: r.reason, status: r.status as CorrectionStatus,
    requestedBy: { publicId: r.requesterPublicId, displayName: r.requesterName },
    approver: r.approverPublicId ? { publicId: r.approverPublicId, displayName: r.approverName! } : null,
    decidedBy: r.deciderPublicId ? { publicId: r.deciderPublicId, displayName: r.deciderName! } : null,
    decidedAt: r.decidedAt?.toISOString() ?? null, decisionReason: r.decisionReason,
    cancelledAt: r.cancelledAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
  };
}
