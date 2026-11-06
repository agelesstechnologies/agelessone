import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, sql } from 'drizzle-orm';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { departments } from '../../hrms/people/schema';
import { ticketTypes } from '../schema';

const creator = aliasedTable(persons, 'creator');

/** One saved version of a type, with the names the API shows. */
export interface TypeRow {
  id: number; publicId: string; version: number; isCurrent: boolean; tenantId: number; legalEntityId: number; company: string;
  code: string; name: string; ownerDepartmentId: number | null; departmentPublicId: string | null; departmentName: string | null;
  isStandard: boolean; active: boolean; sortOrder: number; fields: unknown; completionRules: unknown; checklistItems: unknown;
  createdByPublicId: string; createdByName: string; createdAt: Date;
}

export interface TypeValues {
  tenantId: number; publicId: string; version: number; legalEntityId: number; code: string; name: string; ownerDepartmentId: number | null;
  isStandard: boolean; active: boolean; sortOrder: number; fields: unknown; completionRules: unknown; checklistItems: unknown; createdBy: number;
}

/** Writes only tickets.ticket_types; reads companies, departments and people. */
@Injectable()
export class TicketTypesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private select(conn: Conn) {
    return conn.select({
      id: ticketTypes.id, publicId: ticketTypes.publicId, version: ticketTypes.version, isCurrent: ticketTypes.isCurrent, tenantId: ticketTypes.tenantId,
      legalEntityId: ticketTypes.legalEntityId, company: legalEntities.code, code: ticketTypes.code, name: ticketTypes.name,
      ownerDepartmentId: ticketTypes.ownerDepartmentId, departmentPublicId: departments.publicId, departmentName: departments.name,
      isStandard: ticketTypes.isStandard, active: ticketTypes.active, sortOrder: ticketTypes.sortOrder, fields: ticketTypes.fields,
      completionRules: ticketTypes.completionRules, checklistItems: ticketTypes.checklistItems,
      createdByPublicId: creator.publicId, createdByName: creator.displayName, createdAt: ticketTypes.createdAt,
    }).from(ticketTypes)
      .innerJoin(legalEntities, eq(legalEntities.id, ticketTypes.legalEntityId))
      .innerJoin(creator, eq(creator.id, ticketTypes.createdBy))
      .leftJoin(departments, eq(departments.id, ticketTypes.ownerDepartmentId));
  }

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

  async departmentHead(conn: Conn, departmentId: number): Promise<number | null> {
    const [row] = await conn.select({ head: departments.headPersonId }).from(departments).where(eq(departments.id, departmentId));
    return row?.head ?? null;
  }

  /** The tenant that already uses this type id (any version), if any. */
  async tenantOf(publicId: string): Promise<number | undefined> {
    const [row] = await this.db.select({ tenantId: ticketTypes.tenantId }).from(ticketTypes).where(eq(ticketTypes.publicId, publicId)).limit(1);
    return row?.tenantId;
  }

  /** Current versions, by company, sort order, then name. */
  list(tenantId: number, q: { active?: boolean; departmentId?: number; company?: string }): Promise<TypeRow[]> {
    return this.select(this.db).where(and(
      eq(ticketTypes.tenantId, tenantId), eq(ticketTypes.isCurrent, true),
      q.active === undefined ? undefined : eq(ticketTypes.active, q.active),
      q.departmentId === undefined ? undefined : eq(ticketTypes.ownerDepartmentId, q.departmentId),
      q.company === undefined ? undefined : eq(legalEntities.code, q.company),
    )).orderBy(asc(legalEntities.code), asc(ticketTypes.sortOrder), asc(sql`lower(${ticketTypes.name})`));
  }

  /** The newest version of a type. `lock` holds the row until the transaction ends, so two edits cannot interleave. */
  async current(conn: Conn, tenantId: number, publicId: string, lock = false): Promise<TypeRow | undefined> {
    const where = and(eq(ticketTypes.tenantId, tenantId), eq(ticketTypes.publicId, publicId), eq(ticketTypes.isCurrent, true));
    if (lock) await conn.select({ id: ticketTypes.id }).from(ticketTypes).where(where).for('update');
    const [row] = await this.select(conn).where(where);
    return row;
  }

  async currentByCode(conn: Conn, tenantId: number, legalEntityId: number, code: string): Promise<TypeRow | undefined> {
    const [row] = await this.select(conn).where(and(eq(ticketTypes.tenantId, tenantId), eq(ticketTypes.legalEntityId, legalEntityId),
      eq(ticketTypes.code, code), eq(ticketTypes.isCurrent, true)));
    return row;
  }

  versions(conn: Conn, tenantId: number, publicId: string): Promise<TypeRow[]> {
    return this.select(conn).where(and(eq(ticketTypes.tenantId, tenantId), eq(ticketTypes.publicId, publicId))).orderBy(desc(ticketTypes.version));
  }

  async insert(tx: Tx, v: TypeValues): Promise<void> {
    await tx.insert(ticketTypes).values(v);
  }

  async retire(tx: Tx, id: number): Promise<void> {
    await tx.update(ticketTypes).set({ isCurrent: false }).where(eq(ticketTypes.id, id));
  }

  async setActive(tx: Tx, id: number, active: boolean): Promise<void> {
    await tx.update(ticketTypes).set({ active }).where(eq(ticketTypes.id, id));
  }
}
