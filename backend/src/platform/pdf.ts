/**
 * Small text-only PDFs (A4, Helvetica) for documents such as payslips and letters — no PDF library needed.
 * Characters outside plain Latin-1 are replaced with '?' (the standard fonts cannot draw them); use "INR", not "₹".
 */
export interface PdfLine { text: string; value?: string; bold?: boolean; size?: number; gapBefore?: number }

const A4 = { width: 595, height: 842 };
const MARGIN = 56;

function escape(s: string): string {
  return s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Rough width of Helvetica text, to right-align values and wrap lines (digits and most letters are about 0.55 em). */
const width = (s: string, size: number) => s.length * size * 0.55;

const draw = (font: 'F1' | 'F2', size: number, x: number, y: number, text: string) =>
  `BT /${font} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${escape(text)}) Tj ET`;

/** One page per entry (each a content stream); Helvetica as F1 and Helvetica-Bold as F2. */
function build(pages: string[]): Buffer {
  const fontF1 = 3, fontF2 = 4;
  const pageIds = pages.map((_, i) => 5 + i * 2);
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((content, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 ${fontF1} 0 R /F2 ${fontF2} 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** One page of lines at fixed positions: left text and an optional right-aligned value (amounts). Used for payslips. */
export function textPdf(lines: PdfLine[]): Buffer {
  let y = A4.height - MARGIN;
  const ops: string[] = [];
  for (const l of lines) {
    const size = l.size ?? 10;
    y -= (l.gapBefore ?? 0) + size + 4;
    const font = l.bold ? 'F2' : 'F1';
    ops.push(draw(font, size, MARGIN, y, l.text));
    if (l.value !== undefined) ops.push(draw(font, size, A4.width - MARGIN - width(l.value, size), y, l.value));
  }
  return build([ops.join('\n')]);
}

/** Splits text into lines no wider than maxWidth (words longer than a line are cut). Pure. */
export function wrapText(text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (width(next, size) <= maxWidth) { line = next; continue; }
    if (line) out.push(line);
    let rest = word;
    while (width(rest, size) > maxWidth) {
      const fit = Math.max(1, Math.floor(maxWidth / (size * 0.55)));
      out.push(rest.slice(0, fit));
      rest = rest.slice(fit);
    }
    line = rest;
  }
  if (line) out.push(line);
  return out;
}

/**
 * A letter: the company name as a heading, the date on the right, a bold title, then the body. Blank lines in the body
 * separate paragraphs; long lines wrap; it runs onto more pages when needed (page numbers at the bottom).
 */
export function letterPdf(l: { heading: string; date: string; title: string; body: string }): Buffer {
  const pages: string[][] = [[]];
  const textWidth = A4.width - MARGIN * 2;
  const bottom = MARGIN + 24;
  let y = A4.height - MARGIN;
  const line = (font: 'F1' | 'F2', size: number, text: string, gap = 0) => {
    if (y - gap - size - 5 < bottom) { pages.push([]); y = A4.height - MARGIN; gap = 0; }
    y -= gap + size + 5;
    pages[pages.length - 1].push(draw(font, size, MARGIN, y, text));
  };
  line('F2', 16, l.heading);
  pages[0].push(draw('F1', 10, A4.width - MARGIN - width(l.date, 10), y, l.date));
  y -= 12;
  pages[0].push(`${MARGIN} ${y.toFixed(1)} m ${A4.width - MARGIN} ${y.toFixed(1)} l 0.6 w S`);
  for (const t of wrapText(l.title, 12, textWidth)) line('F2', 12, t, 14);
  y -= 6;
  const paragraphs = l.body.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  paragraphs.forEach((p, i) => {
    const rows = p.split('\n').flatMap((row) => (row.trim() ? wrapText(row, 11, textWidth) : ['']));
    rows.forEach((r, k) => line('F1', 11, r, k === 0 && i > 0 ? 9 : 0));
  });
  if (pages.length > 1) {
    pages.forEach((ops, i) => {
      const label = `Page ${i + 1} of ${pages.length}`;
      ops.push(draw('F1', 9, A4.width - MARGIN - width(label, 9), MARGIN - 10, label));
    });
  }
  return build(pages.map((ops) => ops.join('\n')));
}
