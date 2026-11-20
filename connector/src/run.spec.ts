import { describe, expect, it } from 'vitest';
import type { Outbox, OutboxBatch, TallyMappingReport, TallyResultAck, TallyResultReport } from '@ageless/shared';
import { ApiError, type BackendPort } from './api';
import { Redactor, createLogger } from './log';
import { runOnce, type RunDeps } from './run';
import { MemoryState } from './state';
import { TallyUnavailable, type PostOutcome, type TallyPort } from './tally';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const E1 = '33333333-3333-4333-8333-333333333333';
const SECRET = 'mcs_the-client-secret';
const TOKEN = 'jwt.token.value';
const xmlUsing = (...ledgers: string[]) => `<ENVELOPE>${ledgers.map((l) => `<LEDGERNAME>${l}</LEDGERNAME><AMOUNT>-1234.50</AMOUNT>`).join('')}</ENVELOPE>`;
const batch = (publicId: string, ledgers: string[], over: Partial<OutboxBatch> = {}): OutboxBatch =>
  ({ publicId, company: 'ATPL', tallyCompanyName: 'Ageless', xml: xmlUsing(...ledgers), entries: [{ entryPublicId: E1 }], expectedLedgers: ledgers, expectedCostCentres: [], ...over });
const ok = (n = 1, errors = 0, lines = ''): PostOutcome => ({ kind: 'answer', text: `<RESPONSE><CREATED>${n}</CREATED><ALTERED>0</ALTERED><LASTVCHID>77</LASTVCHID><ERRORS>${errors}</ERRORS>${lines}</RESPONSE>` });

/** An API that behaves like the real one: completed and in-doubt batches leave the outbox; "not posted" ones stay. */
class FakeBackend implements BackendPort {
  batches: OutboxBatch[];
  results: TallyResultReport[] = [];
  mappings: TallyMappingReport[] = [];
  failResults: Error | null = null;
  constructor(batches: OutboxBatch[]) { this.batches = batches; }
  async outbox(): Promise<Outbox> { return { batches: this.batches }; }
  async postResult(r: TallyResultReport): Promise<TallyResultAck> {
    if (this.failResults) throw this.failResults;
    this.results.push(r);
    if (r.outcome !== 'not_posted') this.batches = this.batches.filter((b) => b.publicId !== r.batchPublicId);
    return { state: r.outcome === 'completed' ? 'imported' : 'approved', onHold: r.outcome === 'in_doubt', entriesCreated: r.created ?? 0, entriesReturned: 0, message: null };
  }
  async postMappingReport(r: TallyMappingReport) { this.mappings.push(r); return { ok: !r.missingLedgers.length && !r.missingCostCentres.length }; }
}

class FakeTally implements TallyPort {
  posted: string[] = [];
  constructor(public ledgers: string[] | Error, public centres: string[] = [], public outcomes: PostOutcome[] = []) {}
  async postImport(xml: string): Promise<PostOutcome> { this.posted.push(xml); return this.outcomes.shift() ?? ok(); }
  async names(_company: string, kind: 'ledger' | 'costcentre'): Promise<string[]> {
    if (this.ledgers instanceof Error) throw this.ledgers;
    return kind === 'ledger' ? this.ledgers : this.centres;
  }
}

function setup(backend: FakeBackend, tally: FakeTally, extra: Partial<RunDeps> = {}) {
  const lines: string[] = [];
  const redactor = new Redactor();
  redactor.add(SECRET); redactor.add(TOKEN);
  const deps: RunDeps = { backend, tally, state: new MemoryState(), log: createLogger(redactor, (l) => lines.push(l)), memory: new Map(), ...extra };
  return { deps, lines };
}

