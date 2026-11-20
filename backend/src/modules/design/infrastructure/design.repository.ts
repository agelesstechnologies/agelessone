import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { PersonRef } from '@ageless/shared';
import { Conn, Tx } from '../../../platform/db/db.module';
import { customers, legalEntities, persons } from '../../core/schema';
import { departments, employments } from '../../hrms/people/schema';
import { ticketAssignees, tickets, ticketTimeAdjustments, ticketTimeAllocations } from '../../tickets/schema';
import { icTicketBilling } from '../../intercompany/schema';
import {
  clientResponses, designCounters, designJobs, drawingRevisions, drawings, jobAttachments, jobTickets, qcReviewFiles, qcReviews, revisionFiles,
  transmittalItems, transmittals,
} from '../schema';
import { Series } from '../domain/numbers';

export type JobRow = Awaited<ReturnType<DesignRepository['jobs']>>[number];
export type DrawingRow = Awaited<ReturnType<DesignRepository['drawings']>>[number];
export type RevisionRow = Awaited<ReturnType<DesignRepository['revisions']>>[number];
export type FileRow = Awaited<ReturnType<DesignRepository['files']>>[number];
export type TransmittalRow = Awaited<ReturnType<DesignRepository['transmittals']>>[number];

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Writes only design.*. Reads companies, customers and people (core), departments and jobs (hrms), tickets and their
 * assignees (tickets) and ticket billing (intercompany) through their schema.ts.
 */
@Injectable()
export class DesignRepository {
  // ---- companies, people, access ----

  async company(conn: Conn, tenantId: number, code: string): Promise<{ id: number; code: string; name: string } | undefined> {
    const [c] = await conn.select({ id: legalEntities.id, code: legalEntities.code, name: legalEntities.name }).from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return c;
  }

  companies(conn: Conn, tenantId: number): Promise<{ id: number; code: string; name: string }[]> {
    return conn.select({ id: legalEntities.id, code: legalEntities.code, name: legalEntities.name }).from(legalEntities)
      .where(eq(legalEntities.tenantId, tenantId)).orderBy(asc(legalEntities.code));
  }

  async companiesById(conn: Conn, ids: number[]): Promise<Map<number, { id: number; code: string; name: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await conn.select({ id: legalEntities.id, code: legalEntities.code, name: legalEntities.name }).from(legalEntities).where(inArray(legalEntities.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** The company's department with this code prefix (the Designing department), with its head. */
  async department(conn: Conn, companyId: number, prefix: string): Promise<{ id: number; headPersonId: number | null } | undefined> {
    const [d] = await conn.select({ id: departments.id, headPersonId: departments.headPersonId }).from(departments)
      .where(and(eq(departments.legalEntityId, companyId), eq(departments.codePrefix, prefix)));
    return d;
  }

  async departmentHead(conn: Conn, departmentId: number): Promise<number | null> {
    const [d] = await conn.select({ headPersonId: departments.headPersonId }).from(departments).where(eq(departments.id, departmentId));
    return d?.headPersonId ?? null;
  }

  /** The companies a person holds a current job in (active or serving notice). */
  async companiesOf(conn: Conn, personId: number): Promise<Set<number>> {
    const rows = await conn.selectDistinct({ id: employments.legalEntityId }).from(employments)
      .where(and(eq(employments.personId, personId), inArray(employments.status, ['active', 'notice'])));
    return new Set(rows.map((r) => r.id));
  }

  async personByPublicId(conn: Conn, tenantId: number, publicId: string): Promise<{ id: number } | undefined> {
    const [p] = await conn.select({ id: persons.id }).from(persons).where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, publicId)));
    return p;
  }

  async persons(conn: Conn, ids: (number | null | undefined)[]): Promise<Map<number, PersonRef>> {
    const wanted = [...new Set(ids.filter((i): i is number => typeof i === 'number'))];
    if (wanted.length === 0) return new Map();
    const rows = await conn.select({ id: persons.id, publicId: persons.publicId, displayName: persons.displayName }).from(persons).where(inArray(persons.id, wanted));
    return new Map(rows.map((r) => [r.id, { publicId: r.publicId, displayName: r.displayName }]));
  }

