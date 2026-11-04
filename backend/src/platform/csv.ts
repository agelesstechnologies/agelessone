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

/** Sends a report as JSON, or as a CSV download when asked. */
export function respond<T>(format: 'json' | 'csv', res: { setHeader(k: string, v: string): void }, json: T, csvFile: () => { name: string; body: string }): T | string {
  if (format === 'json') return json;
  const { name, body } = csvFile();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  return body;
}
