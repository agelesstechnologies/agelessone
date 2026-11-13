import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CreatedTallyBatch, ImportResultRequest, MarkImportedRequest, NewTallyBatchRequest, TallyBatch, TallyBatchDetail, TallyBatchesQuery, TallyQueue, TallyQueueItem, TallyQueueQuery,
} from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { AccountsRepository } from '../infrastructure/accounts.repository';
import { BatchRow, QueueRow, TallySyncRepository } from '../infrastructure/tally-sync.repository';
import type { Line } from '../domain/ledger';
import { TallyBuildError, TallyEntry, buildTallyXml, readinessProblems, voucherKindOf } from '../domain/tally-xml';
import { judgeResult, parseTallyResult } from '../domain/tally-result';
import { AccountsService } from './accounts.service';

/** Only this many entries are listed and batched at once; the rest wait for the next batch. */
const QUEUE_LIMIT = 1000;
const person = (publicId: string | null, displayName: string | null) => (publicId && displayName ? { publicId, displayName } : null);

/**
 * Accounts -> Tally sync, with no connection to Tally. The maker builds a batch (one XML file) from the journal entries
 * that are ready; a different person, the checker, approves it; only then can it be downloaded; the accountant imports the
 * file in Tally by hand and records the result. An entry Tally refused goes back to the queue with Tally's error text.
 * The journal is only read.
 */