  /** People assigned to a ticket of the job: still assigned (current), or ever. */
  async assigneesOfJob(conn: Conn, jobId: number, currentOnly: boolean): Promise<Set<number>> {
    const rows = await conn.selectDistinct({ personId: employments.personId }).from(jobTickets)
      .innerJoin(ticketAssignees, eq(ticketAssignees.ticketId, jobTickets.ticketId))
      .innerJoin(employments, eq(employments.id, ticketAssignees.employmentId))
      .where(and(eq(jobTickets.jobId, jobId), currentOnly ? isNull(ticketAssignees.endedAt) : undefined));
    return new Set(rows.map((r) => r.personId));
  }

  /** The jobs a person is or was assigned to through their tickets. */
  async jobsOfAssignee(conn: Conn, personId: number): Promise<number[]> {
    const rows = await conn.selectDistinct({ jobId: jobTickets.jobId }).from(jobTickets)
      .innerJoin(ticketAssignees, eq(ticketAssignees.ticketId, jobTickets.ticketId))
      .innerJoin(employments, eq(employments.id, ticketAssignees.employmentId))
      .where(eq(employments.personId, personId));
    return rows.map((r) => r.jobId);
  }

  // ---- numbers ----

  /** The next number of a company's series, taken atomically (the counter row is created on first use). */
  async nextNumber(tx: Tx, tenantId: number, companyId: number, series: Series): Promise<number> {
    const [row] = await tx.insert(designCounters).values({ tenantId, legalEntityId: companyId, series, lastNumber: 1 })
      .onConflictDoUpdate({ target: [designCounters.legalEntityId, designCounters.series], set: { lastNumber: sql.raw('"counters"."last_number" + 1') } })
      .returning({ n: designCounters.lastNumber });
    return row.n;
  }

  // ---- design jobs ----

  jobs(conn: Conn, tenantId: number, f: { id?: number; publicId?: string; companyIds?: number[]; jobIds?: number[]; status?: string; customerPublicId?: string; q?: string } = {}) {
    if ((f.companyIds && f.companyIds.length === 0 && (!f.jobIds || f.jobIds.length === 0))) return Promise.resolve([]);
    const reach = f.companyIds || f.jobIds
      ? or(f.companyIds?.length ? inArray(designJobs.legalEntityId, f.companyIds) : undefined, f.jobIds?.length ? inArray(designJobs.id, f.jobIds) : undefined)
      : undefined;
    return conn.select({
      id: designJobs.id, tenantId: designJobs.tenantId, publicId: designJobs.publicId, legalEntityId: designJobs.legalEntityId, company: legalEntities.code,
      companyName: legalEntities.name, departmentId: designJobs.departmentId, number: designJobs.number, customerId: designJobs.customerId,
      customerPublicId: customers.publicId, customerCode: customers.code, customerName: customers.name, customerLegalEntityId: customers.legalEntityId,
      clientProjectReference: designJobs.clientProjectReference, site: designJobs.site, scope: designJobs.scope, requirements: designJobs.requirements,
      dueDate: designJobs.dueDate, receivedFromName: designJobs.receivedFromName, receivedFromContact: designJobs.receivedFromContact,
      status: designJobs.status, holdReason: designJobs.holdReason, resumeStatus: designJobs.resumeStatus, cancelReason: designJobs.cancelReason,
      clientProjectPublicId: designJobs.clientProjectPublicId, createdBy: designJobs.createdBy, createdAt: designJobs.createdAt, updatedAt: designJobs.updatedAt,
      drawings: sql<number>`(SELECT count(*)::int FROM "design"."drawings" d WHERE d.job_id = "design_jobs"."id")`,
    }).from(designJobs)
      .innerJoin(legalEntities, eq(legalEntities.id, designJobs.legalEntityId))
      .innerJoin(customers, eq(customers.id, designJobs.customerId))
      .where(and(eq(designJobs.tenantId, tenantId), reach,
        f.id !== undefined ? eq(designJobs.id, f.id) : undefined,
        f.publicId ? eq(designJobs.publicId, f.publicId) : undefined,
        f.status ? eq(designJobs.status, f.status) : undefined,
        f.customerPublicId ? eq(customers.publicId, f.customerPublicId) : undefined,
        f.q ? or(ilike(designJobs.number, like(f.q)), ilike(designJobs.clientProjectReference, like(f.q)), ilike(designJobs.scope, like(f.q))) : undefined))
      .orderBy(desc(designJobs.createdAt), desc(designJobs.id));
  }

