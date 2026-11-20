import { describe, expect, it } from 'vitest';
import { ApiError, BackendClient } from './api';
import { Redactor } from './log';

const cfg = { apiUrl: 'https://api.example.com/api', clientId: 'mc_client', secret: 'mcs_the-client-secret' };
const batchId = '11111111-1111-4111-8111-111111111111';
const entryId = '22222222-2222-4222-8222-222222222222';
const outboxBody = { batches: [{ publicId: batchId, company: 'ATPL', tallyCompanyName: 'Ageless', xml: '<ENVELOPE/>', entries: [{ entryPublicId: entryId }], expectedLedgers: ['Fuel'], expectedCostCentres: [] }] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const future = (ms: number) => new Date(Date.now() + ms).toISOString();

interface Call { url: string; method: string; auth: string | null; body: unknown }
function fakeApi(script: (call: Call, n: number) => Response | Error) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const call = { url, method: init.method ?? 'GET', auth: headers.Authorization ?? null, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const out = script(call, calls.length);
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

describe('the API client', () => {
  it('signs in once with the client id and secret, then reuses the token on every call', async () => {
    const api = fakeApi((c) => c.url.endsWith('/auth/machine-token') ? json(200, { token: 'tok-1', expiresAt: future(15 * 60_000) }) : json(200, outboxBody));
    const client = new BackendClient(cfg, new Redactor(), api.fetchFn);
    expect((await client.outbox()).batches[0]!.publicId).toBe(batchId);
    await client.outbox();
    expect(api.calls.map((c) => `${c.method} ${c.url.replace(cfg.apiUrl, '')}`)).toEqual(['POST /auth/machine-token', 'GET /accounts/tally/outbox', 'GET /accounts/tally/outbox']);
    expect(api.calls[0]).toMatchObject({ auth: null, body: { clientId: 'mc_client', secret: 'mcs_the-client-secret' } });
    expect(api.calls[1]!.auth).toBe('Bearer tok-1');
  });

  it('asks for a new token shortly before the old one ends', async () => {
    let n = 0;
    const api = fakeApi((c) => c.url.endsWith('/auth/machine-token') ? json(200, { token: `tok-${++n}`, expiresAt: future(30_000) }) : json(200, outboxBody));
    const client = new BackendClient(cfg, new Redactor(), api.fetchFn);
    await client.outbox();
    await client.outbox();
    expect(api.calls.filter((c) => c.url.endsWith('/auth/machine-token'))).toHaveLength(2);   // 30 s left is under the 60 s margin
  });

  it('one 401 means one new sign-in and one retry; a second 401 is an error', async () => {
    let tokens = 0;
    const flaky = fakeApi((c, n) => c.url.endsWith('/auth/machine-token') ? json(200, { token: `tok-${++tokens}`, expiresAt: future(900_000) })
      : c.auth === 'Bearer tok-1' ? json(401, { code: 'AUTH_INVALID', message: 'This credential is no longer valid.' }) : json(200, outboxBody));
    expect((await new BackendClient(cfg, new Redactor(), flaky.fetchFn).outbox()).batches).toHaveLength(1);
    expect(tokens).toBe(2);

    const revoked = fakeApi((c) => c.url.endsWith('/auth/machine-token') ? json(401, { code: 'AUTH_FAILED', message: 'Wrong client id or secret' }) : json(401, { code: 'AUTH_INVALID', message: 'no' }));
    await expect(new BackendClient(cfg, new Redactor(), revoked.fetchFn).outbox()).rejects.toMatchObject({ status: 401, code: 'AUTH_FAILED', message: 'Wrong client id or secret' });
  });

  it('shows the API\'s own message for errors, and a plain one when it cannot be reached (never the address or the body)', async () => {
    const refused = fakeApi((c) => c.url.endsWith('/auth/machine-token') ? json(200, { token: 't-token-1', expiresAt: future(900_000) }) : json(409, { code: 'ACCOUNTS_TALLY_NOT_APPROVED', message: 'This batch is not approved' }));
    const e = await new BackendClient(cfg, new Redactor(), refused.fetchFn).postResult({ batchPublicId: batchId, outcome: 'not_posted', created: null, altered: null, errors: null, lastVchId: null, lineErrors: [], message: null }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect([e.status, e.code, e.message]).toEqual([409, 'ACCOUNTS_TALLY_NOT_APPROVED', 'This batch is not approved']);

    const down = fakeApi(() => new TypeError('fetch failed: connect ECONNREFUSED https://api.example.com/api secret mcs_the-client-secret'));
    const d = await new BackendClient(cfg, new Redactor(), down.fetchFn).outbox().catch((x) => x);
    expect([d.status, d.message]).toEqual([0, 'The Ageless API could not be reached']);
    expect(d.message).not.toContain('mcs_');
  });

  it('registers the secret and every token with the redactor', async () => {
    const redactor = new Redactor();
    const api = fakeApi((c) => c.url.endsWith('/auth/machine-token') ? json(200, { token: 'jwt.token.value', expiresAt: future(900_000) }) : json(200, outboxBody));
    await new BackendClient(cfg, redactor, api.fetchFn).outbox();
    expect(redactor.clean('a mcs_the-client-secret b jwt.token.value')).toBe('a [redacted] b [redacted]');
  });

  it('refuses an answer that is not the agreed shape', async () => {
    const api = fakeApi((c) => c.url.endsWith('/auth/machine-token') ? json(200, { token: 'tok-12345', expiresAt: future(900_000) }) : json(200, { batches: [{ publicId: 'nope' }] }));
    await expect(new BackendClient(cfg, new Redactor(), api.fetchFn).outbox()).rejects.toThrow();
  });
});
