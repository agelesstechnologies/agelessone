import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Conn, DB, Db, Tx } from '../../../platform/db/db.module';
import { persons } from '../../core/schema';
import { bankLines, journalLines, journalEntries, paymentBatches, paymentRequests } from '../schema';

const requester = aliasedTable(persons, 'requester');
const decider = aliasedTable(persons, 'decider');
const batchMaker = aliasedTable(persons, 'batch_maker');
const batchChecker = aliasedTable(persons, 'batch_checker');
const batchPayer = aliasedTable(persons, 'batch_payer');
const matcher = aliasedTable(persons, 'matcher');

export interface RequestRow {
  id: number; publicId: string; legalEntityId: number; payeeName: string; payeeKind: string; purpose: string; amountMinor: number; currency: string;
  dueDate: string; state: string; requestedAt: Date; decidedAt: Date | null; decisionNote: string | null; requestedBy: number; decidedBy: number | null;
  requestedByPublicId: string; requestedByName: string; decidedByPublicId: string | null; decidedByName: string | null; batchPublicId: string | null;
}
export interface BatchRow {
  id: number; publicId: string; legalEntityId: number; bankLedgerKey: string; state: string; requestCount: number; totalMinor: number; currency: string;
  createdBy: number; createdAt: Date; approvedBy: number | null; approvedAt: Date | null; paidOn: string | null; bankReference: string | null; reconciled: boolean;
  createdByPublicId: string; createdByName: string; approvedByPublicId: string | null; approvedByName: string | null; paidByPublicId: string | null; paidByName: string | null;
}
export interface BankLineRow {
  id: number; publicId: string; legalEntityId: number; bankLedgerKey: string; txnDate: string; description: string; reference: string;
  debitMinor: number; creditMinor: number; state: string; matchedAt: Date | null;
  matchedBatchPublicId: string | null; matchedByPublicId: string | null; matchedByName: string | null;
}

const requestCols = {
  id: paymentRequests.id, publicId: paymentRequests.publicId, legalEntityId: paymentRequests.legalEntityId, payeeName: paymentRequests.payeeName,
  payeeKind: paymentRequests.payeeKind, purpose: paymentRequests.purpose, amountMinor: paymentRequests.amountMinor, currency: paymentRequests.currency,
  dueDate: paymentRequests.dueDate, state: paymentRequests.state, requestedAt: paymentRequests.requestedAt, decidedAt: paymentRequests.decidedAt,
  decisionNote: paymentRequests.decisionNote, requestedBy: paymentRequests.requestedBy, decidedBy: paymentRequests.decidedBy,
  requestedByPublicId: requester.publicId, requestedByName: requester.displayName, decidedByPublicId: decider.publicId, decidedByName: decider.displayName,
  batchPublicId: sql<string | null>`(SELECT b.public_id FROM accounts.payment_batches b WHERE b.id = ${paymentRequests.batchId})`,
};
const batchCols = {
  id: paymentBatches.id, publicId: paymentBatches.publicId, legalEntityId: paymentBatches.legalEntityId, bankLedgerKey: paymentBatches.bankLedgerKey,
  state: paymentBatches.state, requestCount: paymentBatches.requestCount, totalMinor: paymentBatches.totalMinor, currency: paymentBatches.currency,
  createdBy: paymentBatches.createdBy, createdAt: paymentBatches.createdAt, approvedBy: paymentBatches.approvedBy, approvedAt: paymentBatches.approvedAt,
  paidOn: paymentBatches.paidOn, bankReference: paymentBatches.bankReference,
  reconciled: sql<boolean>`EXISTS (SELECT 1 FROM accounts.bank_lines l WHERE l.matched_batch_id = ${paymentBatches.id})`,
  createdByPublicId: batchMaker.publicId, createdByName: batchMaker.displayName, approvedByPublicId: batchChecker.publicId, approvedByName: batchChecker.displayName,
  paidByPublicId: batchPayer.publicId, paidByName: batchPayer.displayName,
};