  /** The job's tenant, when the public id is taken (to tell a resend from someone else's id). */
  async jobTenant(conn: Conn, publicId: string): Promise<number | undefined> {
    const [j] = await conn.select({ tenantId: designJobs.tenantId }).from(designJobs).where(eq(designJobs.publicId, publicId));
    return j?.tenantId;
  }

  async lockJob(tx: Tx, id: number) {
    const [j] = await tx.select({ id: designJobs.id, status: designJobs.status, resumeStatus: designJobs.resumeStatus }).from(designJobs).where(eq(designJobs.id, id)).for('update');
    return j;
  }

  async insertJob(tx: Tx, v: typeof designJobs.$inferInsert): Promise<void> {
    await tx.insert(designJobs).values(v);
  }

  async updateJob(tx: Tx, id: number, v: Partial<typeof designJobs.$inferInsert>): Promise<void> {
    await tx.update(designJobs).set(v).where(eq(designJobs.id, id));
  }

  attachments(conn: Conn, jobId: number) {
    return conn.select({
      id: jobAttachments.id, publicId: jobAttachments.publicId, name: jobAttachments.name, description: jobAttachments.description, fileType: jobAttachments.fileType,
      sizeBytes: jobAttachments.sizeBytes, uploadedBy: jobAttachments.uploadedBy, uploadedAt: jobAttachments.uploadedAt,
    }).from(jobAttachments).where(eq(jobAttachments.jobId, jobId)).orderBy(asc(jobAttachments.id));
  }

  async attachment(conn: Conn, tenantId: number, publicId: string) {
    const [a] = await conn.select({ id: jobAttachments.id, jobId: jobAttachments.jobId, name: jobAttachments.name, filePath: jobAttachments.filePath, fileType: jobAttachments.fileType })
      .from(jobAttachments).where(and(eq(jobAttachments.tenantId, tenantId), eq(jobAttachments.publicId, publicId)));
    return a;
  }

  async countAttachments(tx: Tx, jobId: number): Promise<number> {
    const [r] = await tx.select({ n: count() }).from(jobAttachments).where(eq(jobAttachments.jobId, jobId));
    return Number(r.n);
  }

  async insertAttachment(tx: Tx, v: typeof jobAttachments.$inferInsert): Promise<void> {
    await tx.insert(jobAttachments).values(v);
  }

  // ---- tickets of a job ----

  async ticket(conn: Conn, tenantId: number, publicId: string) {
    const [t] = await conn.select({ id: tickets.id, publicId: tickets.publicId, number: tickets.number, title: tickets.title, status: tickets.status, legalEntityId: tickets.legalEntityId })
      .from(tickets).where(and(eq(tickets.tenantId, tenantId), eq(tickets.publicId, publicId)));
    return t;
  }

  async jobOfTicket(conn: Conn, ticketId: number): Promise<number | undefined> {
    const [r] = await conn.select({ jobId: jobTickets.jobId }).from(jobTickets).where(eq(jobTickets.ticketId, ticketId));
    return r?.jobId;
  }

  async insertJobTicket(tx: Tx, v: typeof jobTickets.$inferInsert): Promise<void> {
    await tx.insert(jobTickets).values(v);
  }

  jobTickets(conn: Conn, jobId: number) {
    const billedTo = alias(legalEntities, 'billed_to');
    return conn.select({
      ticketId: tickets.id, publicId: tickets.publicId, number: tickets.number, title: tickets.title, status: tickets.status, billable: icTicketBilling.billable, billableTo: billedTo.code,
      linkedBy: jobTickets.linkedBy, linkedAt: jobTickets.linkedAt,
    }).from(jobTickets)
      .innerJoin(tickets, eq(tickets.id, jobTickets.ticketId))
      .leftJoin(icTicketBilling, eq(icTicketBilling.ticketId, jobTickets.ticketId))
      .leftJoin(billedTo, eq(billedTo.id, icTicketBilling.billableToLegalEntityId))
      .where(eq(jobTickets.jobId, jobId)).orderBy(asc(tickets.number));
  }

