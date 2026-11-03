import { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';
import { AppError } from './app-error';

/**
 * Validates a request body or query string with a Zod schema and returns the parsed value.
 * Use: @Body(new ZodValidationPipe(MySchema)) or @Query(new ZodValidationPipe(MyQuery)).
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, meta: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const where = meta.type === 'query' ? 'query string' : 'request body';
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError('VALIDATION', 400, `Invalid ${where}`, details);
  }
}
