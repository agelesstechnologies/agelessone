import { ledgerNamesUsed, parseTallyResponse, type OutboxBatch, type TallyResultReport } from '@ageless/shared';
import { ApiError, type BackendPort } from './api';
import { errorText, type Logger } from './log';
import type { StateStore } from './state';
import { TallyUnavailable, type TallyPort } from './tally';

export interface RunDeps {
  backend: BackendPort;
  tally: TallyPort;
  state: StateStore;
  log: Logger;
  now?: () => number;
  /** What was last said about batches that could not be posted (so the API is not told the same thing every minute). Lives as long as the service. */
  memory: Map<string, { message: string; at: number }>;
}

export interface RunSummary { posted: number; completed: number; held: number; notPosted: number; recovered: number; mismatches: number }

/** A batch Tally could not be reached for is told to the API at most this often (the note only changes when the reason does). */
const NOT_POSTED_EVERY_MS = 10 * 60_000;

const reportOf = (batchPublicId: string, outcome: TallyResultReport['outcome'], message: string | null): TallyResultReport =>
  ({ batchPublicId, outcome, created: null, altered: null, errors: null, lastVchId: null, lineErrors: [], message });

/** Tries to hand a report to the API. If it cannot, the report stays in the state file and is sent again next run (never re-posted to Tally). */
async function deliver(d: RunDeps, report: TallyResultReport): Promise<boolean> {
  d.state.set(report.batchPublicId, { phase: 'answered', report });
  try {
    const ack = await d.backend.postResult(report);
    d.state.clear(report.batchPublicId);
    d.log.info('Result delivered', { batch: report.batchPublicId, outcome: report.outcome, state: ack.state, onHold: ack.onHold, created: ack.entriesCreated, returned: ack.entriesReturned });
    return true;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
      // The API will never accept this report (the batch is gone or not approved); keep nothing we cannot deliver.
      d.state.clear(report.batchPublicId);
      d.log.warn('The API refused a result; dropped', { batch: report.batchPublicId, status: e.status, message: errorText(e) });
      return true;
    }
    d.log.warn('Could not deliver a result; it is kept and sent next run', { batch: report.batchPublicId, message: errorText(e) });
    return false;
  }
}

/** Before anything else: results Tally already gave us and batches the connector stopped in the middle of. */
async function recover(d: RunDeps, s: RunSummary): Promise<void> {
  for (const [batchId, phase] of Object.entries(d.state.all())) {
    if (phase.phase === 'answered') {
      if (await deliver(d, phase.report)) s.recovered++;
    } else {
      // The connector stopped between "about to post" and "Tally answered": nobody knows if Tally took it. Never post it again by itself.
      d.log.warn('A batch was being posted when the connector stopped; reporting it as in doubt', { batch: batchId, since: phase.since });
      if (await deliver(d, reportOf(batchId, 'in_doubt', 'The connector stopped while posting this batch; check Tally before posting again'))) { s.recovered++; s.held++; }
    }
  }
}

async function notPosted(d: RunDeps, s: RunSummary, batchId: string, message: string): Promise<void> {
  s.notPosted++;
  const last = d.memory.get(batchId);
  const now = (d.now ?? Date.now)();
  if (last && last.message === message && now - last.at < NOT_POSTED_EVERY_MS) return;
  d.memory.set(batchId, { message, at: now });
  try { await d.backend.postResult(reportOf(batchId, 'not_posted', message)); }
  catch (e) { d.log.warn('Could not report that a batch was not posted', { batch: batchId, message: errorText(e) }); }
  d.log.warn('Batch not posted', { batch: batchId, reason: message });
}

/** One batch: check names, post once, report. */
async function handle(d: RunDeps, s: RunSummary, b: OutboxBatch, tallyLedgers: ReadonlySet<string>): Promise<void> {
  const missing = ledgerNamesUsed(b.xml).filter((n) => !tallyLedgers.has(n));
  if (missing.length) {
    await notPosted(d, s, b.publicId, `Tally does not have these ledger names exactly: ${missing.join(', ')}`.slice(0, 500));
    return;
  }
  d.state.set(b.publicId, { phase: 'posting', since: new Date((d.now ?? Date.now)()).toISOString() });   // written BEFORE the request
  const outcome = await d.tally.postImport(b.xml);
  s.posted++;
  if (outcome.kind === 'unreachable') {
    d.state.clear(b.publicId);                                  // nothing reached Tally: safe to try again
    s.posted--;
    await notPosted(d, s, b.publicId, outcome.message);
    return;
  }
  d.memory.delete(b.publicId);
  if (outcome.kind === 'in_doubt') {
    s.held++;
    await deliver(d, reportOf(b.publicId, 'in_doubt', outcome.message));
    return;
  }
  const r = parseTallyResponse(outcome.text);
  if (!r.readable) {
    s.held++;
    await deliver(d, reportOf(b.publicId, 'in_doubt', 'Tally answered, but not in the expected format'));
    return;
  }
  s.completed++;
  await deliver(d, { batchPublicId: b.publicId, outcome: 'completed', created: r.created, altered: r.altered, errors: r.errors, lastVchId: r.lastVchId,
    lineErrors: r.lineErrors.slice(0, 1000).map((l) => l.slice(0, 1000)), message: null });
}

/**
 * One pass: finish what an earlier run left, read the outbox, and for each company fetch Tally's ledger and cost centre
 * names and report any the books expect that Tally does not have EXACTLY (spelling, case, spaces). A batch that uses a missing
 * ledger is not posted (it would only fail in Tally); every other batch is posted once, and the answer is reported.
 */
export async function runOnce(d: RunDeps): Promise<RunSummary> {
  const s: RunSummary = { posted: 0, completed: 0, held: 0, notPosted: 0, recovered: 0, mismatches: 0 };
  await recover(d, s);
  const { batches } = await d.backend.outbox();
  const pending = batches.filter((b) => !d.state.get(b.publicId));    // anything in the state file is already being handled above
  const byCompany = new Map<string, OutboxBatch[]>();
  for (const b of pending) byCompany.set(b.tallyCompanyName, [...(byCompany.get(b.tallyCompanyName) ?? []), b]);

  for (const [company, list] of byCompany) {
    let ledgers: Set<string>;
    let centres: Set<string>;
    try {
      ledgers = new Set(await d.tally.names(company, 'ledger'));
      centres = new Set(await d.tally.names(company, 'costcentre'));
    } catch (e) {
      const message = e instanceof TallyUnavailable ? e.message : 'Tally could not be asked for its names';
      for (const b of list) await notPosted(d, s, b.publicId, message);
      continue;
    }
    const expectedLedgers = [...new Set(list.flatMap((b) => b.expectedLedgers))];
    const expectedCentres = [...new Set(list.flatMap((b) => b.expectedCostCentres))];
    const missingLedgers = expectedLedgers.filter((n) => !ledgers.has(n));
    const missingCostCentres = expectedCentres.filter((n) => !centres.has(n));
    s.mismatches += missingLedgers.length + missingCostCentres.length;
    try {
      await d.backend.postMappingReport({ tallyCompanyName: company, ledgersChecked: expectedLedgers.length, costCentresChecked: expectedCentres.length, missingLedgers, missingCostCentres });
    } catch (e) { d.log.warn('Could not report the name check', { message: errorText(e) }); }
    if (missingLedgers.length || missingCostCentres.length) d.log.warn('Names the books expect are missing in Tally', { missingLedgers: missingLedgers.length, missingCostCentres: missingCostCentres.length });
    for (const b of list) await handle(d, s, b, ledgers);
  }
  return s;
}
