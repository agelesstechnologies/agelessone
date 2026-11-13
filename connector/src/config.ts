import { readFileSync } from 'node:fs';

export interface Config {
  /** The Ageless API, e.g. https://api.example.com/api. HTTPS only (a local address may use http, for development). */
  apiUrl: string;
  clientId: string;
  /** Never logged, never put in an error message. */
  secret: string;
  /** Tally on this PC. Must be a local address: vouchers never travel over plain HTTP across a network. */
  tallyUrl: string;
  pollSeconds: number;
  /** How long to wait for Tally's answer to an import before the result is "in doubt". */
  tallyTimeoutSeconds: number;
  stateFile: string;
}

export class ConfigError extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const num = (v: string | undefined, fallback: number, min: number, name: string): number => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`${name} must be a number of at least ${min}`);
  return n;
};

/**
 * Settings come from environment variables (set on the Windows service). The secret comes from a file
 * (CONNECTOR_SECRET_FILE, which only the service account can read) or, for tests, CONNECTOR_SECRET.
 * Messages here never repeat the secret.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): Config {
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new ConfigError(`${name} is not set`);
    return v;
  };
  let api: URL;
  try { api = new URL(need('ATPL_API_URL')); } catch (e) { throw e instanceof ConfigError ? e : new ConfigError('ATPL_API_URL is not a valid address'); }
  if (api.protocol !== 'https:' && !(api.protocol === 'http:' && LOOPBACK.has(api.hostname))) throw new ConfigError('ATPL_API_URL must start with https:// (http:// is allowed only for a local address)');
  let tally: URL;
  try { tally = new URL(env.TALLY_URL?.trim() || 'http://localhost:9000'); } catch { throw new ConfigError('TALLY_URL is not a valid address'); }
  if (tally.protocol !== 'http:' || !LOOPBACK.has(tally.hostname)) throw new ConfigError('TALLY_URL must be http://localhost:<port> (Tally runs on this PC)');

  let secret = env.CONNECTOR_SECRET?.trim() ?? '';
  const file = env.CONNECTOR_SECRET_FILE?.trim();
  if (file) {
    try { secret = readFile(file).trim(); } catch { throw new ConfigError('CONNECTOR_SECRET_FILE could not be read'); }
  }
  if (!secret) throw new ConfigError('Set CONNECTOR_SECRET_FILE (a file holding the secret)');
  return {
    apiUrl: api.toString().replace(/\/+$/, ''), clientId: need('CONNECTOR_CLIENT_ID'), secret, tallyUrl: tally.toString().replace(/\/+$/, ''),
    pollSeconds: num(env.POLL_SECONDS, 60, 10, 'POLL_SECONDS'), tallyTimeoutSeconds: num(env.TALLY_TIMEOUT_SECONDS, 120, 5, 'TALLY_TIMEOUT_SECONDS'),
    stateFile: env.STATE_FILE?.trim() || 'connector-state.json',
  };
}