/** Writes only accounts.*; reads people. */
@Injectable()
export class PaymentsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- requests ----

  private requestQuery(conn: Conn) {
    return conn.select(requestCols).from(paymentRequests)
      .innerJoin(requester, eq(requester.id, paymentRequests.requestedBy)).leftJoin(decider, eq(decider.id, paymentRequests.decidedBy));
  }

  requests(legalEntityId: number, state?: string): Promise<RequestRow[]> {
    return this.requestQuery(this.db)
      .where(and(eq(paymentRequests.legalEntityId, legalEntityId), state ? eq(paymentRequests.state, state) : undefined))
      .orderBy(desc(paymentRequests.requestedAt), desc(paymentRequests.id)) as Promise<RequestRow[]>;
  }

  async requestBy(conn: Conn, tenantId: number, publicId: string): Promise<RequestRow | undefined> {
    const [row] = await this.requestQuery(conn).where(and(eq(paymentRequests.tenantId, tenantId), eq(paymentRequests.publicId, publicId)));
    return row as RequestRow | undefined;
  }

  async tenantOfRequest(publicId: string) {
    const [row] = await this.db.select({ tenantId: paymentRequests.tenantId }).from(paymentRequests).where(eq(paymentRequests.publicId, publicId));
    return row;
  }

  async insertRequest(tx: Tx, v: { tenantId: number; publicId: string; legalEntityId: number; payeeName: string; payeeKind: string; purpose: string; amountMinor: number; dueDate: string; requestedBy: number }) {
    await tx.insert(paymentRequests).values(v);
  }

  async lockRequests(tx: Tx, tenantId: number, publicIds: string[]) {
    return tx.select({ id: paymentRequests.id, publicId: paymentRequests.publicId, legalEntityId: paymentRequests.legalEntityId, state: paymentRequests.state,
      amountMinor: paymentRequests.amountMinor, requestedBy: paymentRequests.requestedBy })
      .from(paymentRequests).where(and(eq(paymentRequests.tenantId, tenantId), inArray(paymentRequests.publicId, publicIds))).for('update');
  }

  async updateRequest(tx: Tx, id: number, set: Partial<{ state: string; decidedBy: number | null; decidedAt: Date | null; decisionNote: string | null; batchId: number | null }>) {
    await tx.update(paymentRequests).set(set).where(eq(paymentRequests.id, id));
  }

  async requestsOfBatch(conn: Conn, batchId: number): Promise<RequestRow[]> {
    return this.requestQuery(conn).where(eq(paymentRequests.batchId, batchId)).orderBy(asc(paymentRequests.id)) as Promise<RequestRow[]>;
  }

  async setBatchRequests(tx: Tx, batchId: number, from: string, set: { state: string; batchId?: number | null }) {
    await tx.update(paymentRequests).set(set).where(and(eq(paymentRequests.batchId, batchId), eq(paymentRequests.state, from)));
  }

  // ---- batches ----

  private batchQuery(conn: Conn) {
    return conn.select(batchCols).from(paymentBatches)
      .innerJoin(batchMaker, eq(batchMaker.id, paymentBatches.createdBy))
      .leftJoin(batchChecker, eq(batchChecker.id, paymentBatches.approvedBy)).leftJoin(batchPayer, eq(batchPayer.id, paymentBatches.paidBy));
  }

  batches(legalEntityId: number): Promise<BatchRow[]> {
    return this.batchQuery(this.db).where(eq(paymentBatches.legalEntityId, legalEntityId))
      .orderBy(desc(paymentBatches.createdAt), desc(paymentBatches.id)) as Promise<BatchRow[]>;
  }

  async batchBy(conn: Conn, tenantId: number, publicId: string): Promise<BatchRow | undefined> {
    const [row] = await this.batchQuery(conn).where(and(eq(paymentBatches.tenantId, tenantId), eq(paymentBatches.publicId, publicId)));
    return row as BatchRow | undefined;
  }

  async tenantOfBatch(publicId: string) {
    const [row] = await this.db.select({ tenantId: paymentBatches.tenantId }).from(paymentBatches).where(eq(paymentBatches.publicId, publicId));
    return row;
  }

  async lockBatch(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select().from(paymentBatches).where(and(eq(paymentBatches.tenantId, tenantId), eq(paymentBatches.publicId, publicId))).for('update');
    return row;
  }

  async insertBatch(tx: Tx, v: { tenantId: number; publicId: string; legalEntityId: number; bankLedgerKey: string; requestCount: number; totalMinor: number; createdBy: number }) {
    const [row] = await tx.insert(paymentBatches).values(v).returning({ id: paymentBatches.id });
    return row!.id;
  }

  async updateBatch(tx: Tx, id: number, set: Partial<{ state: string; approvedBy: number; approvedAt: Date; paidBy: number; paidAt: Date; paidOn: string; bankReference: string }>) {
    await tx.update(paymentBatches).set(set).where(eq(paymentBatches.id, id));
  }

  // ---- bank lines ----

  private lineQuery(conn: Conn) {
    return conn.select({
      id: bankLines.id, publicId: bankLines.publicId, legalEntityId: bankLines.legalEntityId, bankLedgerKey: bankLines.bankLedgerKey, txnDate: bankLines.txnDate,
      description: bankLines.description, reference: bankLines.reference, debitMinor: bankLines.debitMinor, creditMinor: bankLines.creditMinor,
      state: bankLines.state, matchedAt: bankLines.matchedAt, matchedByPublicId: matcher.publicId, matchedByName: matcher.displayName,
      matchedBatchPublicId: sql<string | null>`(SELECT b.public_id FROM accounts.payment_batches b WHERE b.id = ${bankLines.matchedBatchId})`,
    }).from(bankLines).leftJoin(matcher, eq(matcher.id, bankLines.matchedBy));
  }

  lines(legalEntityId: number, f: { bankLedgerKey?: string; state?: string }): Promise<BankLineRow[]> {
    return this.lineQuery(this.db)
      .where(and(eq(bankLines.legalEntityId, legalEntityId), f.bankLedgerKey ? eq(bankLines.bankLedgerKey, f.bankLedgerKey) : undefined, f.state ? eq(bankLines.state, f.state) : undefined))
      .orderBy(desc(bankLines.txnDate), desc(bankLines.id)) as Promise<BankLineRow[]>;
  }

  async lineBy(conn: Conn, tenantId: number, publicId: string): Promise<BankLineRow | undefined> {
    const [row] = await this.lineQuery(conn).where(and(eq(bankLines.tenantId, tenantId), eq(bankLines.publicId, publicId)));
    return row as BankLineRow | undefined;
  }

  async lockLine(tx: Tx, tenantId: number, publicId: string) {
    const [row] = await tx.select().from(bankLines).where(and(eq(bankLines.tenantId, tenantId), eq(bankLines.publicId, publicId))).for('update');
    return row;
  }

  /** Inserts one statement row; false when the same row is already on file. */
  async insertLine(tx: Tx, v: { tenantId: number; legalEntityId: number; bankLedgerKey: string; txnDate: string; description: string; reference: string; debitMinor: number; creditMinor: number; importedBy: number }) {
    const rows = await tx.insert(bankLines).values(v).onConflictDoNothing().returning({ id: bankLines.id });
    return rows.length > 0;
  }

  async matchLine(tx: Tx, id: number, batchId: number, by: number) {
    await tx.update(bankLines).set({ state: 'matched', matchedBatchId: batchId, matchedBy: by, matchedAt: new Date() }).where(eq(bankLines.id, id));
  }

  // ---- reports ----

  async trialBalance(legalEntityId: number, from?: string, to?: string) {
    const rows = await this.db.select({
      ledgerKey: journalLines.ledgerKey, debit: sql<string>`coalesce(sum(${journalLines.debitMinor}), 0)`, credit: sql<string>`coalesce(sum(${journalLines.creditMinor}), 0)`,
    }).from(journalLines).innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(and(eq(journalLines.legalEntityId, legalEntityId), from ? gte(journalEntries.entryDate, from) : undefined, to ? lte(journalEntries.entryDate, to) : undefined))
      .groupBy(journalLines.ledgerKey).orderBy(asc(journalLines.ledgerKey));
    return rows.map((r) => ({ ledgerKey: r.ledgerKey, debitMinor: Number(r.debit), creditMinor: Number(r.credit) }));
  }

  async requestTotals(legalEntityId: number) {
    const rows = await this.db.select({ state: paymentRequests.state, count: sql<string>`count(*)`, total: sql<string>`coalesce(sum(${paymentRequests.amountMinor}), 0)` })
      .from(paymentRequests).where(eq(paymentRequests.legalEntityId, legalEntityId)).groupBy(paymentRequests.state);
    return rows.map((r) => ({ state: r.state, count: Number(r.count), totalMinor: Number(r.total) }));
  }

  async batchTotals(legalEntityId: number) {
    const rows = await this.db.select({ state: paymentBatches.state, count: sql<string>`count(*)`, total: sql<string>`coalesce(sum(${paymentBatches.totalMinor}), 0)` })
      .from(paymentBatches).where(eq(paymentBatches.legalEntityId, legalEntityId)).groupBy(paymentBatches.state);
    return rows.map((r) => ({ state: r.state, count: Number(r.count), totalMinor: Number(r.total) }));
  }

  async bankTotals(legalEntityId: number) {
    const [r] = await this.db.select({
      outCount: sql<string>`count(*) FILTER (WHERE state = 'unmatched' AND debit_minor > 0)`, outTotal: sql<string>`coalesce(sum(debit_minor) FILTER (WHERE state = 'unmatched'), 0)`,
      inCount: sql<string>`count(*) FILTER (WHERE state = 'unmatched' AND credit_minor > 0)`, inTotal: sql<string>`coalesce(sum(credit_minor) FILTER (WHERE state = 'unmatched'), 0)`,
      matchedCount: sql<string>`count(*) FILTER (WHERE state = 'matched')`, matchedTotal: sql<string>`coalesce(sum(debit_minor) FILTER (WHERE state = 'matched'), 0)`,
    }).from(bankLines).where(eq(bankLines.legalEntityId, legalEntityId));
    const [p] = await this.db.select({ count: sql<string>`count(*)`, total: sql<string>`coalesce(sum(${paymentBatches.totalMinor}), 0)` }).from(paymentBatches)
      .where(and(eq(paymentBatches.legalEntityId, legalEntityId), eq(paymentBatches.state, 'paid'),
        sql`NOT EXISTS (SELECT 1 FROM accounts.bank_lines l WHERE l.matched_batch_id = ${paymentBatches.id})`));
    return {
      unmatchedOut: { count: Number(r!.outCount), totalMinor: Number(r!.outTotal) }, unmatchedIn: { count: Number(r!.inCount), totalMinor: Number(r!.inTotal) },
      matched: { count: Number(r!.matchedCount), totalMinor: Number(r!.matchedTotal) }, paidBatchesNotReconciled: { count: Number(p!.count), totalMinor: Number(p!.total) },
    };
  }
}
