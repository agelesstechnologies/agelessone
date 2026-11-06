import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, gte, inArray, isNull, lt, lte, or, sql, SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { departments, employments } from '../../hrms/people/schema';
import { leaveRequests } from '../../hrms/leave/schema';
import { personSkills, skills } from '../../hrms/skills/schema';
import {
  numberSeries, reassignRequests, ticketAssignees, ticketAttachments, ticketChecklistResults, ticketEvents, ticketLinks, tickets,
  ticketSignoffs, ticketTypes,
} from '../schema';

export type TicketRow = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;

const supervisor = alias(persons, 'supervisor');
const primaryA = alias(ticketAssignees, 'primary_assignee');
const primaryJob = alias(employments, 'primary_job');
const primaryPerson = alias(persons, 'primary_person');
const assigner = alias(persons, 'assigner');
const actor = alias(persons, 'actor');
const other = alias(tickets, 'other_ticket');
const requester = alias(persons, 'requester');
const approver = alias(persons, 'approver');
const decider = alias(persons, 'decider');
const newJob = alias(employments, 'new_job');
const newPerson = alias(persons, 'new_person');

/** Who may see which tickets in a list: everything, or the caller's own / team's. */
export type Visibility = { all: true } | { all: false; personId: number; team: boolean; headedDepartmentIds: number[] };

export interface ListFilters {
  company?: string; typePublicId?: string; status?: string; departmentPublicId?: string; assignee?: string; customer?: string;
  priority?: number; overdueBefore?: string; from?: Date; to?: Date; limit: number; offset: number;
}

