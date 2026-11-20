import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const base = { ATPL_API_URL: 'https://api.example.com/api/', CONNECTOR_CLIENT_ID: 'mc_abc', CONNECTOR_SECRET_FILE: 'secret.txt' };
const reads = (text: string) => () => text;
const problem = (env: NodeJS.ProcessEnv, read = reads('mcs_the-secret-value\n')): string => {
  try { loadConfig(env, read); } catch (e) { expect(e).toBeInstanceOf(ConfigError); return (e as Error).message; }
  throw new Error('did not throw');
};

describe('connector configuration', () => {
  it('reads the secret from the file, trims it, and fills the defaults', () => {
    const c = loadConfig(base, reads('mcs_the-secret-value\r\n'));
    expect(c).toMatchObject({ apiUrl: 'https://api.example.com/api', clientId: 'mc_abc', secret: 'mcs_the-secret-value', tallyUrl: 'http://localhost:9000', pollSeconds: 60, tallyTimeoutSeconds: 120, stateFile: 'connector-state.json' });
  });

  it('the API address must be HTTPS (http only for a local address, for development)', () => {
    expect(problem({ ...base, ATPL_API_URL: 'http://api.example.com/api' })).toMatch(/https/);
    expect(loadConfig({ ...base, ATPL_API_URL: 'http://localhost:3000/api' }, reads('x-secret-1')).apiUrl).toBe('http://localhost:3000/api');
    expect(problem({ ...base, ATPL_API_URL: 'not a url' })).toMatch(/valid address/);
  });

  it('Tally must be on this PC over plain http; anything else is refused', () => {
    expect(loadConfig({ ...base, TALLY_URL: 'http://127.0.0.1:9001' }, reads('s-secret-1')).tallyUrl).toBe('http://127.0.0.1:9001');
    expect(problem({ ...base, TALLY_URL: 'http://192.168.1.20:9000' })).toMatch(/localhost/);
    expect(problem({ ...base, TALLY_URL: 'https://localhost:9000' })).toMatch(/localhost/);
  });

  it('refuses missing settings, a missing secret and an unreadable secret file, without ever repeating the secret', () => {
    expect(problem({ ...base, CONNECTOR_CLIENT_ID: '' })).toMatch(/CONNECTOR_CLIENT_ID/);
    expect(problem({ ...base, CONNECTOR_SECRET_FILE: '' })).toMatch(/CONNECTOR_SECRET_FILE/);
    expect(problem(base, () => '  \n')).toMatch(/CONNECTOR_SECRET_FILE/);
    expect(problem(base, () => { throw new Error('EACCES: C:\\secret.txt mcs_the-secret-value'); })).not.toContain('mcs_the-secret-value');
    expect(problem({ ...base, POLL_SECONDS: '3' })).toMatch(/at least 10/);
    for (const env of [{ ...base, CONNECTOR_CLIENT_ID: '' }, { ...base, TALLY_URL: 'http://10.0.0.1' }]) expect(problem(env)).not.toContain('mcs_the-secret-value');
  });
});
