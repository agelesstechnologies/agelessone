import { randomUUID } from 'node:crypto';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { AppError, ErrorBody } from './app-error';

const CODES: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT', 413: 'TOO_LARGE', 415: 'UNSUPPORTED_TYPE', 429: 'TOO_MANY_REQUESTS', 503: 'UNAVAILABLE' };

/** Plain-language messages for HTTP errors raised by the framework (unknown route, wrong method, file too large …). */
const PLAIN: Record<number, string> = {
  401: 'Please sign in again.',
  403: 'You do not have permission to do this.',
  404: 'Not found: the record does not exist or you cannot see it.',
  405: 'This action is not allowed here.',
  413: 'The upload is too large. Choose a smaller file.',
  415: 'This file type is not accepted.',
  429: 'Too many tries. Wait a little and try again.',
};

type PgError = { code: string; message: string; constraint?: string; column?: string; table?: string };
type Mapped = { status: number; body: ErrorBody };

/** The PostgreSQL error inside a Drizzle / pg error (Drizzle wraps it in `cause`). */
function pgError(err: unknown): PgError | undefined {
  for (let e = err as Partial<PgError> & { cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && typeof e.message === 'string') return e as PgError;
  }
  return undefined;
}

/** "punch in refused" → "Punch in refused." */
const sentence = (s: string) => { const t = s.trim(); return t[0]!.toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? "" : "."); };

/** "employment_id" / "uq_people_login_email" → "employment" / "people login email" (constraint and column names only, never values). */
const words = (name: string) => name.replace(/^(uq|ux|fk|ck|chk|pk)_/i, '').replace(/_(id|key|fkey|check|unique|idx)$/i, '').replace(/_/g, ' ');

/**
 * Database errors as answers the user can act on. The PostgreSQL `detail` is never sent or logged: it holds the
 * values (phone numbers, emails …). Only the constraint or column name is used.
 */
function fromDatabase(pg: PgError): Mapped | undefined {
  const rule = pg.constraint ? ` (${words(pg.constraint)})` : '';
  const ownCode = /^([A-Z][A-Z0-9_]{2,}):\s*(.+)$/s.exec(pg.message);   // our own triggers: RAISE EXCEPTION 'CODE: message'
  switch (pg.code) {
    case '23505': return { status: 409, body: { code: 'DUPLICATE', message: `This already exists${rule}. Check for an existing record instead of adding it again.`, details: { constraint: pg.constraint } } };
    case '23503': return { status: 409, body: { code: 'IN_USE_OR_MISSING', message: `This refers to a record that does not exist, or the record is still in use${rule}.`, details: { constraint: pg.constraint } } };
    case '23514': return { status: 400, body: { code: 'NOT_ALLOWED_VALUE', message: `A value breaks a rule${rule}. Check the dates, amounts and choices.`, details: { constraint: pg.constraint } } };
    case '23502': return { status: 400, body: { code: 'REQUIRED', message: `${pg.column ? words(pg.column) : 'A required value'} is missing.`, details: { column: pg.column } } };
    case '22001': return { status: 400, body: { code: 'TOO_LONG', message: 'A value is too long. Shorten the text and try again.' } };
    case '22003': return { status: 400, body: { code: 'OUT_OF_RANGE', message: 'A number is too large or too small.' } };
    case '22007': case '22008': return { status: 400, body: { code: 'BAD_DATE', message: 'A date or time is not valid.' } };
    case '22P02': return { status: 400, body: { code: 'BAD_VALUE', message: 'A value has the wrong format (for example an id, number or date).' } };
    case '40001': case '40P01': return { status: 503, body: { code: 'BUSY', message: 'Someone else changed this at the same moment. Try again.' } };
    case '57014': return { status: 503, body: { code: 'TIMEOUT', message: 'The server took too long. Try again, or narrow the search.' } };
    case 'P0001': case '23001':                                       // raised by our own rules (triggers): the message is ours
      return ownCode ? { status: 409, body: { code: ownCode[1]!, message: sentence(ownCode[2]!) } } : { status: 409, body: { code: 'NOT_ALLOWED', message: pg.message } };
  }
  if (pg.code.startsWith('08') || pg.code === '57P01' || pg.code === '53300') {
    return { status: 503, body: { code: 'DATABASE_UNAVAILABLE', message: 'The database is not reachable right now. Try again in a minute.' } };
  }
  return undefined;
}

