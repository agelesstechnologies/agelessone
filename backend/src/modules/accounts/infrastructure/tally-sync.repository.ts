import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { legalEntities, persons } from '../../core/schema';
import { journalEntries, tallyBatches, tallyCompanies, tallyExports, tallyLedgerMap } from '../schema';

const creator = aliasedTable(persons, 'batch_creator');
const approver = aliasedTable(persons, 'batch_approver');
const finisher = aliasedTable(persons, 'batch_finisher');
const original = aliasedTable(journalEntries, 'original');

export interface QueueRow {
  id: number; publicId: string; entryDate: string; sourceType: string; description: string | null; reversesSourceType: string | null; lastError: string | null;
}
export interface BatchRow {
  id: number; publicId: string; legalEntityId: number; company: string; tallyCompanyName: string; state: string; entryCount: number; totalMinor: number;
  createdAt: Date; approvedAt: Date | null; downloadedAt: Date | null; finishedAt: Date | null; hasResult: boolean; failedCount: number; createdById: number;
  onHold: boolean; connectorMessage: string | null; importedByConnector: boolean;
  createdByPublicId: string; createdByName: string; approvedByPublicId: string | null; approvedByName: string | null;
  finishedByPublicId: string | null; finishedByName: string | null;
}
export interface ExportRow {
  id: number; entryId: number; entryPublicId: string; remoteId: string; entryDate: string; sourceType: string; voucherType: string; state: string;
  tallyMessage: string | null; totalMinor: number;
}

