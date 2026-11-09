import { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import { ZodType, ZodTypeDef } from 'zod';
import { fieldLabel, friendlyErrorMap, issuesText } from '@ageless/shared';
import { AppError } from './app-error';

const WHERE: Record<string, string> = { body: 'request body', query: 'query string', param: 'path' };

/**
 * Validates a request body, query string or path parameter with a Zod schema and returns the parsed value.
 * Use: @Body(new ZodValidationPipe(MySchema)) or @Query(new ZodValidationPipe(MyQuery)).
 * A refusal says what is wrong in plain words ("Title must have at least 3 characters"), and lists every field in details.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  /** Public so the OpenAPI document can show what each route accepts. */
  constructor(readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown, meta: ArgumentMetadata): T {
    const result = this.schema.safeParse(value, { errorMap: friendlyErrorMap });   // explicit: the same plain messages even where another copy of zod is loaded
    if (result.success) return result.data;
    const issues = result.error.issues;
    const details = issues.map((i) => ({ path: i.path.join('.'), field: fieldLabel(i.path), message: i.message }));
    if (meta.type === 'param') {                   // a broken link or bookmark: the id in the address is not a record id
      throw new AppError('VALIDATION', 400, 'This link is not valid: the record id in it is wrong. Go back to the list and open the record again.', details);
    }
    const text = issuesText(issues);
    throw new AppError('VALIDATION', 400, meta.type === 'body' ? text : `Invalid ${WHERE[meta.type] ?? 'input'}: ${text}`, details);
  }
}
