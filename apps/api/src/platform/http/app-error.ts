/** The one error body every endpoint returns. */
export interface ErrorBody { code: string; message: string; details?: unknown }

/** Throw this from services and pipes; the global filter turns it into an ErrorBody with this HTTP status. */
export class AppError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}
