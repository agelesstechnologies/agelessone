/**
 * Sends text messages (sign-in codes) to a login phone. Chosen in backend/.env:
 *   SMS_PROVIDER = console (default, development: printed to the server console, number masked)
 *                | memory  (tests: kept in memory, read with sentSms())
 * A real provider (MSG91, Fast2SMS, Twilio …) is added here once one is chosen; India needs DLT registration
 * (sender ID and an approved template) first. Never logs a full phone number.
 */
export interface Sms { to: string; text: string }

const memory: Sms[] = [];

/** "+919876543210" → "******3210" */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `******${digits.slice(-4)}`;
}

export async function sendSms(sms: Sms, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const provider = (env.SMS_PROVIDER ?? 'console').trim().toLowerCase();
  if (provider === 'memory') { memory.push(sms); return; }
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
