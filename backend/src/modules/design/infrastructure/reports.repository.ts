import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Conn } from '../../../platform/db/db.module';
import { customers } from '../../core/schema';
import { ticketTimeAdjustments, ticketTimeAllocations } from '../../tickets/schema';
import { designJobs, drawingRevisions, drawings, jobTickets, qcReviews, transmittalItems, transmittals } from '../schema';

/** Design reports for one company (reads only; ticket time through the tickets schema). */
@Injectable()
export class DesignReportsRepository {
  drawings(conn: Conn, companyId: number, f: { jobPublicId?: string; discipline?: string }) {
    return conn.select({
      drawingId: drawings.id, drawingPublicId: drawings.publicId, drawingNumber: drawings.number, title: drawings.title, discipline: drawings.discipline,
      jobPublicId: designJobs.publicId, jobNumber: designJobs.number, customer: customers.name,
    }).from(drawings)
      .innerJoin(designJobs, eq(designJobs.id, drawings.jobId))
      .innerJoin(customers, eq(customers.id, designJobs.customerId))
      .where(and(eq(drawings.legalEntityId, companyId), f.jobPublicId ? eq(designJobs.publicId, f.jobPublicId) : undefined,
        f.discipline ? eq(drawings.discipline, f.discipline) : undefined))
      .orderBy(asc(designJobs.number), asc(drawings.number));
  }

  /** Revisions in one status (submitted: waiting for QC), oldest first, with their drawing and job. */
  revisionsIn(conn: Conn, companyId: number, status: string) {
    return conn.select({
      revisionId: drawingRevisions.id, revisionPublicId: drawingRevisions.publicId, code: drawingRevisions.code, submittedBy: drawingRevisions.submittedBy,
      submittedAt: drawingRevisions.submittedAt, drawingPublicId: drawings.publicId, drawingNumber: drawings.number, title: drawings.title,
      jobPublicId: designJobs.publicId, jobNumber: designJobs.number,
    }).from(drawingRevisions)
      .innerJoin(drawings, eq(drawings.id, drawingRevisions.drawingId))
      .innerJoin(designJobs, eq(designJobs.id, drawings.jobId))
      .where(and(eq(drawingRevisions.legalEntityId, companyId), eq(drawingRevisions.status, status)))
      .orderBy(asc(drawingRevisions.submittedAt), asc(drawingRevisions.id));
  }

  /** Issued revisions with no response yet, with the transmittal that issued them, oldest first. */
  awaitingResponse(conn: Conn, companyId: number) {
    return conn.select({
      revisionPublicId: drawingRevisions.publicId, code: drawingRevisions.code, drawingPublicId: drawings.publicId, drawingNumber: drawings.number, title: drawings.title,
      jobPublicId: designJobs.publicId, jobNumber: designJobs.number, transmittalPublicId: transmittals.publicId, transmittalNumber: transmittals.number,
      purpose: transmittals.purpose, recipient: transmittals.recipient, issuedAt: transmittals.issuedAt,
    }).from(drawingRevisions)
      .innerJoin(drawings, eq(drawings.id, drawingRevisions.drawingId))
      .innerJoin(designJobs, eq(designJobs.id, drawings.jobId))
      .innerJoin(transmittalItems, eq(transmittalItems.revisionId, drawingRevisions.id))
      .innerJoin(transmittals, eq(transmittals.id, transmittalItems.transmittalId))
      .where(and(eq(drawingRevisions.legalEntityId, companyId), eq(drawingRevisions.status, 'issued')))
      .orderBy(asc(transmittals.issuedAt), asc(drawings.number));
  }

  /** QC decisions per discipline and decision, made between two IST dates (both included). */
  qcByDiscipline(conn: Conn, companyId: number, from: string, to: string) {
    return conn.select({ discipline: drawings.discipline, decision: qcReviews.decision, n: count() }).from(qcReviews)
      .innerJoin(drawingRevisions, eq(drawingRevisions.id, qcReviews.revisionId))
      .innerJoin(drawings, eq(drawings.id, drawingRevisions.drawingId))
      .where(and(eq(qcReviews.legalEntityId, companyId),
        sql`(${qcReviews.decidedAt} AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date`))
      .groupBy(drawings.discipline, qcReviews.decision)
      .orderBy(asc(drawings.discipline));
  }

  jobs(conn: Conn, companyId: number, jobPublicId?: string) {
    return conn.select({ id: designJobs.id, publicId: designJobs.publicId, number: designJobs.number, status: designJobs.status, customer: customers.name })
      .from(designJobs).innerJoin(customers, eq(customers.id, designJobs.customerId))
      .where(and(eq(designJobs.legalEntityId, companyId), jobPublicId ? eq(designJobs.publicId, jobPublicId) : undefined))
      .orderBy(asc(designJobs.number));
  }

  async ticketsPerJob(conn: Conn, jobIds: number[]): Promise<Map<number, number>> {
    if (jobIds.length === 0) return new Map();
    const rows = await conn.select({ jobId: jobTickets.jobId, n: count() }).from(jobTickets).where(inArray(jobTickets.jobId, jobIds)).groupBy(jobTickets.jobId);
    return new Map(rows.map((r) => [r.jobId, Number(r.n)]));
  }

  /** Minutes of ticket time per job: allocations plus the heads' adjustments, optionally between two work dates. */
  async minutesPerJob(conn: Conn, jobIds: number[], from?: string, to?: string): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (jobIds.length === 0) return out;
    for (const t of [ticketTimeAllocations, ticketTimeAdjustments]) {
      const rows = await conn.select({ jobId: jobTickets.jobId, minutes: sql<number>`coalesce(sum(${t.minutes}), 0)::int` }).from(t)
        .innerJoin(jobTickets, eq(jobTickets.ticketId, t.ticketId))
        .where(and(inArray(jobTickets.jobId, jobIds), from ? gte(t.workDate, from) : undefined, to ? lte(t.workDate, to) : undefined))
        .groupBy(jobTickets.jobId);
      for (const r of rows) out.set(r.jobId, (out.get(r.jobId) ?? 0) + Number(r.minutes));
    }
    return out;
  }
}