/** Errors from the HTTP layer below Nest (body-parser): malformed JSON, body too large. */
function fromHttpLayer(err: unknown): Mapped | undefined {
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown };
  if (e?.type === 'entity.parse.failed') return { status: 400, body: { code: 'BAD_JSON', message: 'The request body is not valid JSON.' } };
  if (e?.type === 'entity.too.large') return { status: 413, body: { code: 'TOO_LARGE', message: PLAIN[413]! } };
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : undefined;
  if (status && status >= 400 && status < 500 && e.expose === true) {
    return { status, body: { code: CODES[status] ?? `HTTP_${status}`, message: typeof e.message === 'string' ? e.message : PLAIN[status] ?? 'Bad request' } };
  }
  if (typeof (err as { code?: unknown })?.code === 'string' && ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes((err as { code: string }).code)) {
    return { status: 503, body: { code: 'DATABASE_UNAVAILABLE', message: 'The database is not reachable right now. Try again in a minute.' } };
  }
  return undefined;
}

/** Nest's own exceptions: keep their message when it says something, else a plain one. */
function fromNest(err: HttpException): Mapped {
  const status = err.getStatus();
  const r = err.getResponse() as string | { message?: unknown };
  const raw = typeof r === 'string' ? r : Array.isArray(r?.message) ? r.message.join('; ') : typeof r?.message === 'string' ? r.message : err.message;
  const generic = !raw || /^(Http Exception|Bad Request|Forbidden( resource)?|Not Found|Unauthorized|Payload Too Large|File too large|Too Many Requests)$/i.test(raw);
  if (status === 400 && /JSON|Unexpected (end|token)/.test(raw)) return { status, body: { code: 'BAD_JSON', message: 'The request body is not valid JSON.' } };
  const message = status === 404 && /^Cannot (GET|POST|PUT|PATCH|DELETE) /.test(raw) ? `This address does not exist on the server: ${raw.slice(7)}`
    : generic ? PLAIN[status] ?? raw ?? 'Request refused' : raw;
  return { status, body: { code: CODES[status] ?? `HTTP_${status}`, message } };
}

/**
 * Every error leaves the API as { code, message, details? }, with a message a person can act on.
 * - our own AppErrors as they are;
 * - database errors (duplicate, missing reference, rule broken, our triggers' 'CODE: message') as 400/409/503;
 * - anything unknown as 500 with a short reference that is also in the server log, so it can be traced.
 * Logs carry the method and path only (never the query string or body: they can hold phone numbers).
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(err: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse<{ headersSent?: boolean; status(code: number): { json(body: ErrorBody): void }; setHeader(k: string, v: string): void }>();
    const req = http.getRequest<{ method?: string; url?: string } | undefined>();
    const where = `${req?.method ?? '?'} ${(req?.url ?? '').split('?')[0]}`;
    if (res.headersSent) { this.logger.error(`${where}: error after the answer was sent`); return; }

    if (err instanceof AppError) {
      const retry = (err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      if (err.status === 429 && typeof retry === 'number') res.setHeader('Retry-After', String(retry));
      return res.status(err.status).json({ code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) });
    }
    if (err instanceof HttpException) {
      const { status, body } = fromNest(err);
      return res.status(status).json(body);
    }
    const pg = pgError(err);
    const mapped = (pg && fromDatabase(pg)) ?? fromHttpLayer(err);
    if (mapped) {
      if (mapped.status >= 500 || pg) this.logger.warn(`${where}: ${mapped.body.code}${pg ? ` (pg ${pg.code}${pg.constraint ? ` ${pg.constraint}` : ''})` : ''}`);
      return res.status(mapped.status).json(mapped.body);
    }
    const reference = randomUUID().slice(0, 8);
    this.logger.error(`[${reference}] ${where}: ${err instanceof Error ? err.stack : String(err)}`);
    return res.status(500).json({ code: 'INTERNAL', message: `Something went wrong on the server. If it happens again, give this reference to support: ${reference}`,
      details: { reference } });
  }
}
