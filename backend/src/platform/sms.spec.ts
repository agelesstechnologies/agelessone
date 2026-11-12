import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendSms, whatsAppNumber } from './sms';

// fictional number, token and code (never real staff data)
const PHONE = '+91 90000 12345';
const TOKEN = 'test-token-abc';
const CODE = '482913';
const env = (more: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ SMS_PROVIDER: 'whatsapp', WHATSAPP_PHONE_ID: '1234567890', WHATSAPP_TOKEN: TOKEN, ...more });

function fakeFetch(status = 200, answer: unknown = { messages: [{ id: 'wamid.x' }] }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } }));
}
const sentBody = (f: ReturnType<typeof fakeFetch>) => JSON.parse(f.mock.calls[0][1]!.body as string);

afterEach(() => { vi.restoreAllMocks(); });

describe('whatsAppNumber', () => {
  it('digits only with the country code; a 10-digit Indian number gets 91', () => {
    expect(whatsAppNumber('+91 90000-12345')).toBe('919000012345');
    expect(whatsAppNumber('9000012345')).toBe('919000012345');
    expect(whatsAppNumber('09000012345')).toBe('919000012345');
    expect(whatsAppNumber('+971 50 123 4567')).toBe('971501234567');
  });

  it('a number starting with + keeps its own country code, even with 10 digits', () => {
    expect(whatsAppNumber('+65 9123 4567')).toBe('6591234567');
    expect(whatsAppNumber(' +6591234567')).toBe('6591234567');
  });
});

describe('sendSms with SMS_PROVIDER=whatsapp', () => {
  it('a code goes as the Authentication template: body text and copy-code button', async () => {
    const f = fakeFetch();
    await sendSms({ to: PHONE, text: `${CODE} is your code`, code: CODE }, env(), f);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://graph.facebook.com/v23.0/1234567890/messages');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(sentBody(f)).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '919000012345', type: 'template',
      template: {
        name: 'ageless_auth_code', language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: CODE }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: CODE }] },
        ],
      },
    });
  });

  it('template name, language and API version come from settings', async () => {
    const f = fakeFetch();
    await sendSms({ to: PHONE, text: 'x', code: CODE },
      env({ WHATSAPP_CODE_TEMPLATE: 'my_code', WHATSAPP_TEMPLATE_LANG: 'en_GB', WHATSAPP_API_VERSION: 'v22.0' }), f);
    expect(f.mock.calls[0][0]).toBe('https://graph.facebook.com/v22.0/1234567890/messages');
    expect(sentBody(f).template).toMatchObject({ name: 'my_code', language: { code: 'en_GB' } });
  });

  it('hello_world (connection test) goes in en_US with no parameters, so the code is not in it', async () => {
    const f = fakeFetch();
    await sendSms({ to: PHONE, text: 'x', code: CODE }, env({ WHATSAPP_CODE_TEMPLATE: 'hello_world' }), f);
    expect(sentBody(f).template).toEqual({ name: 'hello_world', language: { code: 'en_US' } });
  });

  it('a message without a code is skipped (masked number only) unless a welcome template is set', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const f = fakeFetch();
    await sendSms({ to: PHONE, text: 'Your account is ready' }, env(), f);
    expect(f).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toContain('******2345');
    expect(log.mock.calls[0][0]).not.toContain('9000012345');

    await sendSms({ to: PHONE, text: 'Your account is ready' }, env({ WHATSAPP_WELCOME_TEMPLATE: 'ageless_welcome' }), f);
    expect(sentBody(f).template).toEqual({ name: 'ageless_welcome', language: { code: 'en' } });
  });

  it('a missing setting is named, without any value', async () => {
    const f = fakeFetch();
    await expect(sendSms({ to: PHONE, text: 'x', code: CODE }, env({ WHATSAPP_TOKEN: '' }), f))
      .rejects.toThrow('WHATSAPP_TOKEN must be set when SMS_PROVIDER=whatsapp');
    await expect(sendSms({ to: PHONE, text: 'x', code: CODE }, { SMS_PROVIDER: 'whatsapp', WHATSAPP_TOKEN: TOKEN }, f))
      .rejects.toThrow('WHATSAPP_PHONE_ID must be set');
    expect(f).not.toHaveBeenCalled();
  });

  it("Meta's error code and message, and nothing secret: no number, token, code or whole answer", async () => {
    const f = fakeFetch(400, { error: {
      message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', code: 131030,
      error_data: { details: `Recipient 919000012345 is not allowed; code ${CODE}` }, fbtrace_id: 'trace123',
    } });
    const err = await sendSms({ to: PHONE, text: `${CODE} is your code`, code: CODE }, env(), f).catch((e: Error) => e);
    expect((err as Error).message).toBe('WhatsApp send failed (131030): Recipient phone number not in allowed list');
    for (const secret of ['9000012345', TOKEN, CODE, 'trace123', 'OAuthException']) expect((err as Error).message).not.toContain(secret);
  });

  it('digit runs in an error message are hidden; an answer that is not JSON gives the HTTP status', async () => {
    const leaky = fakeFetch(400, { error: { code: 100, message: `Invalid parameter: to 919000012345 code ${CODE}` } });
    await expect(sendSms({ to: PHONE, text: 'x', code: CODE }, env(), leaky))
      .rejects.toThrow('WhatsApp send failed (100): Invalid parameter: to [number] code [number]');
    const html = vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(sendSms({ to: PHONE, text: 'x', code: CODE }, env(), html)).rejects.toThrow('WhatsApp send failed (HTTP 502): no details');
  });

  it('a timeout or network error says so, nothing more', async () => {
    const timeout = vi.fn(async () => { throw Object.assign(new Error(`aborted ${TOKEN}`), { name: 'TimeoutError' }); });
    await expect(sendSms({ to: PHONE, text: 'x', code: CODE }, env(), timeout)).rejects.toThrow(/^WhatsApp send failed: timeout$/);
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(sendSms({ to: PHONE, text: 'x', code: CODE }, env(), down)).rejects.toThrow(/^WhatsApp send failed: network error$/);
  });
});