  /** Ticket time of each of the job's tickets: allocations plus the heads' adjustments (minutes). */
  async ticketMinutes(conn: Conn, jobId: number): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const t of [ticketTimeAllocations, ticketTimeAdjustments]) {
      const rows = await conn.select({ ticketId: t.ticketId, minutes: sql<number>`coalesce(sum(${t.minutes}), 0)::int` }).from(t)
        .innerJoin(jobTickets, eq(jobTickets.ticketId, t.ticketId)).where(eq(jobTickets.jobId, jobId)).groupBy(t.ticketId);
      for (const r of rows) out.set(r.ticketId, (out.get(r.ticketId) ?? 0) + Number(r.minutes));
    }
    return out;
  }

  // ---- drawings ----

  drawings(conn: Conn, tenantId: number, f: { jobId?: number; publicId?: string; id?: number }) {
    return conn.select({
      id: drawings.id, publicId: drawings.publicId, legalEntityId: drawings.legalEntityId, jobId: drawings.jobId, jobPublicId: designJobs.publicId,
      jobNumber: designJobs.number, company: legalEntities.code, discipline: drawings.discipline, seq: drawings.seq, number: drawings.number, title: drawings.title,
      createdBy: drawings.createdBy, createdAt: drawings.createdAt,
    }).from(drawings)
      .innerJoin(designJobs, eq(designJobs.id, drawings.jobId))
      .innerJoin(legalEntities, eq(legalEntities.id, drawings.legalEntityId))
      .where(and(eq(drawings.tenantId, tenantId), f.jobId !== undefined ? eq(drawings.jobId, f.jobId) : undefined,
        f.publicId ? eq(drawings.publicId, f.publicId) : undefined, f.id !== undefined ? eq(drawings.id, f.id) : undefined))
      .orderBy(asc(drawings.discipline), asc(drawings.seq));
  }

  async drawingTenant(conn: Conn, publicId: string): Promise<number | undefined> {
    const [d] = await conn.select({ tenantId: drawings.tenantId }).from(drawings).where(eq(drawings.publicId, publicId));
    return d?.tenantId;
  }

  async lockDrawing(tx: Tx, id: number): Promise<void> {
    await tx.select({ id: drawings.id }).from(drawings).where(eq(drawings.id, id)).for('update');
  }

  async maxDrawingSeq(tx: Tx, jobId: number, discipline: string): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`coalesce(max(${drawings.seq}), 0)::int` }).from(drawings).where(and(eq(drawings.jobId, jobId), eq(drawings.discipline, discipline)));
    return Number(r.n);
  }

  async insertDrawing(tx: Tx, v: typeof drawings.$inferInsert): Promise<void> {
    await tx.insert(drawings).values(v);
  }

  async updateDrawing(tx: Tx, id: number, v: Partial<typeof drawings.$inferInsert>): Promise<void> {
    await tx.update(drawings).set(v).where(eq(drawings.id, id));
  }

  // ---- revisions ----

  revisions(conn: Conn, tenantId: number, f: { drawingIds?: number[]; publicId?: string; publicIds?: string[]; id?: number }) {
    if ((f.drawingIds && f.drawingIds.length === 0) || (f.publicIds && f.publicIds.length === 0)) return Promise.resolve([]);
    return conn.select({
      id: drawingRevisions.id, publicId: drawingRevisions.publicId, legalEntityId: drawingRevisions.legalEntityId, drawingId: drawingRevisions.drawingId,
      drawingPublicId: drawings.publicId, drawingNumber: drawings.number, discipline: drawings.discipline, jobId: drawings.jobId,
      seq: drawingRevisions.seq, stage: drawingRevisions.stage, code: drawingRevisions.code, title: drawingRevisions.title, changeNote: drawingRevisions.changeNote,
      clientProjectReference: drawingRevisions.clientProjectReference, drawnByPersonId: drawingRevisions.drawnByPersonId, scale: drawingRevisions.scale,
      sheet: drawingRevisions.sheet, status: drawingRevisions.status, createdBy: drawingRevisions.createdBy, createdAt: drawingRevisions.createdAt,
      submittedBy: drawingRevisions.submittedBy, submittedAt: drawingRevisions.submittedAt, supersededAt: drawingRevisions.supersededAt,
    }).from(drawingRevisions)
      .innerJoin(drawings, eq(drawings.id, drawingRevisions.drawingId))
      .where(and(eq(drawingRevisions.tenantId, tenantId),
        f.drawingIds ? inArray(drawingRevisions.drawingId, f.drawingIds) : undefined,
        f.publicId ? eq(drawingRevisions.publicId, f.publicId) : undefined,
        f.publicIds ? inArray(drawingRevisions.publicId, f.publicIds) : undefined,
        f.id !== undefined ? eq(drawingRevisions.id, f.id) : undefined))
      .orderBy(asc(drawingRevisions.drawingId), asc(drawingRevisions.seq));
  }

  /** The newest revision of each drawing. */
  latestRevisions(conn: Conn, drawingIds: number[]) {
    if (drawingIds.length === 0) return Promise.resolve([]);
    return conn.selectDistinctOn([drawingRevisions.drawingId], {
      drawingId: drawingRevisions.drawingId, publicId: drawingRevisions.publicId, code: drawingRevisions.code, stage: drawingRevisions.stage, status: drawingRevisions.status,
    }).from(drawingRevisions).where(inArray(drawingRevisions.drawingId, drawingIds)).orderBy(drawingRevisions.drawingId, desc(drawingRevisions.seq));
  }

  async revisionTenant(conn: Conn, publicId: string): Promise<number | undefined> {
    const [r] = await conn.select({ tenantId: drawingRevisions.tenantId }).from(drawingRevisions).where(eq(drawingRevisions.publicId, publicId));
    return r?.tenantId;
  }

  async lockRevision(tx: Tx, id: number): Promise<{ status: string } | undefined> {
    const [r] = await tx.select({ status: drawingRevisions.status }).from(drawingRevisions).where(eq(drawingRevisions.id, id)).for('update');
    return r;
  }

  async insertRevision(tx: Tx, v: typeof drawingRevisions.$inferInsert): Promise<void> {
    await tx.insert(drawingRevisions).values(v);
  }

  async updateRevision(tx: Tx, id: number, v: Partial<typeof drawingRevisions.$inferInsert>): Promise<void> {
    await tx.update(drawingRevisions).set(v).where(eq(drawingRevisions.id, id));
  }

  /** The drawing's earlier revisions a newly issued one supersedes. */
  async supersedeEarlier(tx: Tx, drawingId: number, belowSeq: number, statuses: string[], at: Date): Promise<number> {
    const rows = await tx.update(drawingRevisions).set({ status: 'superseded', supersededAt: at })
      .where(and(eq(drawingRevisions.drawingId, drawingId), lt(drawingRevisions.seq, belowSeq), inArray(drawingRevisions.status, statuses)))
      .returning({ id: drawingRevisions.id });
    return rows.length;
  }

  /** Whether the drawing has a revision after this one that has gone to the client. */
  async laterIssued(conn: Conn, drawingId: number, afterSeq: number, statuses: string[]): Promise<boolean> {
    const [r] = await conn.select({ id: drawingRevisions.id }).from(drawingRevisions)
      .where(and(eq(drawingRevisions.drawingId, drawingId), sql`${drawingRevisions.seq} > ${afterSeq}`, inArray(drawingRevisions.status, statuses))).limit(1);
    return r !== undefined;
  }

  // ---- revision files ----

  files(conn: Conn, revisionIds: number[]) {
    if (revisionIds.length === 0) return Promise.resolve([]);
    return conn.select({
      id: revisionFiles.id, publicId: revisionFiles.publicId, revisionId: revisionFiles.revisionId, kind: revisionFiles.kind, name: revisionFiles.name,
      filePath: revisionFiles.filePath, fileType: revisionFiles.fileType, sizeBytes: revisionFiles.sizeBytes, uploadedBy: revisionFiles.uploadedBy, uploadedAt: revisionFiles.uploadedAt,
    }).from(revisionFiles).where(and(inArray(revisionFiles.revisionId, revisionIds), isNull(revisionFiles.removedAt))).orderBy(asc(revisionFiles.id));
  }

  async file(conn: Conn, tenantId: number, publicId: string) {
    const [f] = await conn.select({ id: revisionFiles.id, revisionId: revisionFiles.revisionId, kind: revisionFiles.kind, name: revisionFiles.name,
      filePath: revisionFiles.filePath, fileType: revisionFiles.fileType, removedAt: revisionFiles.removedAt })
      .from(revisionFiles).where(and(eq(revisionFiles.tenantId, tenantId), eq(revisionFiles.publicId, publicId)));
    return f;
  }

  async fileTenant(conn: Conn, publicId: string): Promise<number | undefined> {
    const [f] = await conn.select({ tenantId: revisionFiles.tenantId }).from(revisionFiles).where(eq(revisionFiles.publicId, publicId));
    return f?.tenantId;
  }

  /** How many files of this kind the revision has had (removed ones too), to number the next one's name. */
  async countFiles(tx: Tx, revisionId: number, kind: string): Promise<number> {
    const [r] = await tx.select({ n: count() }).from(revisionFiles).where(and(eq(revisionFiles.revisionId, revisionId), eq(revisionFiles.kind, kind)));
    return Number(r.n);
  }

  async currentPdf(tx: Tx, revisionId: number): Promise<{ id: number } | undefined> {
    const [f] = await tx.select({ id: revisionFiles.id }).from(revisionFiles)
      .where(and(eq(revisionFiles.revisionId, revisionId), eq(revisionFiles.kind, 'pdf'), isNull(revisionFiles.removedAt)));
    return f;
  }

  async insertFile(tx: Tx, v: typeof revisionFiles.$inferInsert): Promise<void> {
    await tx.insert(revisionFiles).values(v);
  }

  async removeFile(tx: Tx, id: number, by: number): Promise<void> {
    await tx.update(revisionFiles).set({ removedBy: by, removedAt: new Date() }).where(eq(revisionFiles.id, id));
  }

  // ---- QC ----

  qcReviews(conn: Conn, revisionIds: number[]) {
    if (revisionIds.length === 0) return Promise.resolve([]);
    return conn.select({ id: qcReviews.id, publicId: qcReviews.publicId, revisionId: qcReviews.revisionId, reviewerPersonId: qcReviews.reviewerPersonId,
      decision: qcReviews.decision, comments: qcReviews.comments, checklist: qcReviews.checklist, decidedAt: qcReviews.decidedAt })
      .from(qcReviews).where(inArray(qcReviews.revisionId, revisionIds));
  }

  qcFiles(conn: Conn, reviewIds: number[]) {
    if (reviewIds.length === 0) return Promise.resolve([]);
    return conn.select({ publicId: qcReviewFiles.publicId, reviewId: qcReviewFiles.reviewId, name: qcReviewFiles.name, fileType: qcReviewFiles.fileType })
      .from(qcReviewFiles).where(inArray(qcReviewFiles.reviewId, reviewIds)).orderBy(asc(qcReviewFiles.id));
  }

  async qcFile(conn: Conn, tenantId: number, publicId: string) {
    const [f] = await conn.select({ name: qcReviewFiles.name, filePath: qcReviewFiles.filePath, fileType: qcReviewFiles.fileType, revisionId: qcReviews.revisionId })
      .from(qcReviewFiles).innerJoin(qcReviews, eq(qcReviews.id, qcReviewFiles.reviewId))
      .where(and(eq(qcReviewFiles.tenantId, tenantId), eq(qcReviewFiles.publicId, publicId)));
    return f;
  }

  async qcOfPublicId(conn: Conn, publicId: string): Promise<{ tenantId: number; revisionId: number } | undefined> {
    const [r] = await conn.select({ tenantId: qcReviews.tenantId, revisionId: qcReviews.revisionId }).from(qcReviews).where(eq(qcReviews.publicId, publicId));
    return r;
  }

  async insertQc(tx: Tx, v: typeof qcReviews.$inferInsert): Promise<number> {
    const [r] = await tx.insert(qcReviews).values(v).returning({ id: qcReviews.id });
    return r.id;
  }

  async insertQcFile(tx: Tx, v: typeof qcReviewFiles.$inferInsert): Promise<void> {
    await tx.insert(qcReviewFiles).values(v);
  }

  // ---- transmittals and responses ----

  /** Where each revision was issued. */
  issuedIn(conn: Conn, revisionIds: number[]) {
    if (revisionIds.length === 0) return Promise.resolve([]);
    return conn.select({ revisionId: transmittalItems.revisionId, publicId: transmittals.publicId, number: transmittals.number, purpose: transmittals.purpose, issuedAt: transmittals.issuedAt })
      .from(transmittalItems).innerJoin(transmittals, eq(transmittals.id, transmittalItems.transmittalId))
      .where(inArray(transmittalItems.revisionId, revisionIds));
  }

  responses(conn: Conn, revisionIds: number[]) {
    if (revisionIds.length === 0) return Promise.resolve([]);
    return conn.select({ revisionId: clientResponses.revisionId, response: clientResponses.response, comments: clientResponses.comments, respondedOn: clientResponses.respondedOn,
      responderName: clientResponses.responderName, recordedBy: clientResponses.recordedBy, recordedAt: clientResponses.recordedAt })
      .from(clientResponses).where(inArray(clientResponses.revisionId, revisionIds));
  }

  async insertResponse(tx: Tx, v: typeof clientResponses.$inferInsert): Promise<void> {
    await tx.insert(clientResponses).values(v);
  }

  transmittals(conn: Conn, tenantId: number, f: { publicId?: string; jobId?: number; companyIds?: number[]; jobIds?: number[] }) {
    if (f.companyIds && f.companyIds.length === 0 && (!f.jobIds || f.jobIds.length === 0)) return Promise.resolve([]);
    const reach = f.companyIds || f.jobIds
      ? or(f.companyIds?.length ? inArray(transmittals.legalEntityId, f.companyIds) : undefined, f.jobIds?.length ? inArray(transmittals.jobId, f.jobIds) : undefined)
      : undefined;
    return conn.select({
      id: transmittals.id, publicId: transmittals.publicId, legalEntityId: transmittals.legalEntityId, company: legalEntities.code, companyName: legalEntities.name,
      jobId: transmittals.jobId, jobPublicId: designJobs.publicId, jobNumber: designJobs.number, clientProjectReference: designJobs.clientProjectReference,
      customerPublicId: customers.publicId, customerCode: customers.code, customerName: customers.name,
      number: transmittals.number, purpose: transmittals.purpose, recipient: transmittals.recipient, note: transmittals.note, issuedBy: transmittals.issuedBy, issuedAt: transmittals.issuedAt,
      revisions: sql<number>`(SELECT count(*)::int FROM "design"."transmittal_items" i WHERE i.transmittal_id = "transmittals"."id")`,
    }).from(transmittals)
      .innerJoin(designJobs, eq(designJobs.id, transmittals.jobId))
      .innerJoin(customers, eq(customers.id, designJobs.customerId))
      .innerJoin(legalEntities, eq(legalEntities.id, transmittals.legalEntityId))
      .where(and(eq(transmittals.tenantId, tenantId), reach, f.publicId ? eq(transmittals.publicId, f.publicId) : undefined,
        f.jobId !== undefined ? eq(transmittals.jobId, f.jobId) : undefined))
      .orderBy(desc(transmittals.issuedAt), desc(transmittals.id));
  }

  async transmittalTenant(conn: Conn, publicId: string): Promise<number | undefined> {
    const [t] = await conn.select({ tenantId: transmittals.tenantId }).from(transmittals).where(eq(transmittals.publicId, publicId));
    return t?.tenantId;
  }

  /** The revisions a transmittal issued, in drawing order, with each revision's current PDF. */
  transmittalItems(conn: Conn, transmittalId: number) {
    return conn.select({
      revisionId: drawingRevisions.id, revisionPublicId: drawingRevisions.publicId, drawingPublicId: drawings.publicId, drawingNumber: drawings.number,
      title: drawingRevisions.title, code: drawingRevisions.code, discipline: drawings.discipline, sheet: drawingRevisions.sheet, scale: drawingRevisions.scale,
      status: drawingRevisions.status,
    }).from(transmittalItems)
      .innerJoin(drawingRevisions, eq(drawingRevisions.id, transmittalItems.revisionId))
      .innerJoin(drawings, eq(drawings.id, drawingRevisions.drawingId))
      .where(eq(transmittalItems.transmittalId, transmittalId)).orderBy(asc(drawings.number));
  }

  async insertTransmittal(tx: Tx, v: typeof transmittals.$inferInsert): Promise<number> {
    const [r] = await tx.insert(transmittals).values(v).returning({ id: transmittals.id });
    return r.id;
  }

  async insertTransmittalItems(tx: Tx, v: (typeof transmittalItems.$inferInsert)[]): Promise<void> {
    await tx.insert(transmittalItems).values(v);
  }
}
