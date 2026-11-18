import { z, ZodTypeAny } from 'zod';
import { friendlyErrorMap, ImportProblem } from '@ageless/shared';
import { readCsvTable } from '../../../platform/csv';
import { AppError } from '../../../platform/http/app-error';

/** The uploaded file as multer keeps it in memory. */
export interface CsvUpload { buffer: Buffer; size: number }
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_CSV_ROWS = 5000;

export interface CsvRows<T> {
  valid: { row: number; data: T }[];
  /** rows that broke the column rules, with their raw cells (an import may still skip them as duplicates) */
  invalid: { row: number; values: Record<string, string>; problems: ImportProblem[] }[];
}

/**
 * Reads an uploaded CSV (UTF-8; header row first, columns by name, extra columns ignored) and checks every row against
 * the row schema. Refuses a missing file, a file that is not text, missing required columns, and empty or oversized files.
 */
export function readCsvRows<S extends ZodTypeAny>(file: CsvUpload | undefined, schema: S, columns: readonly string[], required: string[]): CsvRows<z.infer<S>> {
  if (!file) throw new AppError('INVENTORY_IMPORT_NO_FILE', 400, 'Attach the CSV file (form field "file")');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
  } catch {
    text = '\u0000';
  }
  if (text.includes('\u0000')) throw new AppError('INVENTORY_IMPORT_NOT_CSV', 400, 'This is not a CSV file: save the spreadsheet as "CSV UTF-8" and try again');
  const table = readCsvTable(text);
  const missing = required.filter((c) => !table.columns.includes(c));
  if (missing.length) {
    throw new AppError('INVENTORY_IMPORT_INVALID', 400, `The header row needs the column${missing.length > 1 ? 's' : ''} ${missing.join(', ')}. Nothing was imported.`,
      missing.map((c) => ({ row: 1, field: c, message: 'Missing column' })));
  }
  if (table.rows.length === 0) throw new AppError('INVENTORY_IMPORT_EMPTY', 400, 'The file has no rows below the header');
  if (table.rows.length > MAX_CSV_ROWS) throw new AppError('INVENTORY_IMPORT_TOO_LARGE', 400, `Import at most ${MAX_CSV_ROWS} rows at a time`);

  const out: CsvRows<z.infer<S>> = { valid: [], invalid: [] };
  for (const { row, values } of table.rows) {
    const known = Object.fromEntries(columns.filter((c) => c in values).map((c) => [c, values[c]]));
    const parsed = schema.safeParse(known, { errorMap: friendlyErrorMap });
    if (parsed.success) out.valid.push({ row, data: parsed.data });
    else out.invalid.push({ row, values: known, problems: parsed.error.issues.map((i) => ({ row, field: String(i.path[0] ?? ''), message: i.message })) });
  }
  return out;
}

/** The refusal of a whole file: the first problem in words, every problem in details. */
export function refuseFile(problems: ImportProblem[]): AppError {
  const sorted = [...problems].sort((a, b) => a.row - b.row);
  const more = sorted.length > 1 ? ` (and ${sorted.length - 1} more)` : '';
  return new AppError('INVENTORY_IMPORT_INVALID', 400, `Row ${sorted[0].row}: ${sorted[0].message}${more}. Nothing was imported.`, sorted);
}
