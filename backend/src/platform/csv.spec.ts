import { describe, expect, it } from 'vitest';
import { rupees, toCsv } from './csv';

describe('csv', () => {
  it('about lines, a blank line, then the table; commas, quotes and formulas are made safe', () => {
    const out = toCsv([['Report', 'Expenses']], ['name', 'amount'], [['Rao, A "Ravi"', '1.00'], ['=SUM(A1)', 2], [null, true]]);
    expect(out).toBe('﻿Report,Expenses\r\n\r\nname,amount\r\n"Rao, A ""Ravi""",1.00\r\n\'=SUM(A1),2\r\n,true\r\n');
  });
  it('rupees from paise without rounding errors', () => {
    expect([rupees(123456), rupees(5), rupees(0), rupees(-250)]).toEqual(['1234.56', '0.05', '0.00', '-2.50']);
  });
});
