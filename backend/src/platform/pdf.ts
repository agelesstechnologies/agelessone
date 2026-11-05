/**
 * A small text-only PDF (A4, Helvetica) for documents such as payslips — no PDF library needed.
 * Each line is drawn at a fixed position: left text and an optional right-aligned value (amounts).
 * Characters outside plain Latin-1 are replaced with '?' (the standard fonts cannot draw them); use "INR", not "₹".
 */
export interface PdfLine { text: string; value?: string; bold?: boolean; size?: number; gapBefore?: number }

const A4 = { width: 595, height: 842 };
const MARGIN = 56;

function escape(s: string): string {
  return s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Rough width of Helvetica text, to right-align values (digits and most letters are about 0.55 em). */
const width = (s: string, size: number) => s.length * size * 0.55;

export function textPdf(lines: PdfLine[]): Buffer {
  let y = A4.height - MARGIN;
  const ops: string[] = [];
  for (const l of lines) {
    const size = l.size ?? 10;
    y -= (l.gapBefore ?? 0) + size + 4;
    const font = l.bold ? 'F2' : 'F1';
    ops.push(`BT /${font} ${size} Tf ${MARGIN} ${y.toFixed(1)} Td (${escape(l.text)}) Tj ET`);
    if (l.value !== undefined) {
      const x = A4.width - MARGIN - width(l.value, size);
      ops.push(`BT /${font} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${escape(l.value)}) Tj ET`);
    }
  }
  const content = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
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
