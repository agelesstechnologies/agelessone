import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, eq, inArray } from 'drizzle-orm';
import type { LocationType, RecordStatus } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { employments } from '../../hrms/people/schema';
import { locations } from '../schema';

const creator = aliasedTable(persons, 'creator');
const updater = aliasedTable(persons, 'updater');
const custodian = aliasedTable(persons, 'custodian');

export interface LocationRow {
  id: number; publicId: string; legalEntityId: number; company: string; type: LocationType; code: string; name: string; parentId: number | null;
  status: RecordStatus; custodianEmploymentId: number | null; custodianEmploymentPublicId: string | null; custodianEmployeeCode: string | null;
  custodianPublicId: string | null; custodianName: string | null;
  createdByPublicId: string; createdByName: string; createdAt: Date; updatedByPublicId: string | null; updatedByName: string | null; updatedAt: Date | null;
}

/** Writes inventory.locations; reads companies, jobs and people for names. */
@Injectable()
export class LocationsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  private select(conn: Conn) {
    return conn.select({
      id: locations.id, publicId: locations.publicId, legalEntityId: locations.legalEntityId, company: legalEntities.code,
      type: locations.type, code: locations.code, name: locations.name, parentId: locations.parentId, status: locations.status,
      custodianEmploymentId: locations.custodianEmploymentId, custodianEmploymentPublicId: employments.publicId,
      custodianEmployeeCode: employments.employeeCode, custodianPublicId: custodian.publicId, custodianName: custodian.displayName,
      createdByPublicId: creator.publicId, createdByName: creator.displayName, createdAt: locations.createdAt,
      updatedByPublicId: updater.publicId, updatedByName: updater.displayName, updatedAt: locations.updatedAt,
    }).from(locations)
      .innerJoin(legalEntities, eq(legalEntities.id, locations.legalEntityId))
      .innerJoin(creator, eq(creator.id, locations.createdBy))
      .leftJoin(updater, eq(updater.id, locations.updatedBy))
      .leftJoin(employments, eq(employments.id, locations.custodianEmploymentId))
      .leftJoin(custodian, eq(custodian.id, employments.personId));
  }

  /** Every location of these companies, by company then code. */
  async list(conn: Conn, tenantId: number, companyIds: number[]): Promise<LocationRow[]> {
    if (companyIds.length === 0) return [];
    const rows = await this.select(conn).where(and(eq(locations.tenantId, tenantId), inArray(locations.legalEntityId, companyIds)))
      .orderBy(asc(legalEntities.code), asc(locations.code));
    return rows as LocationRow[];
  }

  /** `lock` holds the row until the transaction ends, so two changes cannot interleave. */
  async get(conn: Conn, tenantId: number, publicId: string, lock = false): Promise<LocationRow | undefined> {
    const where = and(eq(locations.tenantId, tenantId), eq(locations.publicId, publicId));
    if (lock) await conn.select({ id: locations.id }).from(locations).where(where).for('update');
    const [row] = await this.select(conn).where(where);
    return row as LocationRow | undefined;
  }

  /** Code, type and status of every location of a company (what an import and item checks compare against). */
  async companyLocations(conn: Conn, legalEntityId: number): Promise<{ id: number; code: string; type: LocationType; status: string }[]> {
    const rows = await conn.select({ id: locations.id, code: locations.code, type: locations.type, status: locations.status }).from(locations)
      .where(eq(locations.legalEntityId, legalEntityId));
    return rows as { id: number; code: string; type: LocationType; status: string }[];
  }

  /** Whether the location has children that are still active. */
  async hasActiveChildren(conn: Conn, id: number): Promise<boolean> {
    const [row] = await conn.select({ id: locations.id }).from(locations).where(and(eq(locations.parentId, id), eq(locations.status, 'active'))).limit(1);
    return row !== undefined;
  }

  async parentActive(conn: Conn, parentId: number): Promise<boolean> {
    const [row] = await conn.select({ status: locations.status }).from(locations).where(eq(locations.id, parentId));
    return row?.status === 'active';
  }

  /** Inserts a location and answers its id. */
  async insert(tx: Tx, v: typeof locations.$inferInsert): Promise<number> {
    const [row] = await tx.insert(locations).values(v).returning({ id: locations.id });
    return row.id;
  }

  async update(tx: Tx, id: number, patch: { name?: string; custodianEmploymentId?: number | null; status?: RecordStatus; updatedBy: number; updatedAt: Date }): Promise<void> {
    await tx.update(locations).set(patch).where(eq(locations.id, id));
  }
}