/** Writes only tickets.*; reads companies, people, departments, jobs, approved leave and skills. */
@Injectable()
export class TicketsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- lookups in other modules' tables (read only) ----

  async findCompany(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: legalEntities.id, code: legalEntities.code }).from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row;
  }

  async findDepartment(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: departments.id, legalEntityId: departments.legalEntityId, headPersonId: departments.headPersonId })
      .from(departments).where(and(eq(departments.tenantId, tenantId), eq(departments.publicId, publicId)));
    return row;
  }

  async departmentHead(conn: Conn, departmentId: number | null): Promise<number | null> {
    if (departmentId === null) return null;
    const [row] = await conn.select({ head: departments.headPersonId }).from(departments).where(eq(departments.id, departmentId));
    return row?.head ?? null;
  }

  async departmentsHeadedBy(tenantId: number, personId: number): Promise<number[]> {
    const rows = await this.db.select({ id: departments.id }).from(departments)
      .where(and(eq(departments.tenantId, tenantId), eq(departments.headPersonId, personId)));
    return rows.map((r) => r.id);
  }

  async findPerson(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: persons.id }).from(persons).where(and(eq(persons.tenantId, tenantId), eq(persons.publicId, publicId)));
    return row;
  }

  async existingPersons(tenantId: number, publicIds: string[]): Promise<Set<string>> {
    if (publicIds.length === 0) return new Set();
    const rows = await this.db.select({ p: persons.publicId }).from(persons).where(and(eq(persons.tenantId, tenantId), inArray(persons.publicId, publicIds)));
    return new Set(rows.map((r) => r.p));
  }

  async findSkill(tenantId: number, publicId: string) {
    const [row] = await this.db.select({ id: skills.id, legalEntityId: skills.legalEntityId }).from(skills)
      .where(and(eq(skills.tenantId, tenantId), eq(skills.publicId, publicId)));
    return row;
  }

  async personRefs(conn: Conn, ids: number[]): Promise<Map<number, { publicId: string; displayName: string }>> {
    if (ids.length === 0) return new Map();
    const rows = await conn.select({ id: persons.id, publicId: persons.publicId, displayName: persons.displayName }).from(persons).where(inArray(persons.id, ids));
    return new Map(rows.map((r) => [r.id, { publicId: r.publicId, displayName: r.displayName }]));
  }

  async skillRef(conn: Conn, id: number): Promise<{ publicId: string; name: string }> {
    const [row] = await conn.select({ publicId: skills.publicId, name: skills.name }).from(skills).where(eq(skills.id, id));
    return row;
  }

  async hasSkill(personId: number, skillId: number): Promise<boolean> {
    const [row] = await this.db.select({ id: personSkills.id }).from(personSkills).where(and(eq(personSkills.personId, personId), eq(personSkills.skillId, skillId)));
    return row !== undefined;
  }

  async findEmployment(conn: Conn, tenantId: number, publicId: string) {
    const [row] = await conn.select({
      id: employments.id, publicId: employments.publicId, personId: employments.personId, legalEntityId: employments.legalEntityId,
      status: employments.status, managerPersonId: employments.managerPersonId, departmentId: employments.departmentId,
    }).from(employments).where(and(eq(employments.tenantId, tenantId), eq(employments.publicId, publicId)));
    return row;
  }

  async employmentById(conn: Conn, id: number) {
    const [row] = await conn.select({
      id: employments.id, publicId: employments.publicId, personId: employments.personId, legalEntityId: employments.legalEntityId,
      status: employments.status, managerPersonId: employments.managerPersonId, departmentId: employments.departmentId,
    }).from(employments).where(eq(employments.id, id));
    return row;
  }

  /** The person's active job in the company, if any. */
  async activeJob(conn: Conn, personId: number, legalEntityId: number) {
    const [row] = await conn.select({ id: employments.id, publicId: employments.publicId }).from(employments)
      .where(and(eq(employments.personId, personId), eq(employments.legalEntityId, legalEntityId), eq(employments.status, 'active')));
    return row;
  }

  /** Approved leave of the job covering the date (any part of the day). */
  async onApprovedLeave(employmentId: number, date: string): Promise<boolean> {
    const [row] = await this.db.select({ id: leaveRequests.id }).from(leaveRequests).where(and(eq(leaveRequests.employmentId, employmentId),
      eq(leaveRequests.status, 'approved'), lte(leaveRequests.fromDate, date), gte(leaveRequests.toDate, date))).limit(1);
    return row !== undefined;
  }

  // ---- number series ----

  /** The company's series, locked until the transaction ends (made with the default prefix the first time). */
  async lockSeries(tx: Tx, tenantId: number, legalEntityId: number, defaultPrefix: string) {
    await tx.insert(numberSeries).values({ tenantId, legalEntityId, prefix: defaultPrefix }).onConflictDoNothing();
    const [row] = await tx.select().from(numberSeries).where(eq(numberSeries.legalEntityId, legalEntityId)).for('update');
    return row;
  }

  async numberTaken(conn: Conn, legalEntityId: number, number: string): Promise<boolean> {
    const [row] = await conn.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.legalEntityId, legalEntityId), eq(tickets.number, number)));
    return row !== undefined;
  }

  async setNextNumber(tx: Tx, id: number, nextNumber: number): Promise<void> {
    await tx.update(numberSeries).set({ nextNumber }).where(eq(numberSeries.id, id));
  }

  async saveSeries(tenantId: number, legalEntityId: number, prefix: string, nextNumber: number, by: number): Promise<void> {
    await this.db.insert(numberSeries).values({ tenantId, legalEntityId, prefix, nextNumber, updatedBy: by })
      .onConflictDoUpdate({ target: numberSeries.legalEntityId, set: { prefix, nextNumber, updatedBy: by, updatedAt: new Date() } });
  }

  async series(tenantId: number) {
    return this.db.select({ company: legalEntities.code, legalEntityId: legalEntities.id, prefix: numberSeries.prefix, nextNumber: numberSeries.nextNumber })
      .from(legalEntities).leftJoin(numberSeries, eq(numberSeries.legalEntityId, legalEntities.id))
      .where(eq(legalEntities.tenantId, tenantId)).orderBy(asc(legalEntities.code));
  }

  // ---- tickets ----

  async insertTicket(tx: Tx, v: NewTicket): Promise<{ id: number; publicId: string }> {
    const [row] = await tx.insert(tickets).values(v).returning({ id: tickets.id, publicId: tickets.publicId });
    return row;
  }

  async tenantOfTicket(publicId: string): Promise<number | undefined> {
    const [row] = await this.db.select({ tenantId: tickets.tenantId }).from(tickets).where(eq(tickets.publicId, publicId));
    return row?.tenantId;
  }

  async findTicket(conn: Conn, tenantId: number, publicId: string, lock = false): Promise<TicketRow | undefined> {
    const q = conn.select().from(tickets).where(and(eq(tickets.tenantId, tenantId), eq(tickets.publicId, publicId)));
    const [row] = lock ? await q.for('update') : await q;
    return row;
  }

  async ticketById(conn: Conn, id: number): Promise<TicketRow> {
    const [row] = await conn.select().from(tickets).where(eq(tickets.id, id));
    return row;
  }

  async updateTicket(tx: Tx, id: number, patch: Partial<NewTicket>): Promise<void> {
    await tx.update(tickets).set(patch).where(eq(tickets.id, id));
  }

  /** The exact type version a ticket uses. */
  async typeVersion(conn: Conn, typeId: number) {
    const [row] = await conn.select({ id: ticketTypes.id, publicId: ticketTypes.publicId, version: ticketTypes.version, code: ticketTypes.code,
      name: ticketTypes.name, fields: ticketTypes.fields, completionRules: ticketTypes.completionRules, checklistItems: ticketTypes.checklistItems })
      .from(ticketTypes).where(eq(ticketTypes.id, typeId));
    return row;
  }

  private summarySelect(conn: Conn) {
    return conn.select({
      id: tickets.id, publicId: tickets.publicId, number: tickets.number, company: legalEntities.code, title: tickets.title, priority: tickets.priority,
      status: tickets.status, customerId: tickets.customerId, site: tickets.site, scheduledAt: tickets.scheduledAt, dueDate: tickets.dueDate,
      completedAt: tickets.completedAt, createdAt: tickets.createdAt,
      typePublicId: ticketTypes.publicId, typeVersion: ticketTypes.version, typeCode: ticketTypes.code, typeName: ticketTypes.name,
      departmentPublicId: departments.publicId, departmentName: departments.name,
      supervisorPublicId: supervisor.publicId, supervisorName: supervisor.displayName,
      primaryJobPublicId: primaryJob.publicId, primaryCode: primaryJob.employeeCode, primaryPersonPublicId: primaryPerson.publicId,
      primaryName: primaryPerson.displayName, primaryAssignedAt: primaryA.assignedAt, primaryAssignerPublicId: assigner.publicId, primaryAssignerName: assigner.displayName,
    }).from(tickets)
      .innerJoin(legalEntities, eq(legalEntities.id, tickets.legalEntityId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, tickets.typeId))
      .innerJoin(departments, eq(departments.id, tickets.departmentId))
      .innerJoin(supervisor, eq(supervisor.id, tickets.supervisorPersonId))
      .leftJoin(primaryA, and(eq(primaryA.ticketId, tickets.id), eq(primaryA.isPrimary, true), isNull(primaryA.endedAt)))
      .leftJoin(primaryJob, eq(primaryJob.id, primaryA.employmentId))
      .leftJoin(primaryPerson, eq(primaryPerson.id, primaryJob.personId))
      .leftJoin(assigner, eq(assigner.id, primaryA.assignedBy));
  }

  /** A current assignee who is this person (as a condition on tickets). */
  private assignedTo(personId: number): SQL {
    return exists(this.db.select({ one: sql`1` }).from(ticketAssignees).innerJoin(employments, eq(employments.id, ticketAssignees.employmentId))
      .where(and(eq(ticketAssignees.ticketId, tickets.id), isNull(ticketAssignees.endedAt), eq(employments.personId, personId))));
  }

  async list(tenantId: number, f: ListFilters, who: Visibility) {
    const conds: (SQL | undefined)[] = [eq(tickets.tenantId, tenantId)];
    if (!who.all) {
      const mine = [this.assignedTo(who.personId)];
      if (who.team) {
        mine.push(eq(tickets.supervisorPersonId, who.personId));
        if (who.headedDepartmentIds.length) mine.push(inArray(tickets.departmentId, who.headedDepartmentIds));
      }
      conds.push(or(...mine));
    }
    if (f.company) conds.push(eq(legalEntities.code, f.company));
    if (f.typePublicId) conds.push(eq(ticketTypes.publicId, f.typePublicId));
    if (f.status) conds.push(eq(tickets.status, f.status));
    if (f.departmentPublicId) conds.push(eq(departments.publicId, f.departmentPublicId));
    if (f.customer) conds.push(eq(tickets.customerId, f.customer));
    if (f.priority) conds.push(eq(tickets.priority, f.priority));
    if (f.overdueBefore) conds.push(lt(tickets.dueDate, f.overdueBefore), inArray(tickets.status, ['open', 'assigned', 'in_progress', 'on_hold']));
    if (f.from) conds.push(gte(tickets.scheduledAt, f.from));
    if (f.to) conds.push(lt(tickets.scheduledAt, f.to));
    if (f.assignee) {
      const a = alias(ticketAssignees, 'filter_assignee');
      const j = alias(employments, 'filter_job');
      const p = alias(persons, 'filter_person');
      conds.push(exists(this.db.select({ one: sql`1` }).from(a).innerJoin(j, eq(j.id, a.employmentId)).innerJoin(p, eq(p.id, j.personId))
        .where(and(eq(a.ticketId, tickets.id), isNull(a.endedAt), or(eq(j.publicId, f.assignee), eq(p.publicId, f.assignee))))));
    }
    return this.summarySelect(this.db).where(and(...conds))
      .orderBy(asc(tickets.scheduledAt), asc(tickets.id)).limit(f.limit).offset(f.offset);
  }

  async summary(conn: Conn, ticketId: number) {
    const [row] = await this.summarySelect(conn).where(eq(tickets.id, ticketId));
    return row;
  }

  // ---- assignees ----

  async currentAssignees(conn: Conn, ticketId: number) {
    return conn.select({
      id: ticketAssignees.id, employmentId: ticketAssignees.employmentId, isPrimary: ticketAssignees.isPrimary, assignedAt: ticketAssignees.assignedAt,
      employmentPublicId: employments.publicId, employeeCode: employments.employeeCode, employmentStatus: employments.status,
      personId: persons.id, personPublicId: persons.publicId, personName: persons.displayName,
      assignerPublicId: assigner.publicId, assignerName: assigner.displayName,
    }).from(ticketAssignees)
      .innerJoin(employments, eq(employments.id, ticketAssignees.employmentId))
      .innerJoin(persons, eq(persons.id, employments.personId))
      .innerJoin(assigner, eq(assigner.id, ticketAssignees.assignedBy))
      .where(and(eq(ticketAssignees.ticketId, ticketId), isNull(ticketAssignees.endedAt)))
      .orderBy(desc(ticketAssignees.isPrimary), asc(ticketAssignees.id));
  }

  async insertAssignee(tx: Tx, v: typeof ticketAssignees.$inferInsert): Promise<void> {
    await tx.insert(ticketAssignees).values(v);
  }

  async endAssignee(tx: Tx, id: number, by: number): Promise<void> {
    await tx.update(ticketAssignees).set({ endedAt: new Date(), endedBy: by, isPrimary: false }).where(eq(ticketAssignees.id, id));
  }

  async setPrimary(tx: Tx, id: number, isPrimary: boolean): Promise<void> {
    await tx.update(ticketAssignees).set({ isPrimary }).where(eq(ticketAssignees.id, id));
  }

  // ---- work on the ticket ----

  async insertChecklist(tx: Tx, v: typeof ticketChecklistResults.$inferInsert): Promise<void> {
    await tx.insert(ticketChecklistResults).values(v);
  }

  /** The newest answer per checklist item. */
  async latestChecklist(conn: Conn, ticketId: number) {
    const rows = await conn.select({ item: ticketChecklistResults.item, result: ticketChecklistResults.result, note: ticketChecklistResults.note,
      checkedAt: ticketChecklistResults.checkedAt, byPublicId: persons.publicId, byName: persons.displayName })
      .from(ticketChecklistResults).innerJoin(persons, eq(persons.id, ticketChecklistResults.checkedBy))
      .where(eq(ticketChecklistResults.ticketId, ticketId)).orderBy(asc(ticketChecklistResults.id));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) latest.set(r.item, r);
    return latest;
  }

  async insertAttachment(tx: Tx, v: typeof ticketAttachments.$inferInsert): Promise<{ id: number; publicId: string }> {
    const [row] = await tx.insert(ticketAttachments).values(v).returning({ id: ticketAttachments.id, publicId: ticketAttachments.publicId });
    return row;
  }

  async attachments(conn: Conn, ticketId: number) {
    return conn.select({ publicId: ticketAttachments.publicId, kind: ticketAttachments.kind, fileType: ticketAttachments.fileType,
      filePath: ticketAttachments.filePath, uploadedAt: ticketAttachments.uploadedAt, byPublicId: persons.publicId, byName: persons.displayName })
      .from(ticketAttachments).innerJoin(persons, eq(persons.id, ticketAttachments.uploadedBy))
      .where(eq(ticketAttachments.ticketId, ticketId)).orderBy(asc(ticketAttachments.id));
  }

  async insertSignoff(tx: Tx, v: typeof ticketSignoffs.$inferInsert): Promise<void> {
    await tx.insert(ticketSignoffs).values(v);
  }

  async signoffs(conn: Conn, ticketId: number) {
    return conn.select({ publicId: ticketSignoffs.publicId, signerName: ticketSignoffs.signerName, signerRole: ticketSignoffs.signerRole,
      signedAt: ticketSignoffs.signedAt, photoPublicId: ticketAttachments.publicId, byPublicId: persons.publicId, byName: persons.displayName })
      .from(ticketSignoffs)
      .innerJoin(ticketAttachments, eq(ticketAttachments.id, ticketSignoffs.photoAttachmentId))
      .innerJoin(persons, eq(persons.id, ticketSignoffs.recordedBy))
      .where(eq(ticketSignoffs.ticketId, ticketId)).orderBy(asc(ticketSignoffs.id));
  }

  async insertLink(tx: Tx, v: typeof ticketLinks.$inferInsert): Promise<void> {
    await tx.insert(ticketLinks).values(v);
  }

  /** Links in both directions, with the other ticket. */
  async links(conn: Conn, ticketId: number) {
    const select = (direction: 'to' | 'from') => conn.select({ kind: ticketLinks.kind, publicId: other.publicId, number: other.number,
      title: other.title, status: other.status, otherId: other.id, typeCode: ticketTypes.code, createdAt: ticketLinks.createdAt })
      .from(ticketLinks)
      .innerJoin(other, eq(other.id, direction === 'to' ? ticketLinks.toTicketId : ticketLinks.fromTicketId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, other.typeId))
      .where(eq(direction === 'to' ? ticketLinks.fromTicketId : ticketLinks.toTicketId, ticketId))
      .orderBy(asc(ticketLinks.id));
    const [to, from] = await Promise.all([select('to'), select('from')]);
    return [...to.map((l) => ({ ...l, direction: 'to' as const })), ...from.map((l) => ({ ...l, direction: 'from' as const }))];
  }

  async insertEvent(tx: Tx, v: typeof ticketEvents.$inferInsert): Promise<void> {
    await tx.insert(ticketEvents).values(v);
  }

  async events(conn: Conn, ticketId: number) {
    return conn.select({ action: ticketEvents.action, details: ticketEvents.details, at: ticketEvents.at, actorPublicId: actor.publicId, actorName: actor.displayName })
      .from(ticketEvents).leftJoin(actor, eq(actor.id, ticketEvents.actorPersonId))
      .where(eq(ticketEvents.ticketId, ticketId)).orderBy(asc(ticketEvents.id));
  }

  async countEvents(conn: Conn, ticketId: number, action: string): Promise<number> {
    const [row] = await conn.select({ n: sql<number>`count(*)::int` }).from(ticketEvents)
      .where(and(eq(ticketEvents.ticketId, ticketId), eq(ticketEvents.action, action)));
    return row.n;
  }

  // ---- reassignment ----

  async insertReassign(tx: Tx, v: typeof reassignRequests.$inferInsert): Promise<string> {
    const [row] = await tx.insert(reassignRequests).values(v).returning({ publicId: reassignRequests.publicId });
    return row.publicId;
  }

  async findReassign(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select().from(reassignRequests)
      .where(and(eq(reassignRequests.tenantId, tenantId), eq(reassignRequests.publicId, publicId))).for('update');
    return row;
  }

  async decideReassign(tx: Tx, id: number, patch: Partial<typeof reassignRequests.$inferInsert>): Promise<void> {
    await tx.update(reassignRequests).set(patch).where(eq(reassignRequests.id, id));
  }

  /** Requests of one ticket, or the ones a person decides (any approver: personId null). */
  async reassignRequests(conn: Conn, tenantId: number, by: { ticketId?: number; approverId?: number | null; status?: string }) {
    return conn.select({
      publicId: reassignRequests.publicId, ticketPublicId: tickets.publicId, ticketNumber: tickets.number, reason: reassignRequests.reason,
      status: reassignRequests.status, decidedAs: reassignRequests.decidedAs, decidedAt: reassignRequests.decidedAt,
      decisionReason: reassignRequests.decisionReason, createdAt: reassignRequests.createdAt,
      requesterPublicId: requester.publicId, requesterName: requester.displayName, approverPublicId: approver.publicId, approverName: approver.displayName,
      deciderPublicId: decider.publicId, deciderName: decider.displayName, newPublicId: newPerson.publicId, newName: newPerson.displayName,
    }).from(reassignRequests)
      .innerJoin(tickets, eq(tickets.id, reassignRequests.ticketId))
      .innerJoin(requester, eq(requester.id, reassignRequests.requestedBy))
      .leftJoin(approver, eq(approver.id, reassignRequests.approverPersonId))
      .leftJoin(decider, eq(decider.id, reassignRequests.decidedBy))
      .leftJoin(newJob, eq(newJob.id, reassignRequests.newEmploymentId))
      .leftJoin(newPerson, eq(newPerson.id, newJob.personId))
      .where(and(eq(reassignRequests.tenantId, tenantId),
        by.ticketId === undefined ? undefined : eq(reassignRequests.ticketId, by.ticketId),
        by.approverId ? eq(reassignRequests.approverPersonId, by.approverId) : undefined,
        by.status ? eq(reassignRequests.status, by.status) : undefined))
      .orderBy(desc(reassignRequests.id));
  }
}
