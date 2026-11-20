import { Inject, Injectable } from '@nestjs/common';
import { Outbox, TallyMappingAck, TallyMappingReport, TallyResultAck, TallyResultReport } from '@ageless/shared';
import { DB, Db } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { TallySyncRepository } from '../infrastructure/tally-sync.repository';
import { attributeResult, judgeResult } from '../domain/tally-result';

/** How many approved batches one poll hands out. */
const OUTBOX_LIMIT = 5;

/**
 * What the Tally connector (a program on the Tally server PC, signed in with a machine credential) may do: read the approved
 * batches, report what Tally answered, and report which ledger names Tally does not have. It never approves or builds
 * anything, and it is not a person: its work is audited with no person and the machine's name.
 */
@Injectable()
export class TallyConnectorService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TallySyncRepository) private readonly repo: TallySyncRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  private machine(ctx: RequestContext) {
    if (!ctx.machine) throw new AppError('FORBIDDEN', 403, 'Only the Tally connector may use this');
    return ctx.machine;
  }

  /** Approved batches not yet imported and not on hold. Handing a batch out counts as its first download. */
  async outbox(ctx: RequestContext): Promise<Outbox> {
    const m = this.machine(ctx);
    const rows = await this.repo.outboxBatches(ctx.tenantId, OUTBOX_LIMIT);
    const batches: Outbox['batches'] = [];
    for (const r of rows) {
      const exports = await this.repo.exportsOf(this.db, r.id);
      if (!r.downloadedAt) {
        await this.db.transaction(async (tx) => {
          await this.repo.updateBatch(tx, r.id, { downloadedAt: new Date() });
          await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: null, action: 'accounts.tally_batch_downloaded', entity: 'tally_batch', entityPublicId: r.publicId,
            legalEntityId: r.legalEntityId, summary: 'The Tally connector took the batch', details: { machine: m.name } });
        });
      }
      batches.push({ publicId: r.publicId, company: r.company, tallyCompanyName: r.tallyCompanyName, xml: r.requestXml,
        entries: exports.map((e) => ({ entryPublicId: e.entryPublicId })), expectedLedgers: await this.repo.approvedLedgerNames(r.legalEntityId), expectedCostCentres: [] });
    }
    return { batches };
  }

  /**
   * What happened to one batch. Safe to send again: a batch that is already imported or cancelled answers as it is.
   * completed: every error that names an entry's REMOTEID returns that entry to the queue; if the result does not say which
   * entries failed the batch is put on hold for a person (not an error: the connector must not post it again).
   */
  async results(ctx: RequestContext, req: TallyResultReport): Promise<TallyResultAck> {
    const m = this.machine(ctx);
    const found = await this.repo.batchTenantOf(req.batchPublicId);
    if (!found || found.tenantId !== ctx.tenantId) throw new AppError('NOT_FOUND', 404, 'No such Tally batch');
    await this.db.transaction(async (tx) => {
      const b = await this.repo.lockBatch(tx, ctx.tenantId, req.batchPublicId);
      if (!b) throw new AppError('NOT_FOUND', 404, 'No such Tally batch');
      if (b.state === 'imported' || b.state === 'cancelled') return;
      if (b.state !== 'approved') throw new AppError('ACCOUNTS_TALLY_NOT_APPROVED', 409, 'This batch is not approved');
      const audit = (action: string, summary: string, details: Record<string, unknown> = {}) => this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: null, action,
        entity: 'tally_batch', entityPublicId: req.batchPublicId, legalEntityId: b.legalEntityId, summary, details: { machine: m.name, ...details } });

      if (req.outcome === 'not_posted') {
        await this.repo.updateBatch(tx, b.id, { connectorMessage: (req.message ?? 'The connector could not reach Tally').slice(0, 500), connectorAt: new Date() });
        return;
      }
      if (req.outcome === 'in_doubt') {
        await this.repo.updateBatch(tx, b.id, { connectorHold: true, connectorAt: new Date(),
          connectorMessage: (req.message ?? 'The request may have reached Tally but no answer came; check Tally before posting again').slice(0, 500) });
        await audit('accounts.tally_batch_held', 'The Tally connector put a batch on hold: the answer from Tally is in doubt');
        return;
      }

      const exports = await this.repo.exportsOf(tx, b.id);
      const result = attributeResult({ readable: req.created !== null || req.altered !== null || req.errors !== null || req.lineErrors.length > 0,
        created: req.created, altered: req.altered, errors: req.errors, lastVchId: req.lastVchId, lineErrors: req.lineErrors }, exports.map((e) => e.remoteId));
      const verdict = judgeResult(result, exports.length);
      if (verdict.unclear.length) {
        await this.repo.updateBatch(tx, b.id, { connectorHold: true, connectorAt: new Date(),
          connectorMessage: `Tally answered but the result is unclear: ${verdict.unclear.join('; ')}`.slice(0, 500) });
        await audit('accounts.tally_batch_held', 'The Tally connector put a batch on hold: the result does not say which entries failed', { reasons: verdict.unclear.length });
        return;
      }
      const byRemote = new Map(exports.map((e) => [e.remoteId.toLowerCase(), e.id]));
      const failed = new Map(verdict.failed.map((f) => [byRemote.get(f.remoteId.toLowerCase())!, f.error]));
      for (const [id, error] of failed) await this.repo.failExports(tx, [id], error.slice(0, 500));
      await this.repo.finishPending(tx, b.id, 'created', null, [...failed.keys()]);
      await this.repo.updateBatch(tx, b.id, { state: 'imported', finishedByMachine: m.credentialId, finishedAt: new Date(), connectorHold: false, connectorMessage: null, connectorAt: new Date(),
        importResult: JSON.stringify({ source: 'connector', created: req.created, altered: req.altered, errors: req.errors, lastVchId: req.lastVchId, lineErrors: req.lineErrors }) });
      await audit('accounts.tally_batch_imported', `Tally took the batch: ${b.entryCount - failed.size} created, ${failed.size} returned to the queue`, { failed: failed.size, lastVchId: req.lastVchId });
    });
    const row = (await this.repo.batchBy(this.db, ctx.tenantId, req.batchPublicId))!;
    const exports = await this.repo.exportsOf(this.db, row.id);
    return { state: row.state as TallyResultAck['state'], onHold: row.onHold, entriesCreated: exports.filter((e) => e.state === 'created').length,
      entriesReturned: exports.filter((e) => e.state === 'failed').length, message: row.onHold ? row.connectorMessage : null };
  }

  /** Ledger (and cost centre) names the ledger map expects that Tally does not have exactly. Kept on the Tally company; audited when the answer changes. */
  async mappingReport(ctx: RequestContext, req: TallyMappingReport): Promise<TallyMappingAck> {
    const m = this.machine(ctx);
    const companies = await this.repo.tallyCompaniesNamed(ctx.tenantId, req.tallyCompanyName);
    if (!companies.length) throw new AppError('NOT_FOUND', 404, 'No company has that Tally company name');
    const missing = { ledgers: [...new Set(req.missingLedgers)].sort(), costCentres: [...new Set(req.missingCostCentres)].sort() };
    await this.db.transaction(async (tx) => {
      for (const c of companies) {
        const changed = JSON.stringify(c.missing ?? { ledgers: [], costCentres: [] }) !== JSON.stringify(missing);
        await this.repo.setConnectorCheck(tx, c.id, missing);
        if (changed) {
          await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: null, action: 'accounts.tally_names_checked', entity: 'tally_company', legalEntityId: c.legalEntityId,
            summary: missing.ledgers.length || missing.costCentres.length
              ? `Tally is missing ${missing.ledgers.length} ledger and ${missing.costCentres.length} cost centre names the books use`
              : 'Every ledger and cost centre name the books use exists in Tally',
            details: { machine: m.name, ledgersChecked: req.ledgersChecked, costCentresChecked: req.costCentresChecked, missingLedgers: missing.ledgers.length, missingCostCentres: missing.costCentres.length } });
        }
      }
    });
    return { ok: missing.ledgers.length === 0 && missing.costCentres.length === 0 };
  }
}