/** Writes only accounts.tally_batches and accounts.tally_exports (the journal is read, never changed). */
@Injectable()
export class TallySyncRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Entries in the date range that are in no live batch (never exported, or every earlier attempt failed or was cancelled). */
  queueEntries(legalEntityId: number, from: string, to: string, limit: number): Promise<QueueRow[]> {
    return this.db.select({
      id: journalEntries.id, publicId: journalEntries.publicId, entryDate: journalEntries.entryDate, sourceType: journalEntries.sourceType,
      description: journalEntries.description, reversesSourceType: original.sourceType,
      lastError: sql<string | null>`(select x.tally_message from accounts.tally_exports x where x.entry_id = ${journalEntries.id} and x.state = 'failed' order by x.id desc limit 1)`,
    }).from(journalEntries).leftJoin(original, eq(original.id, journalEntries.reversesEntryId))
      .where(and(eq(journalEntries.legalEntityId, legalEntityId), gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to),
        sql`not exists (select 1 from accounts.tally_exports x where x.entry_id = ${journalEntries.id} and x.state <> 'failed')`))
      .orderBy(asc(journalEntries.entryDate), asc(journalEntries.id)).limit(limit);
  }

  async ledgerNames(legalEntityId: number): Promise<Map<string, { tallyLedgerName: string; approved: boolean }>> {
    const rows = await this.db.select({ key: tallyLedgerMap.ledgerKey, name: tallyLedgerMap.tallyLedgerName, state: tallyLedgerMap.state })
      .from(tallyLedgerMap).where(eq(tallyLedgerMap.legalEntityId, legalEntityId));
    return new Map(rows.map((r) => [r.key, { tallyLedgerName: r.name, approved: r.state === 'approved' }]));
  }

  // ---- batches ----

  async insertBatch(tx: Tx, v: typeof tallyBatches.$inferInsert): Promise<number> {
    const [row] = await tx.insert(tallyBatches).values(v).returning({ id: tallyBatches.id });
    return row!.id;
  }

  async insertExports(tx: Tx, rows: (typeof tallyExports.$inferInsert)[]) {
    await tx.insert(tallyExports).values(rows);
  }

  async batchTenantOf(publicId: string) {
    const [row] = await this.db.select({ tenantId: tallyBatches.tenantId, legalEntityId: tallyBatches.legalEntityId }).from(tallyBatches).where(eq(tallyBatches.publicId, publicId));
    return row;
  }

  async lockBatch(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select().from(tallyBatches).where(and(eq(tallyBatches.tenantId, tenantId), eq(tallyBatches.publicId, publicId))).for('update');
    return row;
  }

  async updateBatch(conn: Conn, id: number, patch: Partial<typeof tallyBatches.$inferInsert>) {
    await conn.update(tallyBatches).set(patch).where(eq(tallyBatches.id, id));
  }

  private batchSelect(conn: Conn) {
    return conn.select({
      id: tallyBatches.id, publicId: tallyBatches.publicId, legalEntityId: tallyBatches.legalEntityId, company: legalEntities.code,
      tallyCompanyName: tallyBatches.tallyCompanyName, state: tallyBatches.state, entryCount: tallyBatches.entryCount, totalMinor: tallyBatches.totalMinor,
      createdAt: tallyBatches.createdAt, approvedAt: tallyBatches.approvedAt, downloadedAt: tallyBatches.downloadedAt, finishedAt: tallyBatches.finishedAt,
      hasResult: sql<boolean>`${tallyBatches.importResult} is not null`, onHold: tallyBatches.connectorHold, connectorMessage: tallyBatches.connectorMessage,
      importedByConnector: sql<boolean>`${tallyBatches.finishedByMachine} is not null`,
      failedCount: sql<number>`(select count(*)::int from accounts.tally_exports x where x.batch_id = ${tallyBatches.id} and x.state = 'failed')`,
      createdById: tallyBatches.createdBy, createdByPublicId: creator.publicId, createdByName: creator.displayName,
      approvedByPublicId: approver.publicId, approvedByName: approver.displayName, finishedByPublicId: finisher.publicId, finishedByName: finisher.displayName,
    }).from(tallyBatches)
      .innerJoin(legalEntities, eq(legalEntities.id, tallyBatches.legalEntityId))
      .innerJoin(creator, eq(creator.id, tallyBatches.createdBy))
      .leftJoin(approver, eq(approver.id, tallyBatches.approvedBy))
      .leftJoin(finisher, eq(finisher.id, tallyBatches.finishedBy));
  }

  async batchesOf(conn: Conn, tenantId: number, legalEntityId: number): Promise<BatchRow[]> {
    return this.batchSelect(conn).where(and(eq(tallyBatches.tenantId, tenantId), eq(tallyBatches.legalEntityId, legalEntityId)))
      .orderBy(desc(tallyBatches.createdAt), desc(tallyBatches.id)) as unknown as Promise<BatchRow[]>;
  }

  async batchBy(conn: Conn, tenantId: number, publicId: string): Promise<BatchRow | undefined> {
    const [row] = await this.batchSelect(conn).where(and(eq(tallyBatches.tenantId, tenantId), eq(tallyBatches.publicId, publicId)));
    return row as BatchRow | undefined;
  }

  /** Approved batches the connector has not finished and nobody has put on hold, oldest first. */
  async outboxBatches(tenantId: number, limit: number): Promise<(BatchRow & { requestXml: string })[]> {
    const rows = await this.batchSelect(this.db).where(and(eq(tallyBatches.tenantId, tenantId), eq(tallyBatches.state, 'approved'), eq(tallyBatches.connectorHold, false)))
      .orderBy(asc(tallyBatches.createdAt), asc(tallyBatches.id)).limit(limit) as unknown as BatchRow[];
    const out: (BatchRow & { requestXml: string })[] = [];
    for (const r of rows) out.push({ ...r, requestXml: await this.requestXmlOf(r.id) });
    return out;
  }

  /** The Tally names of the ledgers the maker drafted and the checker approved: what the books actually use. */
  async approvedLedgerNames(legalEntityId: number): Promise<string[]> {
    const rows = await this.db.select({ name: tallyLedgerMap.tallyLedgerName }).from(tallyLedgerMap)
      .where(and(eq(tallyLedgerMap.legalEntityId, legalEntityId), eq(tallyLedgerMap.state, 'approved'))).orderBy(asc(tallyLedgerMap.tallyLedgerName));
    return [...new Set(rows.map((r) => r.name))];
  }

  /** Companies (of the tenant) whose Tally company has this name. */
  async tallyCompaniesNamed(tenantId: number, name: string) {
    return this.db.select({ id: tallyCompanies.id, legalEntityId: tallyCompanies.legalEntityId, missing: tallyCompanies.connectorMissing, checkedAt: tallyCompanies.connectorCheckedAt })
      .from(tallyCompanies).where(and(eq(tallyCompanies.tenantId, tenantId), eq(tallyCompanies.tallyCompanyName, name)));
  }

  async setConnectorCheck(tx: Tx, id: number, missing: { ledgers: string[]; costCentres: string[] }) {
    await tx.update(tallyCompanies).set({ connectorCheckedAt: new Date(), connectorMissing: missing }).where(eq(tallyCompanies.id, id));
  }

  async requestXmlOf(batchId: number): Promise<string> {
    const [row] = await this.db.select({ x: tallyBatches.requestXml }).from(tallyBatches).where(eq(tallyBatches.id, batchId));
    return row!.x;
  }

  // ---- exports ----

  exportsOf(conn: Conn, batchId: number): Promise<ExportRow[]> {
    return conn.select({
      id: tallyExports.id, entryId: tallyExports.entryId, entryPublicId: journalEntries.publicId, remoteId: tallyExports.remoteId, entryDate: journalEntries.entryDate,
      sourceType: journalEntries.sourceType, voucherType: tallyExports.voucherType, state: tallyExports.state, tallyMessage: tallyExports.tallyMessage,
      totalMinor: sql<number>`(select coalesce(sum(l.debit_minor), 0)::bigint from accounts.journal_lines l where l.entry_id = ${journalEntries.id})`.mapWith(Number),
    }).from(tallyExports).innerJoin(journalEntries, eq(journalEntries.id, tallyExports.entryId))
      .where(eq(tallyExports.batchId, batchId)).orderBy(asc(journalEntries.entryDate), asc(tallyExports.id)) as unknown as Promise<ExportRow[]>;
  }

  /** Every still-pending export of the batch becomes `state`, except the ones listed in `except` (set separately). */
  async finishPending(tx: Tx, batchId: number, state: 'created' | 'failed', message: string | null, except: number[] = []) {
    await tx.update(tallyExports).set({ state, tallyMessage: message, finishedAt: new Date() })
      .where(and(eq(tallyExports.batchId, batchId), eq(tallyExports.state, 'pending'),
        except.length ? sql`${tallyExports.id} not in (${sql.join(except.map((i) => sql`${i}`), sql`, `)})` : undefined));
  }

  async failExports(tx: Tx, ids: number[], message: string) {
    if (ids.length) await tx.update(tallyExports).set({ state: 'failed', tallyMessage: message, finishedAt: new Date() }).where(inArray(tallyExports.id, ids));
  }
}
