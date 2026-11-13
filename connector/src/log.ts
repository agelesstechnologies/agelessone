/**
 * Logging that cannot leak a secret. Every line passes through a redactor that replaces the client secret, any token the
 * API gave us, and anything shaped like a bearer token or an Ageless secret. Callers also never pass voucher XML or amounts:
 * only ids and counts.
 */
export class Redactor {
  private readonly secrets = new Set<string>();

  add(secret: string | undefined): void {
    if (secret && secret.length >= 6) this.secrets.add(secret);
  }

  clean(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('[redacted]');
    return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]').replace(/\bmcs_[A-Za-z0-9_-]+/g, '[redacted]');
  }
}

export type LogLevel = 'info' | 'warn' | 'error';
export interface Logger {
  info(message: string, fields?: Record<string, string | number | boolean | null>): void;
  warn(message: string, fields?: Record<string, string | number | boolean | null>): void;
  error(message: string, fields?: Record<string, string | number | boolean | null>): void;
}

export function createLogger(redactor: Redactor, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`), now: () => Date = () => new Date()): Logger {
  const line = (level: LogLevel) => (message: string, fields?: Record<string, string | number | boolean | null>) =>
    write(redactor.clean(`${now().toISOString()} ${level.toUpperCase()} ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`));
  return { info: line('info'), warn: line('warn'), error: line('error') };
}

/** A caught error as text that is safe to log: the message only (never a stack, never request data). */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'unknown error').slice(0, 300);
