import { describe, expect, it } from 'vitest';
import { letterPdf, textPdf, wrapText } from './pdf';

const pageCount = (pdf: Buffer) => Number(/\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]);

describe('text-only PDFs', () => {
  it('wraps words to the width and cuts a word longer than a line', () => {
    const lines = wrapText('one two three four five six seven eight nine ten', 10, 120);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('one two three four five six seven eight nine ten');
    expect(wrapText('x'.repeat(60), 10, 55).every((l) => l.length <= 10)).toBe(true);
  });

  it('a payslip is one page', () => {
    const pdf = textPdf([{ text: 'Payslip', bold: true }, { text: 'Net pay', value: 'INR 10,000.00' }]);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pageCount(pdf)).toBe(1);
  });

  it('a short letter is one page; a long one runs onto more pages, numbered', () => {
    const short = letterPdf({ heading: 'Ageless Technologies', date: '9 November 2026', title: 'Letter of appointment', body: 'Dear Asha,\n\nWelcome.' });
    expect(pageCount(short)).toBe(1);
    expect(short.toString('latin1')).toContain('(Letter of appointment)');
    const long = letterPdf({ heading: 'AE', date: '9 November 2026', title: 'Long', body: Array.from({ length: 80 }, (_, i) => `Paragraph ${i} text.`).join('\n\n') });
    expect(pageCount(long)).toBeGreaterThan(1);
    expect(long.toString('latin1')).toContain('(Page 1 of ');
  });

  it('characters the standard fonts cannot draw become ?', () => {
    expect(letterPdf({ heading: 'H', date: 'd', title: '₹ 100', body: 'b' }).toString('latin1')).toContain('(? 100)');
  });
});
