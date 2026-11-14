/**
 * A CSV file for reports: a few "label, value" lines saying what the report is (period, company, when produced),
 * a blank line, then the table. UTF-8 with a byte-order mark so Excel shows names correctly.
 * Text that a spreadsheet would run as a formula (starting with = + - @) is prefixed with ' .
 */
export function toCsv(about: [string, string][], header: string[], rows: (string | number | boolean | null)[][]): string {
  const lines = [...about.map((a) => a.map(cell).join(',')), '', header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

function cell(v: string | number | boolean | null): string {
  if (v === null) return '';
  if (typeof v !== 'string') return String(v);
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Paise as rupees with two decimals, exactly (no floating point): 123456 → "1234.56". */
export function rupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Reads CSV text (RFC 4180: quoted fields may hold commas, quotes as "" and line breaks; CRLF or LF; a UTF-8 byte-order
 * mark is dropped) into records of fields.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      record.push(field); records.push(record); record = []; field = '';
    } else field += ch;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  return records;
}

/**
 * A CSV table: the first record is the header (names compared in lower case, spaces and hyphens read as _), each later
 * record a row keyed by those names. Rows carry their spreadsheet number (the header is row 1); empty rows are left out.
 */
export function readCsvTable(text: string): { columns: string[]; rows: { row: number; values: Record<string, string> }[] } {
  const [header = [], ...records] = parseCsv(text);
  const columns = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const rows = records.flatMap((fields, i) => {
    if (fields.every((f) => f.trim() === '')) return [];
    return [{ row: i + 2, values: Object.fromEntries(columns.map((c, j) => [c, fields[j] ?? ''])) }];
  });
  return { columns, rows };
}

/** Sends a report as JSON, or as a CSV download when asked. */
export function respond<T>(format: 'json' | 'csv', res: { setHeader(k: string, v: string): void }, json: T, csvFile: () => { name: string; body: string }): T | string {
  if (format === 'json') return json;
  const { name, body } = csvFile();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  return body;
}
