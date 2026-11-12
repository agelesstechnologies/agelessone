import { describe, expect, it } from 'vitest';
import { mailFailure } from './mailer';

describe('mailFailure', () => {
  it("gives the error code and SMTP reply code only, never the server's text with the address", () => {
    const rejected = Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <asha.test@example.com>: Recipient address rejected"),
      { code: 'EENVELOPE', responseCode: 550 });
    expect(mailFailure(rejected)).toBe('EENVELOPE, SMTP 550');
    expect(mailFailure(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ESOCKET' }))).toBe('ESOCKET');
    expect(mailFailure(new TypeError('boom asha.test@example.com'))).toBe('TypeError');
    expect(mailFailure(undefined)).toBe('unknown error');
  });
});
