import { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { ZodType, ZodTypeDef } from 'zod';
import { AppError } from './app-error';

const WHERE: Record<string, string> = { body: 'request body', query: 'query string', param: 'path' };

/**
 * Validates a request body, query string or path parameter with a Zod schema and returns the parsed value.
 * Use: @Body(new ZodValidationPipe(MySchema)) or @Query(new ZodValidationPipe(MyQuery)).
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  /** Public so the OpenAPI document can show what each route accepts. */
  constructor(readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown, meta: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError('VALIDATION', 400, `Invalid ${WHERE[meta.type] ?? 'input'}`, details);
  }
}
