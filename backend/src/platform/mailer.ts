import nodemailer from 'nodemailer';

/**
 * Sends plain-text emails (sign-in codes). Chosen in backend/.env:
 *   EMAIL_PROVIDER = console (default, development: printed to the server console, address masked)
 *                  | smtp    (real email: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, MAIL_FROM)
 *                  | memory  (tests: kept in memory, read with sentMail())
 * Never logs a full address or a password; the console provider is for development only.
 */
export interface Mail { to: string; subject: string; text: string }

const memory: Mail[] = [];
let transport: nodemailer.Transporter | undefined;

/** "asha.kumar@ageless.in" → "as***@ageless.in" */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain ?? ''}`;
}

export async function sendMail(mail: Mail, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const provider = (env.EMAIL_PROVIDER ?? 'console').trim().toLowerCase();
  if (provider === 'memory') { memory.push(mail); return; }
  if (provider === 'smtp') {
    transport ??= nodemailer.createTransport({
      host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 587), secure: env.SMTP_SECURE === 'true',
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
    await transport.sendMail({ from: env.MAIL_FROM ?? env.SMTP_USER, to: mail.to, subject: mail.subject, text: mail.text });
    return;
  }
  // development: the code is shown so a developer can sign in without a mailbox
  console.log(`[mail to ${maskEmail(mail.to)}] ${mail.subject}\n${mail.text}`);
}

/**
 * Why a send failed, safe to log: nodemailer's error code and the SMTP reply code only ("EENVELOPE, SMTP 550").
 * Never the server's own text: it can repeat the full address.
 */
export function mailFailure(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown; name?: unknown };
  const kind = typeof e.code === 'string' ? e.code : typeof e.name === 'string' ? e.name : 'unknown error';
  return typeof e.responseCode === 'number' ? `${kind}, SMTP ${e.responseCode}` : kind;
}

/** Tests (EMAIL_PROVIDER=memory): emails sent so far, newest last. */
export function sentMail(): readonly Mail[] { return memory; }
