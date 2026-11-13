import { MachineTokenResponse, Outbox, TallyMappingAck, TallyResultAck, type TallyMappingReport, type TallyResultReport } from '@ageless/shared';
import type { Redactor } from './log';

/** An answer the API gave (its own message is safe to show) or a failure to reach it (status 0). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

/** What the run needs from the Ageless API. */
export interface BackendPort {
  outbox(): Promise<Outbox>;
  postResult(report: TallyResultReport): Promise<TallyResultAck>;
  postMappingReport(report: TallyMappingReport): Promise<TallyMappingAck>;
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Ask for a new token a little before the old one ends. */
const REFRESH_BEFORE_MS = 60_000;

/**
 * Signs in with the machine credential and calls the three connector routes. The token is kept in memory only. One 401 triggers
 * one new sign-in and one retry (the token may have just ended, or the credential may have been revoked: then sign-in fails too).
 */
export class BackendClient implements BackendPort {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: { apiUrl: string; clientId: string; secret: string },
    private readonly redactor: Redactor,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.redactor.add(cfg.secret);
  }

  outbox() { return this.call('GET', '/accounts/tally/outbox', undefined, (j) => Outbox.parse(j)); }
  postResult(report: TallyResultReport) { return this.call('POST', '/accounts/tally/results', report, (j) => TallyResultAck.parse(j)); }
  postMappingReport(report: TallyMappingReport) { return this.call('POST', '/accounts/tally/mapping-report', report, (j) => TallyMappingAck.parse(j)); }

  private async signIn(): Promise<string> {
    const res = await this.send('POST', '/auth/machine-token', { clientId: this.cfg.clientId, secret: this.cfg.secret }, null);
    const body = MachineTokenResponse.parse(res);
    this.redactor.add(body.token);
    this.token = { value: body.token, expiresAt: Date.parse(body.expiresAt) };
    return body.token;
  }

  private async bearer(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now() > REFRESH_BEFORE_MS) return this.token.value;
    return this.signIn();
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: unknown, parse: (json: unknown) => T): Promise<T> {
    try { return parse(await this.send(method, path, body, await this.bearer())); }
    catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      this.token = null;                                            // sign in again, once
      return parse(await this.send(method, path, body, await this.signIn()));
    }
  }

  private async send(method: 'GET' | 'POST', path: string, body: unknown, token: string | null): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.apiUrl}${path}`, {
        method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new ApiError('The Ageless API could not be reached', 0); }
    let json: unknown = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const e = (json ?? {}) as { code?: string; message?: string };
      throw new ApiError(typeof e.message === 'string' ? e.message.slice(0, 300) : `The API answered ${res.status}`, res.status, typeof e.code === 'string' ? e.code : undefined);
    }
    return json;
  }
}
