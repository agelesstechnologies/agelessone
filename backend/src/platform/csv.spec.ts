import { describe, expect, it } from 'vitest';
import { parseCsv, readCsvTable, rupees, toCsv } from './csv';

describe('csv', () => {
  it('about lines, a blank line, then the table; commas, quotes and formulas are made safe', () => {
    const out = toCsv([['Report', 'Expenses']], ['name', 'amount'], [['Rao, A "Ravi"', '1.00'], ['=SUM(A1)', 2], [null, true]]);
    expect(out).toBe('﻿Report,Expenses\r\n\r\nname,amount\r\n"Rao, A ""Ravi""",1.00\r\n\'=SUM(A1),2\r\n,true\r\n');
  });
  it('reads quoted fields with commas, quotes and line breaks, CRLF or LF, and drops the byte-order mark', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"two\nlines",\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '']]);
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
    expect(parseCsv('')).toEqual([]);
  });
  it('reads a table by header name, numbering rows as a spreadsheet does and leaving out empty rows', () => {
    const t = readCsvTable('Code, Reorder Level ,hsn-code\nA1,5\n,,\nB2,,8536\n');
    expect(t.columns).toEqual(['code', 'reorder_level', 'hsn_code']);
    expect(t.rows).toEqual([{ row: 2, values: { code: 'A1', reorder_level: '5', hsn_code: '' } }, { row: 4, values: { code: 'B2', reorder_level: '', hsn_code: '8536' } }]);
  });
  it('rupees from paise without rounding errors', () => {
    expect([rupees(123456), rupees(5), rupees(0), rupees(-250)]).toEqual(['1234.56', '0.05', '0.00', '-2.50']);
  });
});
