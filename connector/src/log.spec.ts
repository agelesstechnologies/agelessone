import { describe, expect, it } from 'vitest';
import { Redactor, createLogger, errorText } from './log';

describe('logging never leaks a secret', () => {
  const lines: string[] = [];
  const redactor = new Redactor();
  redactor.add('mcs_super-secret-value');
  redactor.add('eyJhbGciOi.token.value');
  const log = createLogger(redactor, (l) => lines.push(l), () => new Date('2036-01-02T03:04:05Z'));

  it('replaces the client secret, a token the API gave, and anything shaped like a bearer token or an Ageless secret', () => {
    log.info('signed in with mcs_super-secret-value');
    log.warn('Authorization: Bearer eyJhbGciOi.token.value', { token: 'eyJhbGciOi.token.value' });
    log.error('retrying with Bearer abc.DEF-123_xyz and mcs_another-secret-not-registered');
    const all = lines.join('\n');
    for (const leaked of ['mcs_super-secret-value', 'eyJhbGciOi.token.value', 'abc.DEF-123_xyz', 'mcs_another-secret-not-registered']) expect(all).not.toContain(leaked);
    expect(all).toContain('[redacted]');
    expect(lines[0]).toBe('2036-01-02T03:04:05.000Z INFO signed in with [redacted]');
  });

  it('short strings are not registered (they would blank ordinary words), and errorText shows the message only', () => {
    const r = new Redactor();
    r.add('abc');
    expect(r.clean('abc stays')).toBe('abc stays');
    const e = new Error('boom'); e.stack = 'Error: boom\n    at secret-path';
    expect(errorText(e)).toBe('boom');
    expect(errorText('not an error')).toBe('unknown error');
  });
});
