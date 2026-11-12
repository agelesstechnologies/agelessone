/**
 * Sends text messages (sign-in codes) to a login phone. Chosen in backend/.env:
 *   SMS_PROVIDER = console  (default, development: printed to the server console, number masked)
 *                | memory   (tests: kept in memory, read with sentSms())
 *                | whatsapp (Meta's WhatsApp Cloud API: WHATSAPP_PHONE_ID, WHATSAPP_TOKEN, WHATSAPP_CODE_TEMPLATE …)
 * WhatsApp accepts only approved templates for messages we start, so a sign-in code goes as an Authentication template
 * (the `code` field) and a message without a code goes only when WHATSAPP_WELCOME_TEMPLATE is set.
 * A real SMS provider (MSG91, Fast2SMS, Twilio …) needs DLT registration in India first.
 * Never logs a full phone number, the token or the code.
 */
export interface Sms {
  to: string;
  text: string;
  /** The 6-digit sign-in code inside `text`, when there is one (WhatsApp sends it in a template). */
  code?: string;
}

const memory: Sms[] = [];

/** "+919876543210" → "******3210" */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `******${digits.slice(-4)}`;
}

export async function sendSms(sms: Sms, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<void> {
  const provider = (env.SMS_PROVIDER ?? 'console').trim().toLowerCase();
  if (provider === 'memory') { memory.push(sms); return; }
  if (provider === 'whatsapp') { await sendWhatsApp(sms, whatsAppSettings(env), fetchFn); return; }
  if (provider !== 'console') throw new Error(`SMS_PROVIDER ${provider} is not set up yet`);
  console.log(`[sms to ${maskPhone(sms.to)}] ${sms.text}`);
}

/** Tests (SMS_PROVIDER=memory): messages sent so far, newest last. */
export function sentSms(): readonly Sms[] { return memory; }

/**
 * Development only: show sign-in codes in the app (DEV_SHOW_CODES=true and not production), so testing needs no
 * mailbox or SMS provider. Never set on a real server: anyone could read anyone's code.
 */
export function showCodesInApp(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEV_SHOW_CODES === 'true' && env.NODE_ENV !== 'production';
}

// ---- WhatsApp Cloud API ----

export interface WhatsAppSettings {
  phoneId: string; token: string; codeTemplate: string; language: string; apiVersion: string;
  welcomeTemplate?: string; timeoutMs: number;
}

/** The settings from backend/.env. WHATSAPP_PHONE_ID and WHATSAPP_TOKEN are required; the error names a missing one, never a value. */
export function whatsAppSettings(env: NodeJS.ProcessEnv = process.env): WhatsAppSettings {
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} must be set when SMS_PROVIDER=whatsapp`);
    return v;
  };
  return {
    phoneId: need('WHATSAPP_PHONE_ID'), token: need('WHATSAPP_TOKEN'),
    codeTemplate: env.WHATSAPP_CODE_TEMPLATE?.trim() || 'ageless_auth_code',
    language: env.WHATSAPP_TEMPLATE_LANG?.trim() || 'en',
    apiVersion: env.WHATSAPP_API_VERSION?.trim() || 'v23.0',
    welcomeTemplate: env.WHATSAPP_WELCOME_TEMPLATE?.trim() || undefined,
    timeoutMs: Number(env.WHATSAPP_TIMEOUT_MS) > 0 ? Number(env.WHATSAPP_TIMEOUT_MS) : 8000,
  };
}

/**
 * The number as WhatsApp wants it: digits only with the country code. "+91 98765 43210", "09876543210", "9876543210" →
 * "919876543210". A number starting with + already has its country code, so it is kept ("+65 9123 4567" → "6591234567").
 */
export function whatsAppNumber(phone: string): string {
  const hasCountry = phone.trim().startsWith('+');
  const digits = phone.replace(/\D/g, '');
  if (!hasCountry && digits.length === 10) return `91${digits}`;           // Indian mobile without the country code
  if (!hasCountry && digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

/**
 * The request body for one message, or null when WhatsApp cannot carry it (no code and no welcome template).
 * hello_world is Meta's ready-made test template: it proves the connection but does NOT carry the code.
 */
export function whatsAppPayload(sms: Sms, s: WhatsAppSettings): Record<string, unknown> | null {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: whatsAppNumber(sms.to), type: 'template' };
  if (sms.code) {
    if (s.codeTemplate === 'hello_world') return { ...base, template: { name: 'hello_world', language: { code: 'en_US' } } };
    return {
      ...base,
      template: {
        name: s.codeTemplate, language: { code: s.language },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: sms.code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: sms.code }] },  // copy-code button
        ],
      },
    };
  }
  if (!s.welcomeTemplate) return null;
  return { ...base, template: { name: s.welcomeTemplate, language: { code: s.language } } };
}

/**
 * One message through the Cloud API. Throws "WhatsApp send failed (<Meta code>): <Meta message>" on an error answer;
 * the error never carries the number, the token, the code or Meta's whole answer.
 */
async function sendWhatsApp(sms: Sms, s: WhatsAppSettings, fetchFn: typeof fetch): Promise<void> {
  const body = whatsAppPayload(sms, s);
  if (!body) {
    console.log(`[whatsapp to ${maskPhone(sms.to)}] not sent: free text is not allowed; set WHATSAPP_WELCOME_TEMPLATE to send it`);
    return;
  }
  if ((body.to as string).length < 8) throw new Error('WhatsApp send failed: the login phone is not a full number');
  let res: Response;
  try {
    res = await fetchFn(`https://graph.facebook.com/${s.apiVersion}/${s.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(s.timeoutMs),
    });
  } catch (err) {
    throw new Error(`WhatsApp send failed: ${err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
  }
  if (res.ok) return;
  let answer: { error?: { code?: unknown; message?: unknown } } = {};
  try { answer = await res.json() as typeof answer; } catch { /* not JSON: the HTTP status is enough */ }
  const metaCode = answer.error?.code;
  const metaMessage = answer.error?.message;
  const code = typeof metaCode === 'number' ? metaCode : `HTTP ${res.status}`;
  const message = typeof metaMessage === 'string' ? cleanMetaMessage(metaMessage) : 'no details';
  throw new Error(`WhatsApp send failed (${code}): ${message}`);
}

/** Meta's message without its "(#131030) " prefix, any long digit run (a number or a code) and anything past 200 characters. */
function cleanMetaMessage(message: string): string {
  return message.replace(/^\(#\d+\)\s*/, '').replace(/\d{6,}/g, '[number]').slice(0, 200) || 'no details';
}
