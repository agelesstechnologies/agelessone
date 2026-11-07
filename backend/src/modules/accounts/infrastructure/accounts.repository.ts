import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { journalEntries, journalLines, periods, postingRules, tallyLedgerMap } from '../schema';
import type { Line, StoredRule } from '../domain/ledger';

const closer = aliasedTable(persons, 'closer');
const requester = aliasedTable(persons, 'requester');
const maker = aliasedTable(persons, 'maker');
const checker = aliasedTable(persons, 'checker');
const creator = aliasedTable(persons, 'creator');
const reversal = aliasedTable(journalEntries, 'reversal');

export interface EntryRow {
  id: number; publicId: string; legalEntityId: number; company: string; sourceType: string; sourcePublicId: string; entryDate: string;
  currency: string; description: string | null; reversesPublicId: string | null; reversedByPublicId: string | null;
  createdByPublicId: string | null; createdByName: string | null; createdAt: Date;
}
export interface LedgerMapRow {
  publicId: string; ledgerKey: string; tallyCompany: string; tallyLedgerName: string; state: string; approvedAt: Date | null;
  makerPublicId: string; makerName: string; checkerPublicId: string | null; checkerName: string | null;
}
export interface NewEntry {
  tenantId: number; legalEntityId: number; sourceType: string; sourcePublicId: string; entryDate: string; description?: string | null;
  reversesEntryId?: number | null; createdBy: number | null; lines: Line[];
}
export interface EntryFilter { legalEntityId?: number; from?: string; to?: string; sourceType?: string; ledgerKey?: string }

