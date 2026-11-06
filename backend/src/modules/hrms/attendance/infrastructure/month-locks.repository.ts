import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, between, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { MonthLock } from '@ageless/shared';
import { Conn, DB, Db, Tx } from '../../../../platform/db/db.module';
import { legalEntities, persons } from '../../../core/schema';
import { monthLocks, workDays } from '../schema';
import { YearMonth } from '../domain/months';

const locker = aliasedTable(persons, 'locker');
const unlocker = aliasedTable(persons, 'unlocker');

/** Writes only hrms.month_locks and the lock flag of hrms.work_days. */
@Injectable()
export class MonthLocksRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findCompany(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: legalEntities.id }).from(legalEntities).where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row;
  }

  /** Which of these months are locked (open lock) for the company. */
  async lockedAmong(conn: Conn, legalEntityId: number, months: YearMonth[]): Promise<YearMonth[]> {
    if (months.length === 0) return [];
    return conn.select({ year: monthLocks.year, month: monthLocks.month }).from(monthLocks)
      .where(and(eq(monthLocks.legalEntityId, legalEntityId), isNull(monthLocks.unlockedAt),
        or(...months.map((m) => and(eq(monthLocks.year, m.year), eq(monthLocks.month, m.month))))));
  }

  async insert(tx: Tx, v: { tenantId: number; legalEntityId: number; year: number; month: number; lockedBy: number }): Promise<string> {
    const [row] = await tx.insert(monthLocks).values(v).returning({ publicId: monthLocks.publicId });
    return row.publicId;
  }

  async setDaysLocked(tx: Tx, legalEntityId: number, from: string, to: string, locked: boolean): Promise<number> {
    if (!locked) await tx.execute(sql`SELECT set_config('hrms.month_unlock', 'on', true)`); // this transaction only
    const rows = await tx.update(workDays).set({ lockedForPayroll: locked, updatedAt: new Date() })
      .where(and(eq(workDays.legalEntityId, legalEntityId), between(workDays.workDate, from, to), eq(workDays.lockedForPayroll, !locked)))
      .returning({ id: workDays.id });
    return rows.length;
  }

  async lockFor(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select({ id: monthLocks.id, legalEntityId: monthLocks.legalEntityId, year: monthLocks.year, month: monthLocks.month,
      unlockedAt: monthLocks.unlockedAt }).from(monthLocks)
      .where(and(eq(monthLocks.tenantId, tenantId), eq(monthLocks.publicId, publicId))).for('update');
    return row;
  }

  async unlock(tx: Tx, id: number, by: number, reason: string): Promise<void> {
    await tx.update(monthLocks).set({ unlockedBy: by, unlockedAt: new Date(), unlockReason: reason }).where(eq(monthLocks.id, id));
  }

  async list(tenantId: number, company?: string, year?: number, publicIds?: string[]): Promise<MonthLock[]> {
    const rows: LockRow[] = await this.db.select({
      publicId: monthLocks.publicId, company: legalEntities.code, year: monthLocks.year, month: monthLocks.month,
      lockerPublicId: locker.publicId, lockerName: locker.displayName, lockedAt: monthLocks.lockedAt,
      unlockerPublicId: unlocker.publicId, unlockerName: unlocker.displayName, unlockedAt: monthLocks.unlockedAt, unlockReason: monthLocks.unlockReason,
    }).from(monthLocks)
      .innerJoin(legalEntities, eq(legalEntities.id, monthLocks.legalEntityId))
      .innerJoin(locker, eq(locker.id, monthLocks.lockedBy))
      .leftJoin(unlocker, eq(unlocker.id, monthLocks.unlockedBy))
      .where(and(eq(monthLocks.tenantId, tenantId), company ? eq(legalEntities.code, company) : undefined,
        year ? eq(monthLocks.year, year) : undefined, publicIds ? inArray(monthLocks.publicId, publicIds) : undefined))
      .orderBy(desc(monthLocks.year), desc(monthLocks.month), desc(monthLocks.lockedAt));
    return rows.map((r) => ({
      publicId: r.publicId, company: r.company, year: r.year, month: r.month,
      lockedBy: { publicId: r.lockerPublicId, displayName: r.lockerName }, lockedAt: r.lockedAt.toISOString(),
      unlockedBy: r.unlockerPublicId ? { publicId: r.unlockerPublicId, displayName: r.unlockerName! } : null,
      unlockedAt: r.unlockedAt?.toISOString() ?? null, unlockReason: r.unlockReason,
    }));
  }
}

interface LockRow {
  publicId: string; company: string; year: number; month: number; lockerPublicId: string; lockerName: string; lockedAt: Date;
  unlockerPublicId: string | null; unlockerName: string | null; unlockedAt: Date | null; unlockReason: string | null;
}
