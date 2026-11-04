import { SetMetadata } from '@nestjs/common';
import { ZodTypeAny } from 'zod';

export const API_DOC = 'api:doc';

/**
 * What the OpenAPI document says about a route beyond what the route itself declares (path, method, permission and
 * request schemas are read from the route). Every route has one; a test fails when one is missing.
 */
export interface DocOptions {
  /** One line, shown in the list of endpoints. */
  summary: string;
  /** More detail: rules, what happens, notes for the web app. */
  description?: string;
  /** The answer's shape (a schema from @ageless/shared). Omit for 204 / no body. */
  response?: ZodTypeAny;
  /** The answer is a file (PDF / JPEG / PNG), not JSON. */
  file?: boolean;
  /** The route also answers text/csv when `format=csv`. */
  csv?: boolean;
  /** The body is multipart/form-data with this file field (the other fields are the body schema). */
  multipart?: string;
  /** Also answers 200 with the stored record when the same publicId is sent again (create calls). */
  resend?: boolean;
}

/** Documents a route for /api/docs. */
export const Doc = (options: DocOptions) => SetMetadata(API_DOC, options);