/** Writes only accounts.*; reads companies and people. */
@Injectable()
export class AccountsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  async findCompany(tenantId: number, code: string) {
    const [row] = await this.db.select({ id: legalEntities.id, code: legalEntities.code }).from(legalEntities)
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.code, code)));
    return row;
  }

  async companyCodeOf(tenantId: number, id: number) {
    const [row] = await this.db.select({ code: legalEntities.code }).from(legalEntities).where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.id, id)));
    return row?.code;
  }

  // ---- periods ----

  periodsOf(legalEntityId: number, year: number) {
    return this.db.select({
      publicId: periods.publicId, month: periods.month, state: periods.state, closedAt: periods.closedAt,
      closedByPublicId: closer.publicId, closedByName: closer.displayName,
      reopenRequestedAt: periods.reopenRequestedAt, reopenReason: periods.reopenReason,
      reopenByPublicId: requester.publicId, reopenByName: requester.displayName,
    }).from(periods)
      .leftJoin(closer, eq(closer.id, periods.closedBy)).leftJoin(requester, eq(requester.id, periods.reopenRequestedBy))
      .where(and(eq(periods.legalEntityId, legalEntityId), eq(periods.year, year))).orderBy(asc(periods.month));
  }

  /** The period row, locked for the rest of the transaction; undefined = the month was never touched (open). */
  async lockPeriod(tx: Tx, legalEntityId: number, year: number, month: number) {
    const [row] = await tx.select().from(periods)
      .where(and(eq(periods.legalEntityId, legalEntityId), eq(periods.year, year), eq(periods.month, month))).for('update');
    return row;
  }

  async createPeriod(tx: Tx, v: { tenantId: number; legalEntityId: number; year: number; month: number }) {
    await tx.insert(periods).values(v).onConflictDoNothing();
    return (await this.lockPeriod(tx, v.legalEntityId, v.year, v.month))!;
  }

  async updatePeriod(tx: Tx, id: number, patch: Partial<typeof periods.$inferInsert>) {
    await tx.update(periods).set(patch).where(eq(periods.id, id));
  }

  // ---- posting rules ----

  async storedRules(tenantId: number): Promise<StoredRule[]> {
    const rows = await this.db.select().from(postingRules).where(eq(postingRules.tenantId, tenantId));
    return rows.map((r) => ({ eventType: r.eventType as StoredRule['eventType'], debitLedgerKey: r.debitLedgerKey, creditLedgerKey: r.creditLedgerKey,
      deductionLedgerKey: r.deductionLedgerKey, companyId: r.legalEntityId, version: r.version, effectiveFrom: r.effectiveFrom }));
  }

  storedRulesWithIds(tenantId: number) {
    return this.db.select().from(postingRules).where(eq(postingRules.tenantId, tenantId));
  }

  async findRule(publicId: string) {
    const [row] = await this.db.select({ tenantId: postingRules.tenantId, id: postingRules.id }).from(postingRules).where(eq(postingRules.publicId, publicId));
    return row;
  }

  async publicIdOfRule(tenantId: number, companyId: number | null, eventType: string, version: number) {
    const [row] = await this.db.select({ publicId: postingRules.publicId }).from(postingRules).where(and(eq(postingRules.tenantId, tenantId),
      companyId === null ? isNull(postingRules.legalEntityId) : eq(postingRules.legalEntityId, companyId),
      eq(postingRules.eventType, eventType), eq(postingRules.version, version)));
    return row?.publicId;
  }

  async nextRuleVersion(tx: Tx, tenantId: number, companyId: number | null, eventType: string): Promise<number> {
    const [row] = await tx.select({ v: sql<number>`coalesce(max(${postingRules.version}), 0)::int` }).from(postingRules).where(and(
      eq(postingRules.tenantId, tenantId), companyId === null ? isNull(postingRules.legalEntityId) : eq(postingRules.legalEntityId, companyId),
      eq(postingRules.eventType, eventType)));
    return row.v + 1;
  }

  async insertRule(tx: Tx, v: typeof postingRules.$inferInsert) {
    await tx.insert(postingRules).values(v);
  }

  // ---- journal ----

  private entrySelect(conn: Conn) {
    return conn.select({
      id: journalEntries.id, publicId: journalEntries.publicId, legalEntityId: journalEntries.legalEntityId, company: legalEntities.code,
      sourceType: journalEntries.sourceType, sourcePublicId: journalEntries.sourcePublicId, entryDate: journalEntries.entryDate,
      currency: journalEntries.currency, description: journalEntries.description, createdAt: journalEntries.createdAt,
      reversesPublicId: sql<string | null>`(select e.public_id from accounts.journal_entries e where e.id = ${journalEntries.reversesEntryId})`,
      reversedByPublicId: reversal.publicId, createdByPublicId: creator.publicId, createdByName: creator.displayName,
    }).from(journalEntries)
      .innerJoin(legalEntities, eq(legalEntities.id, journalEntries.legalEntityId))
      .leftJoin(reversal, eq(reversal.reversesEntryId, journalEntries.id))
      .leftJoin(creator, eq(creator.id, journalEntries.createdBy));
  }

  private entryWhere(tenantId: number, f: EntryFilter) {
    return and(eq(journalEntries.tenantId, tenantId),
      f.legalEntityId ? eq(journalEntries.legalEntityId, f.legalEntityId) : undefined,
      f.from ? gte(journalEntries.entryDate, f.from) : undefined,
      f.to ? lte(journalEntries.entryDate, f.to) : undefined,
      f.sourceType ? eq(journalEntries.sourceType, f.sourceType) : undefined,
      f.ledgerKey ? sql`exists (select 1 from accounts.journal_lines l where l.entry_id = ${journalEntries.id} and l.ledger_key = ${f.ledgerKey})` : undefined);
  }

  async entries(tenantId: number, f: EntryFilter, page: number, pageSize: number): Promise<{ rows: EntryRow[]; total: number }> {
    const where = this.entryWhere(tenantId, f);
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(journalEntries).where(where);
    const rows = await this.entrySelect(this.db).where(where).orderBy(desc(journalEntries.entryDate), desc(journalEntries.id))
      .limit(pageSize).offset((page - 1) * pageSize);
    return { rows, total: n };
  }

  async entryBy(conn: Conn, tenantId: number, where: { publicId?: string; source?: { legalEntityId?: number; type: string; publicId: string } }): Promise<EntryRow | undefined> {
    const cond = where.publicId ? eq(journalEntries.publicId, where.publicId)
      : and(eq(journalEntries.sourceType, where.source!.type), eq(journalEntries.sourcePublicId, where.source!.publicId),
        where.source!.legalEntityId ? eq(journalEntries.legalEntityId, where.source!.legalEntityId) : undefined);
    const [row] = await this.entrySelect(conn).where(and(eq(journalEntries.tenantId, tenantId), cond));
    return row;
  }

  async linesOf(conn: Conn, entryIds: number[]): Promise<Map<number, Line[]>> {
    const out = new Map<number, Line[]>();
    if (!entryIds.length) return out;
    const rows = await conn.select().from(journalLines).where(inArray(journalLines.entryId, entryIds)).orderBy(asc(journalLines.entryId), asc(journalLines.lineNo));
    for (const r of rows) out.set(r.entryId, [...(out.get(r.entryId) ?? []), { ledgerKey: r.ledgerKey, debitMinor: r.debitMinor, creditMinor: r.creditMinor }]);
    return out;
  }

  /** Inserts the entry and its lines. The balance rule is checked by the database when the transaction commits. */
  async insertEntry(tx: Tx, e: NewEntry): Promise<{ id: number; publicId: string }> {
    const [row] = await tx.insert(journalEntries).values({
      tenantId: e.tenantId, legalEntityId: e.legalEntityId, sourceType: e.sourceType, sourcePublicId: e.sourcePublicId, entryDate: e.entryDate,
      description: e.description ?? null, reversesEntryId: e.reversesEntryId ?? null, createdBy: e.createdBy,
    }).returning({ id: journalEntries.id, publicId: journalEntries.publicId });
    await tx.insert(journalLines).values(e.lines.map((l, i) => ({ tenantId: e.tenantId, entryId: row.id, legalEntityId: e.legalEntityId, lineNo: i + 1,
      ledgerKey: l.ledgerKey, debitMinor: l.debitMinor, creditMinor: l.creditMinor })));
    return row;
  }

  async usedLedgerKeys(legalEntityId: number): Promise<string[]> {
    const rows = await this.db.selectDistinct({ k: journalLines.ledgerKey }).from(journalLines).where(eq(journalLines.legalEntityId, legalEntityId));
    return rows.map((r) => r.k);
  }

  // ---- Tally ledger map ----

  ledgerMap(legalEntityId: number): Promise<LedgerMapRow[]> {
    return this.db.select({
      publicId: tallyLedgerMap.publicId, ledgerKey: tallyLedgerMap.ledgerKey, tallyCompany: tallyLedgerMap.tallyCompany,
      tallyLedgerName: tallyLedgerMap.tallyLedgerName, state: tallyLedgerMap.state, approvedAt: tallyLedgerMap.approvedAt,
      makerPublicId: maker.publicId, makerName: maker.displayName, checkerPublicId: checker.publicId, checkerName: checker.displayName,
    }).from(tallyLedgerMap)
      .innerJoin(maker, eq(maker.id, tallyLedgerMap.draftedBy)).leftJoin(checker, eq(checker.id, tallyLedgerMap.approvedBy))
      .where(eq(tallyLedgerMap.legalEntityId, legalEntityId)).orderBy(asc(tallyLedgerMap.ledgerKey)) as unknown as Promise<LedgerMapRow[]>;
  }

  async mapTenantOf(publicId: string) {
    const [row] = await this.db.select({ tenantId: tallyLedgerMap.tenantId, legalEntityId: tallyLedgerMap.legalEntityId }).from(tallyLedgerMap).where(eq(tallyLedgerMap.publicId, publicId));
    return row;
  }

  async lockMapByKey(tx: Tx, legalEntityId: number, ledgerKey: string) {
    const [row] = await tx.select().from(tallyLedgerMap).where(and(eq(tallyLedgerMap.legalEntityId, legalEntityId), eq(tallyLedgerMap.ledgerKey, ledgerKey))).for('update');
    return row;
  }

  async lockMapByPublicId(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select().from(tallyLedgerMap).where(and(eq(tallyLedgerMap.tenantId, tenantId), eq(tallyLedgerMap.publicId, publicId))).for('update');
    return row;
  }

  async insertMap(tx: Tx, v: typeof tallyLedgerMap.$inferInsert) {
    await tx.insert(tallyLedgerMap).values(v);
  }

  async updateMap(tx: Tx, id: number, patch: Partial<typeof tallyLedgerMap.$inferInsert>) {
    await tx.update(tallyLedgerMap).set(patch).where(eq(tallyLedgerMap.id, id));
  }
}
