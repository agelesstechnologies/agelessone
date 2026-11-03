import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { AppError, ErrorBody } from './app-error';

const CODES: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'TOO_LARGE' };

/** Every error leaves the API as { code, message, details? }. Unknown errors become 500 without internals. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<{ status(code: number): { json(body: ErrorBody): void } }>();
    if (err instanceof AppError) {
      return res.status(err.status).json({ code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) });
    }
    if (err instanceof HttpException) {
      const status = err.getStatus();
      return res.status(status).json({ code: CODES[status] ?? `HTTP_${status}`, message: err.message });
    }
    this.logger.error(err instanceof Error ? err.stack : String(err));
    return res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong' });
  }
}
