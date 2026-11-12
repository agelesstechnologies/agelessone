import { describe, expect, it } from 'vitest';
import { fitInto, imageProblem, pdfSafe, renderReport, ReportDocument } from './report-pdf';
import { damagedAlphaPng, JPEG, pdfText, png } from '../test/images';

const doc = (sections: ReportDocument['sections']): ReportDocument =>
  ({ title: 'Ticket report T-0001', subtitle: 'Gate repair - Test Company', footer: (p, n) => `Ticket T-0001 - page ${p} of ${n}`, sections });

describe('report PDF helpers', () => {
  it('keeps text the standard fonts can draw: rupee sign as Rs, others as ?', () => {
    expect(pdfSafe('₹ 1,200 – done “ok” é')).toBe('Rs 1,200 – done “ok” é');
    expect(pdfSafe('Tab\there\r\nnext ✓ 日本')).toBe('Tab here\nnext ? ??');
  });

  it('scales pictures down to fit, never up', () => {
    expect(fitInto(4000, 3000, 500, 330)).toEqual({ width: 440, height: 330 });
    expect(fitInto(1000, 200, 500, 330)).toEqual({ width: 500, height: 100 });
    expect(fitInto(80, 60, 500, 330)).toEqual({ width: 80, height: 60 });
  });

  it('tells which pictures can be drawn: JPEG, PNG (with or without transparency); not damaged or unknown files', () => {
    expect(imageProblem(JPEG)).toBeNull();
    expect(imageProblem(png(8, 6))).toBeNull();
    expect(imageProblem(png(8, 6, true))).toBeNull();
    expect(imageProblem(damagedAlphaPng())).toMatch(/damaged/);
    expect(imageProblem(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toMatch(/incomplete/);
    expect(imageProblem(Buffer.from('%PDF-1.4 something'))).toMatch(/not a JPEG or PNG/);
  });
});

describe('renderReport', () => {
  it('draws rows, tables, notes and 20 photos into one A4 PDF with page numbers', async () => {
    const files = new Map<string, Buffer | null>();
    const blocks: ReportDocument['sections'][number]['blocks'] = [];
    for (let i = 0; i < 20; i++) {
      const key = `photo-${i}`;
      files.set(key, i % 3 === 0 ? JPEG : png(320 + i * 10, 240, i % 2 === 0));
      blocks.push({ kind: 'image', file: key, caption: `Photo ${i + 1} by Test Person`, size: i % 5 === 0 ? 'small' : 'large' });
    }
    files.set('gone', null);
    files.set('broken', damagedAlphaPng());
    blocks.push({ kind: 'image', file: 'gone', caption: 'Missing photo', size: 'large' }, { kind: 'image', file: 'broken', caption: 'Broken photo', size: 'large' });
    const long = 'A long note that wraps over several lines. '.repeat(30);
    const pdf = await renderReport(doc([
      { title: 'Ticket', blocks: [{ kind: 'rows', rows: [['Amount', 'Rs 1,23,456.50'], ['Description', long]] }, { kind: 'note', text: 'All times IST.' }] },
      { title: 'History', blocks: [{ kind: 'table', columns: [{ label: 'When', width: 0.2 }, { label: 'What', width: 0.8 }],
        rows: Array.from({ length: 120 }, (_, i) => [`Row ${i + 1}`, i % 10 === 0 ? long : `Event ${i + 1}`]) }] },
      { title: 'Files and photos', blocks },
    ]), files);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(pdf);
    for (const s of ['Ticket report T-0001', 'Rs 1,23,456.50', 'History', 'Row 120', 'Files and photos', 'Photo 20 by Test Person']) expect(text).toContain(s);
    expect(text).toContain('Missing photo - file not found');
    expect(text).toMatch(/Broken photo - the image could not be shown \(the PNG picture data is damaged\)/);
    const pages = Number(/page 1 of (\d+)/.exec(text)?.[1]);
    expect(pages).toBeGreaterThan(5);
    expect(text).toContain(`Ticket T-0001 - page ${pages} of ${pages}`);
  }, 30_000);
});
