import { Injectable } from '@nestjs/common';
import { and, asc, eq, ilike, or } from 'drizzle-orm';
import { Conn, Tx } from '../../../../platform/db/db.module';
import { customers, legalEntities } from '../../schema';

export interface CustomerRow {
  id: number; tenantId: number; publicId: string; code: string; name: string; legalEntityId: number | null;
  /** the linked group company's code, or null */
  company: string | null; status: string; createdAt: Date;
}

/** Writes only core.customers; reads the companies (core.legal_entities). */
@Injectable()
export class CustomersRepository {
  list(conn: Conn, tenantId: number, f: { q?: string; status?: string } = {}): Promise<CustomerRow[]> {
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
    return this.select(conn)
      .where(and(eq(customers.tenantId, tenantId), f.status ? eq(customers.status, f.status) : undefined,
        like ? or(ilike(customers.code, like), ilike(customers.name, like)) : undefined))
      .orderBy(asc(customers.name), asc(customers.code));
  }

  /** By public id in any tenant (to tell a resend from someone else's id). */
  async byPublicId(conn: Conn, publicId: string): Promise<CustomerRow | undefined> {
    const [row] = await this.select(conn).where(eq(customers.publicId, publicId));
    return row;
  }

  async company(conn: Conn, tenantId: number, code: string): Promise<{ id: number; code: string } | undefined> {
    const [row] = await conn.select({ id: legalEntities.id, code: legalEntities.code }).from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row;
  }

  async insert(tx: Tx, v: typeof customers.$inferInsert): Promise<void> {
    await tx.insert(customers).values(v);
  }

  async update(tx: Tx, id: number, v: Partial<typeof customers.$inferInsert>): Promise<void> {
    await tx.update(customers).set(v).where(eq(customers.id, id));
  }

  private select(conn: Conn) {
    return conn.select({
      id: customers.id, tenantId: customers.tenantId, publicId: customers.publicId, code: customers.code, name: customers.name,
      legalEntityId: customers.legalEntityId, company: legalEntities.code, status: customers.status, createdAt: customers.createdAt,
    }).from(customers).leftJoin(legalEntities, eq(legalEntities.id, customers.legalEntityId));
  }
}