@Injectable()
export class TallySyncService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TallySyncRepository) private readonly repo: TallySyncRepository,
    @Inject(AccountsRepository) private readonly accountsRepo: AccountsRepository,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  // ---- the queue ----

  private toTallyEntry(r: QueueRow, lines: Line[]): TallyEntry {
    return { publicId: r.publicId, entryDate: r.entryDate, voucherKind: voucherKindOf(r.sourceType, r.reversesSourceType), narration: r.description, lines };
  }

  /** The queue entries with their lines, and which of them are ready (every ledger key has an approved Tally ledger). */
  private async loadQueue(legalEntityId: number, from: string, to: string, booksFrom: string | null) {
    const start = booksFrom && booksFrom > from ? booksFrom : from;      // nothing before the first day of the books is exported
    const rows = start > to ? [] : await this.repo.queueEntries(legalEntityId, start, to, QUEUE_LIMIT + 1);
    const limited = rows.length > QUEUE_LIMIT;
    const shown = rows.slice(0, QUEUE_LIMIT);
    const lines = await this.accountsRepo.linesOf(this.db, shown.map((r) => r.id));
    const names = await this.repo.ledgerNames(legalEntityId);
    const entries = shown.map((row) => {
      const entry = this.toTallyEntry(row, lines.get(row.id) ?? []);
      const blockedKeys = [...new Set(readinessProblems([entry], names).map((p) => p.ledgerKey))];
      return { row, entry, blockedKeys };
    });
    return { entries, limited };
  }

  async queue(ctx: RequestContext, q: TallyQueueQuery): Promise<TallyQueue> {
    const c = await this.accounts.company(ctx, q.company);
    await this.accounts.require(ctx, c.id, 'view');
    const tally = await this.accountsRepo.tallyCompanyOf(this.db, c.id);
    const { entries, limited } = await this.loadQueue(c.id, q.from, q.to, tally?.booksFrom ?? null);
    const items: TallyQueueItem[] = entries.map(({ row, entry, blockedKeys }) => ({
      entryPublicId: row.publicId, entryDate: row.entryDate, sourceType: row.sourceType, totalMinor: entry.lines.reduce((s, l) => s + l.debitMinor, 0),
      ready: blockedKeys.length === 0, blockedKeys, lastError: row.lastError,
    }));
    return { items, readyCount: items.filter((i) => i.ready).length, blockedCount: items.filter((i) => !i.ready).length, returnedCount: items.filter((i) => i.lastError).length, limited };
  }

  // ---- batches ----

  async batches(ctx: RequestContext, q: TallyBatchesQuery): Promise<TallyBatch[]> {
    const c = await this.accounts.company(ctx, q.company);
    await this.accounts.require(ctx, c.id, 'view');
    return (await this.repo.batchesOf(this.db, ctx.tenantId, c.id)).map(toBatch);
  }

  async batch(ctx: RequestContext, publicId: string): Promise<TallyBatchDetail> {
    const row = await this.visibleBatch(ctx, publicId, 'view');
    return this.detail(row);
  }

  private async detail(row: BatchRow, conn: Db | Tx = this.db): Promise<TallyBatchDetail> {
    const exports = await this.repo.exportsOf(conn, row.id);
    return { ...toBatch(row), entries: exports.map((e) => ({ entryPublicId: e.entryPublicId, entryDate: e.entryDate, sourceType: e.sourceType, voucherType: e.voucherType,
      totalMinor: e.totalMinor, state: e.state as 'pending' | 'created' | 'failed', tallyMessage: e.tallyMessage })) };
  }

  /** The batch in the caller's tenant, after checking they may use Accounts for its company. */
  private async visibleBatch(ctx: RequestContext, publicId: string, who: 'view' | 'maker' | 'checker' | 'makerOrChecker'): Promise<BatchRow> {
    const found = await this.repo.batchTenantOf(publicId);
    if (!found || found.tenantId !== ctx.tenantId) throw new AppError('NOT_FOUND', 404, 'No such Tally batch');
    await this.accounts.require(ctx, found.legalEntityId, who);
    return (await this.repo.batchBy(this.db, ctx.tenantId, publicId))!;
  }

  /** The maker builds a batch from the ready entries in the range. Entries with an unmapped ledger stay in the queue. Asking again with the same publicId answers the same batch. */
  async createBatch(ctx: RequestContext, req: NewTallyBatchRequest): Promise<{ batch: CreatedTallyBatch; created: boolean }> {
    const c = await this.accounts.company(ctx, req.company);
    await this.accounts.require(ctx, c.id, 'maker');
    if (req.publicId) {
      const found = await this.repo.batchTenantOf(req.publicId);
      if (found && found.tenantId !== ctx.tenantId) throw new AppError('ACCOUNTS_DUPLICATE_ID', 409, 'This publicId is already used');
      if (found) return { batch: { ...(await this.detail((await this.repo.batchBy(this.db, ctx.tenantId, req.publicId))!)), skippedBlocked: 0 }, created: false };
    }
    const tally = await this.accountsRepo.tallyCompanyOf(this.db, c.id);
    if (!tally) throw new AppError('ACCOUNTS_TALLY_COMPANY_MISSING', 409, `Set the Tally company of ${c.code} first`);
    if (tally.state !== 'approved') throw new AppError('ACCOUNTS_TALLY_COMPANY_NOT_APPROVED', 409, `The Tally company of ${c.code} must be approved by the checker first`);

    const { entries } = await this.loadQueue(c.id, req.from, req.to, tally.booksFrom);
    const ready = entries.filter((e) => e.blockedKeys.length === 0);
    const skippedBlocked = entries.length - ready.length;
    if (!ready.length) {
      throw new AppError('ACCOUNTS_TALLY_NOTHING_TO_SEND', 409, skippedBlocked
        ? `No entry is ready: ${skippedBlocked} use a ledger with no approved Tally ledger (see the queue)` : 'There are no entries in that range to send');
    }
    const names = await this.repo.ledgerNames(c.id);
    let xml: string;
    try { xml = buildTallyXml({ tallyCompanyName: tally.tallyCompanyName, entries: ready.map((e) => e.entry), names }); }
    catch (err) {
      if (err instanceof TallyBuildError) throw new AppError(`ACCOUNTS_${err.code}`, err.code === 'TALLY_BAD_ENTRY' ? 400 : 409, err.message, { problems: err.problems });
      throw err;
    }
    const publicId = req.publicId ?? randomUUID();
    const totalMinor = ready.reduce((s, e) => s + e.entry.lines.reduce((a, l) => a + l.debitMinor, 0), 0);
    try {
      await this.db.transaction(async (tx) => {
        const batchId = await this.repo.insertBatch(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: c.id, tallyCompanyName: tally.tallyCompanyName,
          entryCount: ready.length, totalMinor, requestXml: xml, createdBy: ctx.personId });
        await this.repo.insertExports(tx, ready.map((e) => ({ tenantId: ctx.tenantId, batchId, entryId: e.row.id, legalEntityId: c.id, remoteId: e.row.publicId,
          voucherType: e.entry.voucherKind === 'payment' ? 'Platform Payment' : 'Platform Journal' })));
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.tally_batch_created', entity: 'tally_batch', entityPublicId: publicId,
          legalEntityId: c.id, summary: `Built a Tally batch of ${ready.length} entries for ${c.code}`, details: { from: req.from, to: req.to, skippedBlocked } });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'tally_exports_entry_once') throw new AppError('ACCOUNTS_TALLY_ENTRY_ALREADY_BATCHED', 409, 'Another batch took some of these entries a moment ago; refresh the queue and try again');
      throw err;
    }
    return { batch: { ...(await this.detail((await this.repo.batchBy(this.db, ctx.tenantId, publicId))!)), skippedBlocked }, created: true };
  }

  /** The checker approves a batch someone else made; until then it cannot be downloaded. Approving an approved batch changes nothing. */
  async approve(ctx: RequestContext, publicId: string): Promise<TallyBatchDetail> {
    await this.visibleBatch(ctx, publicId, 'checker');
    await this.db.transaction(async (tx) => {
      const b = await this.repo.lockBatch(tx, ctx.tenantId, publicId);
      if (!b) throw new AppError('NOT_FOUND', 404, 'No such Tally batch');
      if (b.state === 'approved' || b.state === 'imported') return;
      if (b.state === 'cancelled') throw new AppError('ACCOUNTS_TALLY_BATCH_CANCELLED', 409, 'This batch was cancelled');
      if (b.createdBy === ctx.personId) throw new AppError('ACCOUNTS_SELF_APPROVAL', 403, 'Someone else must approve the batch you made');
      await this.repo.updateBatch(tx, b.id, { state: 'approved', approvedBy: ctx.personId, approvedAt: new Date() });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.tally_batch_approved', entity: 'tally_batch', entityPublicId: publicId,
        legalEntityId: b.legalEntityId, summary: `Approved a Tally batch of ${b.entryCount} entries` });
    });
    return this.detail((await this.repo.batchBy(this.db, ctx.tenantId, publicId))!);
  }

  /** The XML file. Only an approved (or already imported) batch can be downloaded; the first download is recorded. */
  async download(ctx: RequestContext, publicId: string): Promise<{ name: string; body: string }> {
    const b = await this.visibleBatch(ctx, publicId, 'makerOrChecker');
    if (b.state !== 'approved' && b.state !== 'imported') {
      throw new AppError('ACCOUNTS_TALLY_NOT_APPROVED', 409, b.state === 'cancelled' ? 'This batch was cancelled' : 'The checker must approve this batch before it can be downloaded');
    }
    if (!b.downloadedAt) {
      await this.db.transaction(async (tx) => {
        await this.repo.updateBatch(tx, b.id, { downloadedAt: new Date() });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.tally_batch_downloaded', entity: 'tally_batch', entityPublicId: publicId,
          legalEntityId: b.legalEntityId, summary: 'Downloaded the Tally file for the first time' });
      });
    }
    return { name: `tally-${b.company}-${b.createdAt.toISOString().slice(0, 10)}-${b.publicId.slice(0, 8)}.xml`, body: await this.repo.requestXmlOf(b.id) };
  }

  /** The accountant says the file is in Tally. Entries named as failed return to the queue with the error; every other entry is recorded as created. */
  markImported(ctx: RequestContext, publicId: string, req: MarkImportedRequest): Promise<TallyBatchDetail> {
    return this.finish(ctx, publicId, null, (exports) => {
      const byEntry = new Map(exports.map((e) => [e.entryPublicId, e]));
      const failed = new Map<number, string>();
      for (const f of req.failed) {
        const e = byEntry.get(f.entryPublicId);
        if (!e) throw new AppError('ACCOUNTS_TALLY_UNKNOWN_ENTRY', 400, `Entry ${f.entryPublicId} is not in this batch`);
        failed.set(e.id, f.error);
      }
      return failed;
    });
  }

  /** Tally's own import result. An error that names an entry's REMOTEID returns that entry to the queue; anything the text does not make clear is refused, so nobody guesses. */
  importResult(ctx: RequestContext, publicId: string, req: ImportResultRequest): Promise<TallyBatchDetail> {
    return this.finish(ctx, publicId, req.resultText, (exports) => {
      const parsed = parseTallyResult(req.resultText, exports.map((e) => e.remoteId));
      const verdict = judgeResult(parsed, exports.length);
      if (verdict.unclear.length) {
        throw new AppError('ACCOUNTS_TALLY_RESULT_UNCLEAR', 409, 'The result does not say which entries failed; mark the batch imported and name the failed entries yourself', { reasons: verdict.unclear });
      }
      const byRemote = new Map(exports.map((e) => [e.remoteId.toLowerCase(), e]));
      return new Map(verdict.failed.map((f) => [byRemote.get(f.remoteId.toLowerCase())!.id, f.error]));
    });
  }

  /** The common end of both ways of recording a result: one transaction, once (a resend answers the batch as it is). */
  private async finish(ctx: RequestContext, publicId: string, resultText: string | null,
    decide: (exports: Awaited<ReturnType<TallySyncRepository['exportsOf']>>) => Map<number, string>): Promise<TallyBatchDetail> {
    await this.visibleBatch(ctx, publicId, 'maker');
    await this.db.transaction(async (tx) => {
      const b = await this.repo.lockBatch(tx, ctx.tenantId, publicId);
      if (!b) throw new AppError('NOT_FOUND', 404, 'No such Tally batch');
      if (b.state === 'imported') return;
      if (b.state === 'cancelled') throw new AppError('ACCOUNTS_TALLY_BATCH_CANCELLED', 409, 'This batch was cancelled');
      if (b.state !== 'approved') throw new AppError('ACCOUNTS_TALLY_NOT_APPROVED', 409, 'The checker must approve this batch before it is imported');
      if (!b.downloadedAt) throw new AppError('ACCOUNTS_TALLY_NOT_DOWNLOADED', 409, 'Download the file and import it in Tally first');
      const failed = decide(await this.repo.exportsOf(tx, b.id));
      for (const [id, error] of failed) await this.repo.failExports(tx, [id], error.slice(0, 500));
      await this.repo.finishPending(tx, b.id, 'created', null, [...failed.keys()]);
      await this.repo.updateBatch(tx, b.id, { state: 'imported', finishedBy: ctx.personId, finishedAt: new Date(), connectorHold: false, connectorMessage: null,
        ...(resultText ? { importResult: resultText } : {}) });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.tally_batch_imported', entity: 'tally_batch', entityPublicId: publicId,
        legalEntityId: b.legalEntityId, summary: `Recorded the Tally import: ${b.entryCount - failed.size} created, ${failed.size} returned to the queue`, details: { failed: failed.size } });
    });
    return this.detail((await this.repo.batchBy(this.db, ctx.tenantId, publicId))!);
  }

  /** Before the import is recorded, a batch can be cancelled (by the maker or the checker); its entries go back to the queue. */
  async cancel(ctx: RequestContext, publicId: string): Promise<TallyBatchDetail> {
    await this.visibleBatch(ctx, publicId, 'makerOrChecker');
    await this.db.transaction(async (tx) => {
      const b = await this.repo.lockBatch(tx, ctx.tenantId, publicId);
      if (!b) throw new AppError('NOT_FOUND', 404, 'No such Tally batch');
      if (b.state === 'cancelled') return;
      if (b.state === 'imported') throw new AppError('ACCOUNTS_TALLY_BATCH_IMPORTED', 409, 'This batch is already recorded as imported');
      await this.repo.finishPending(tx, b.id, 'failed', 'Batch cancelled before it was imported');
      await this.repo.updateBatch(tx, b.id, { state: 'cancelled', finishedBy: ctx.personId, finishedAt: new Date(), connectorHold: false, connectorMessage: null });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.tally_batch_cancelled', entity: 'tally_batch', entityPublicId: publicId,
        legalEntityId: b.legalEntityId, summary: `Cancelled a Tally batch of ${b.entryCount} entries` });
    });
    return this.detail((await this.repo.batchBy(this.db, ctx.tenantId, publicId))!);
  }
}

function toBatch(r: BatchRow): TallyBatch {
  return {
    publicId: r.publicId, company: r.company, tallyCompanyName: r.tallyCompanyName, state: r.state as TallyBatch['state'], entryCount: r.entryCount, totalMinor: r.totalMinor,
    createdBy: person(r.createdByPublicId, r.createdByName)!, createdAt: r.createdAt.toISOString(), approvedBy: person(r.approvedByPublicId, r.approvedByName),
    approvedAt: r.approvedAt?.toISOString() ?? null, downloadedAt: r.downloadedAt?.toISOString() ?? null, finishedBy: person(r.finishedByPublicId, r.finishedByName),
    finishedAt: r.finishedAt?.toISOString() ?? null, failedCount: r.failedCount, hasResult: r.hasResult,
    importedByConnector: r.importedByConnector, onHold: r.onHold, connectorMessage: r.connectorMessage,
  };
}