describe('one run of the connector', () => {
  it('posts an approved batch to Tally once and reports what Tally said (CREATED, ERRORS, LASTVCHID, LINEERROR)', async () => {
    const backend = new FakeBackend([batch(A, ['Fuel & Oil', 'HDFC Current'])]);
    const tally = new FakeTally(['Fuel & Oil', 'HDFC Current'], [], [ok(1, 1, `<LINEERROR>Voucher ${E1}: Date is outside the books &amp; period</LINEERROR>`)]);
    const { deps } = setup(backend, tally);
    const s = await runOnce(deps);
    expect(tally.posted).toEqual([xmlUsing('Fuel & Oil', 'HDFC Current')]);
    expect(backend.results).toEqual([{ batchPublicId: A, outcome: 'completed', created: 1, altered: 0, errors: 1, lastVchId: '77', lineErrors: [`Voucher ${E1}: Date is outside the books & period`], message: null }]);
    expect(deps.state.all()).toEqual({});
    expect(s).toMatchObject({ completed: 1, held: 0, notPosted: 0 });
    expect(backend.mappings).toEqual([{ tallyCompanyName: 'Ageless', ledgersChecked: 2, costCentresChecked: 0, missingLedgers: [], missingCostCentres: [] }]);
  });

  it('reports a ledger or cost centre name Tally does not have exactly, and does not post a batch that uses it', async () => {
    const backend = new FakeBackend([batch(A, ['Fuel & Oil'], { expectedCostCentres: ['Site 7'] }), batch(B, ['HDFC Current'])]);
    const tally = new FakeTally(['Fuel & Oil', 'HDFC current'], ['Site 8']);   // wrong case on one, a different cost centre
    const { deps } = setup(backend, tally);
    const s = await runOnce(deps);
    expect(backend.mappings[0]).toMatchObject({ missingLedgers: ['HDFC Current'], missingCostCentres: ['Site 7'], ledgersChecked: 2, costCentresChecked: 1 });
    expect(tally.posted).toEqual([xmlUsing('Fuel & Oil')]);                         // A is posted, B is not
    expect(backend.results.find((r) => r.batchPublicId === B)).toMatchObject({ outcome: 'not_posted', message: 'Tally does not have these ledger names exactly: HDFC Current' });
    expect(s).toMatchObject({ completed: 1, notPosted: 1, mismatches: 2 });
    expect(deps.state.get(B)).toBeUndefined();
  });

  it('Tally not running or the company not open: nothing is posted; the API is told once, then again only when the reason changes or ten minutes pass', async () => {
    const backend = new FakeBackend([batch(A, ['Fuel & Oil'])]);
    const tally = new FakeTally(new TallyUnavailable('Tally listed no ledgers for the company "Ageless"'));
    let now = 1_000_000;
    const { deps } = setup(backend, tally, { now: () => now });
    await runOnce(deps);
    await runOnce(deps);
    expect(backend.results).toHaveLength(1);
    expect(backend.results[0]).toMatchObject({ outcome: 'not_posted' });
    expect(tally.posted).toEqual([]);
    expect(backend.mappings).toEqual([]);
    now += 11 * 60_000;
    await runOnce(deps);
    expect(backend.results).toHaveLength(2);
    tally.ledgers = new TallyUnavailable('Tally is not listening on that port');
    await runOnce(deps);
    expect(backend.results).toHaveLength(3);
  });

  it('a batch Tally could not be reached for is not remembered as posted, so the next run tries again', async () => {
    const backend = new FakeBackend([batch(A, ['Fuel & Oil'])]);
    const tally = new FakeTally(['Fuel & Oil'], [], [{ kind: 'unreachable', message: 'Tally is not listening on that port' }, ok()]);
    const { deps } = setup(backend, tally);
    await runOnce(deps);
    expect(backend.results.map((r) => r.outcome)).toEqual(['not_posted']);
    expect(deps.state.all()).toEqual({});
    await runOnce(deps);
    expect(backend.results.map((r) => r.outcome)).toEqual(['not_posted', 'completed']);
    expect(tally.posted).toHaveLength(2);
  });

  it('an answer that may not have arrived is reported "in doubt" and never posted again by the connector', async () => {
    const backend = new FakeBackend([batch(A, ['Fuel & Oil'])]);
    const tally = new FakeTally(['Fuel & Oil'], [], [{ kind: 'in_doubt', message: 'No answer from Tally after 120 seconds' }]);
    const { deps } = setup(backend, tally);
    const s = await runOnce(deps);
    expect(backend.results).toEqual([expect.objectContaining({ outcome: 'in_doubt', message: 'No answer from Tally after 120 seconds' })]);
    expect(s.held).toBe(1);
    await runOnce(deps);
    expect(tally.posted).toHaveLength(1);
  });

  it('an answer that is not a Tally result is also reported in doubt', async () => {
    const backend = new FakeBackend([batch(A, ['Fuel & Oil'])]);
    const { deps } = setup(backend, new FakeTally(['Fuel & Oil'], [], [{ kind: 'answer', text: '<html>proxy error</html>' }]));
    await runOnce(deps);
    expect(backend.results[0]).toMatchObject({ outcome: 'in_doubt', message: 'Tally answered, but not in the expected format' });
  });

  it('a connector that stopped mid-post reports the batch in doubt on its next start and does not post it', async () => {
    const backend = new FakeBackend([batch(A, ['Fuel & Oil'])]);
    const tally = new FakeTally(['Fuel & Oil']);
    const state = new MemoryState();
    state.set(A, { phase: 'posting', since: '2036-01-01T00:00:00.000Z' });          // left behind by the crash
    const { deps } = setup(backend, tally, { state });
    const s = await runOnce(deps);
    expect(backend.results).toEqual([expect.objectContaining({ batchPublicId: A, outcome: 'in_doubt' })]);
    expect(tally.posted).toEqual([]);
    expect(state.all()).toEqual({});
    expect(s).toMatchObject({ recovered: 1, held: 1 });
  });

  it('when the API cannot be reached to report, the result is kept and delivered next run; Tally is never posted twice', async () => {
    const backend = new FakeBackend([batch(A, ['Fuel & Oil'])]);
    const tally = new FakeTally(['Fuel & Oil']);
    const { deps, lines } = setup(backend, tally);
    backend.failResults = new ApiError('The Ageless API could not be reached', 0);
    await runOnce(deps);
    expect(deps.state.get(A)).toMatchObject({ phase: 'answered', report: { outcome: 'completed', created: 1 } });
    expect(lines.join('\n')).toMatch(/kept and sent next run/);
    backend.failResults = null;                                                       // the API is back; the outbox still lists A (it never heard the result)
    const s = await runOnce(deps);
    expect(backend.results.map((r) => [r.batchPublicId, r.outcome])).toEqual([[A, 'completed']]);
    expect(tally.posted).toHaveLength(1);
    expect(s.recovered).toBe(1);
    expect(deps.state.all()).toEqual({});
  });

  it('a result the API will never accept (batch gone, not approved) is dropped rather than retried forever', async () => {
    const backend = new FakeBackend([batch(A, ['Fuel & Oil'])]);
    const { deps } = setup(backend, new FakeTally(['Fuel & Oil']));
    backend.failResults = new ApiError('This batch is not approved', 409, 'ACCOUNTS_TALLY_NOT_APPROVED');
    await runOnce(deps);
    expect(deps.state.all()).toEqual({});
  });

  it('logs ids and counts only: never the secret, a token, voucher XML or amounts', async () => {
    const backend = new FakeBackend([batch(A, ['Fuel & Oil']), batch(B, ['Missing Ledger'])]);
    const tally = new FakeTally(['Fuel & Oil'], [], [ok(1, 1, `<LINEERROR>mcs_the-client-secret ${E1} bad &amp; wrong</LINEERROR>`)]);
    const { deps, lines } = setup(backend, tally);
    deps.log.error(`oops ${SECRET} Bearer ${TOKEN}`);
    await runOnce(deps);
    const all = lines.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('<ENVELOPE');
    expect(all).not.toContain('1234.50');
    expect(all).toContain('Result delivered');
  });
});
