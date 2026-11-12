import { inflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';

/**
 * Report PDFs with tables and photos (pdfkit, A4, the standard Helvetica fonts). A report is plain data: sections of
 * label / value rows, tables, text and images (by a file key; the caller loads the bytes). The text-only payslips and
 * letters stay in pdf.ts. The standard fonts draw Latin-1 only: "₹" becomes "Rs", other characters "?".
 */

/** A column of a table: its heading and its share of the line (the shares of one table add up to 1). */
export interface ReportColumn { label: string; width: number }
export type ReportBlock =
  | { kind: 'rows'; rows: [string, string][] }
  | { kind: 'table'; columns: ReportColumn[]; rows: string[][] }
  | { kind: 'subheading'; text: string }
  | { kind: 'text'; text: string }
  /** grey, italic: "None", explanations */
  | { kind: 'note'; text: string }
  /** an image by its file key (null: no file); large: page wide, up to 330 pt high; small: a passport-size picture */
  | { kind: 'image'; file: string | null; caption: string; size: 'large' | 'small' };
export interface ReportSection { title: string; blocks: ReportBlock[] }
export interface ReportDocument {
  title: string;
  subtitle: string;
  /** the footer of each page, e.g. "Ticket AE-0001 - page 2 of 9" */
  footer: (page: number, pages: number) => string;
  sections: ReportSection[];
}
/** The bytes of each image file key; null: the file is missing. */
export type ReportImages = Map<string, Buffer | null>;

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = { top: 48, bottom: 54, left: 46, right: 46 };
const WIDTH = A4.width - MARGIN.left - MARGIN.right;
const BOTTOM = A4.height - MARGIN.bottom;
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const ITALIC = 'Helvetica-Oblique';
const SIZE = { title: 17, subtitle: 11, heading: 12, subheading: 9.5, body: 8.5, small: 7.5 };
const COLOR = { text: '#1f2933', muted: '#6b7280', accent: '#0f4c81', rule: '#d5dbe1', fill: '#eef2f6' };
const PAD = 3;
const IMAGE_HEIGHT = { large: 330, small: 110 };
const IMAGE_WIDTH = { large: WIDTH, small: 150 };
const MAX_CELL = 2000;

/** Text the standard PDF fonts can draw (WinAnsi): "₹" becomes "Rs", other characters "?". Pure. */
export function pdfSafe(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/₹\s?/g, 'Rs ')
    .replace(/[^\n\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/gu, '?');
}

/** The size of an image scaled down (never up) to fit the box, keeping its proportions. Pure. */
export function fitInto(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const MAX_DECODED_PIXELS = 40_000_000;

/**
 * Why these bytes cannot be drawn as an image, or null. A JPEG is checked by pdfkit itself (a bad one throws at once).
 * A PNG with transparency is decoded by pdfkit in a callback, where a broken file would stop the server, so its data is
 * decoded here first: chunks complete, pixel data inflates, every row has a known filter. Pure.
 */
export function imageProblem(bytes: Buffer): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return null;
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return 'not a JPEG or PNG image';
  let ihdr: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | undefined;
  const data: Buffer[] = [];
  let transparency = false;
  for (let pos = 8; ; ) {
    if (pos + 12 > bytes.length) return 'the PNG file is incomplete';
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString('latin1', pos + 4, pos + 8);
    const start = pos + 8;
    if (start + length + 4 > bytes.length) return 'the PNG file is incomplete';
    if (type === 'IHDR' && length >= 13) {
      ihdr = { width: bytes.readUInt32BE(start), height: bytes.readUInt32BE(start + 4), bitDepth: bytes[start + 8], colorType: bytes[start + 9], interlace: bytes[start + 12] };
    } else if (type === 'IDAT') data.push(bytes.subarray(start, start + length));
    else if (type === 'tRNS') transparency = true;
    else if (type === 'IEND') break;
    pos = start + length + 4;
  }
  if (!ihdr || data.length === 0 || ihdr.width === 0 || ihdr.height === 0) return 'the PNG file has no picture';
  const channels = CHANNELS[ihdr.colorType];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(ihdr.bitDepth)) return 'unknown PNG colour format';
  if (ihdr.colorType !== 4 && ihdr.colorType !== 6 && !transparency) return null;   // embedded as it is, not decoded
  if (ihdr.width * ihdr.height > MAX_DECODED_PIXELS) return 'the picture is too large to show';
  let pixels: Buffer;
  try { pixels = inflateSync(Buffer.concat(data)); } catch { return 'the PNG picture data is damaged'; }
  let offset = 0;
  for (const [x0, y0, dx, dy] of ihdr.interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const w = Math.ceil((ihdr.width - x0) / dx);
    const h = Math.ceil((ihdr.height - y0) / dy);
    if (w <= 0 || h <= 0) continue;
    const rowBytes = Math.ceil((w * channels * ihdr.bitDepth) / 8);
    for (let row = 0; row < h; row++, offset += rowBytes + 1) {
      if (offset + rowBytes + 1 > pixels.length || pixels[offset] > 4) return 'the PNG picture data is damaged';
    }
  }
  return null;
}

/** An image opened by pdfkit (its runtime has openImage; the type definitions leave it out). */
interface OpenedImage { width: number; height: number; orientation?: number }
type Doc = PDFKit.PDFDocument & { openImage(src: Buffer): OpenedImage };

/** Draws a report and answers the PDF bytes; page numbers are written last (pages are kept in memory until then). */
export async function renderReport(report: ReportDocument, images: ReportImages): Promise<Buffer> {
  const pdf = new ReportPdf(report.title);
  pdf.title(report.title, report.subtitle);
  for (const s of report.sections) {
    pdf.heading(s.title);
    for (const b of s.blocks) pdf.block(b, images);
  }
  return pdf.finish(report.footer);
}

class ReportPdf {
  private readonly doc: Doc;
  private readonly bytes: Promise<Buffer>;

  constructor(title: string) {
    this.doc = new PDFDocument({ size: 'A4', margins: MARGIN, bufferPages: true, info: { Title: pdfSafe(title), Creator: 'Ageless' } }) as Doc;
    const chunks: Buffer[] = [];
    this.bytes = new Promise((resolve, reject) => {
      this.doc.on('data', (c: Buffer) => chunks.push(c));
      this.doc.on('end', () => resolve(Buffer.concat(chunks)));
      this.doc.on('error', reject);
    });
    this.doc.fillColor(COLOR.text);
  }

  title(title: string, subtitle: string): void {
    this.doc.font(BOLD).fontSize(SIZE.title).fillColor(COLOR.accent).text(pdfSafe(title), MARGIN.left, MARGIN.top, { width: WIDTH });
    this.doc.font(FONT).fontSize(SIZE.subtitle).fillColor(COLOR.text).text(pdfSafe(subtitle), { width: WIDTH });
    this.doc.moveDown(0.4);
  }

  /** A section heading with a rule; moves to a new page when too little room is left for the heading and a few lines. */
  heading(text: string): void {
    this.room(70);
    this.doc.y += 8;
    this.doc.font(BOLD).fontSize(SIZE.heading).fillColor(COLOR.accent).text(pdfSafe(text), MARGIN.left, this.doc.y, { width: WIDTH });
    const y = this.doc.y + 1;
    this.doc.moveTo(MARGIN.left, y).lineTo(MARGIN.left + WIDTH, y).lineWidth(0.8).strokeColor(COLOR.accent).stroke();
    this.doc.y = y + 5;
  }

  block(b: ReportBlock, images: ReportImages): void {
    switch (b.kind) {
      case 'rows': return this.rows(b.rows);
      case 'table': return this.table(b.columns, b.rows);
      case 'subheading': return this.subheading(b.text);
      case 'text': return this.paragraph(b.text, FONT, COLOR.text);
      case 'note': return this.paragraph(b.text, ITALIC, COLOR.muted);
      case 'image': return this.image(b.file === null ? null : images.get(b.file) ?? null, b.caption, b.size);
    }
  }

  async finish(footer: (page: number, pages: number) => string): Promise<Buffer> {
    const range = this.doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      this.doc.switchToPage(range.start + i);
      const margins = this.doc.page.margins;
      this.doc.page.margins = { ...margins, bottom: 0 };          // writing below the bottom margin would add a page
      const y = A4.height - MARGIN.bottom + 16;
      this.doc.moveTo(MARGIN.left, y - 5).lineTo(MARGIN.left + WIDTH, y - 5).lineWidth(0.5).strokeColor(COLOR.rule).stroke();
      this.doc.font(FONT).fontSize(SIZE.small).fillColor(COLOR.muted)
        .text(pdfSafe(footer(i + 1, range.count)), MARGIN.left, y, { width: WIDTH, align: 'center', lineBreak: false });
      this.doc.page.margins = margins;
    }
    this.doc.end();
    return this.bytes;
  }

  // ---- blocks ----

  private subheading(text: string): void {
    this.room(40);
    this.doc.y += 4;
    this.doc.font(BOLD).fontSize(SIZE.subheading).fillColor(COLOR.text).text(pdfSafe(text), MARGIN.left, this.doc.y, { width: WIDTH });
    this.doc.y += 2;
  }

  private paragraph(text: string, font: string, color: string): void {
    this.doc.font(font).fontSize(SIZE.body).fillColor(color);
    const safe = pdfSafe(text);
    this.room(Math.min(this.doc.heightOfString(safe, { width: WIDTH }), 40));
    this.doc.text(safe, MARGIN.left, this.doc.y, { width: WIDTH, lineGap: 1 });
    this.doc.y += 3;
  }

  /** Label / value lines (labels in grey), values wrapped. */
  private rows(rows: [string, string][]): void {
    const widths = [WIDTH * 0.28, WIDTH * 0.72];
    for (const [label, value] of rows) {
      const cells = [label, value].map((c) => pdfSafe(c).slice(0, MAX_CELL));
      const height = this.rowHeight(cells, widths, [BOLD, FONT]);
      this.room(height);
      const y = this.doc.y;
      this.cell(cells[0], MARGIN.left, y, widths[0], height, BOLD, COLOR.muted);
      this.cell(cells[1], MARGIN.left + widths[0], y, widths[1], height, FONT, COLOR.text);
      this.doc.y = y + height;
    }
    this.doc.y += 3;
  }

  /** A table with a shaded heading row (repeated on each new page) and thin lines between rows; cells wrap. */
  private table(columns: ReportColumn[], rows: string[][]): void {
    const widths = columns.map((c) => c.width * WIDTH);
    const header = columns.map((c) => pdfSafe(c.label));
    const headerHeight = this.rowHeight(header, widths, header.map(() => BOLD));
    const drawHeader = () => {
      const y = this.doc.y;
      this.doc.rect(MARGIN.left, y, WIDTH, headerHeight).fill(COLOR.fill);
      let x = MARGIN.left;
      header.forEach((h, i) => { this.cell(h, x, y, widths[i], headerHeight, BOLD, COLOR.text); x += widths[i]; });
      this.doc.y = y + headerHeight;
    };
    this.room(headerHeight + 16);
    drawHeader();
    for (const row of rows) {
      const cells = columns.map((_, i) => pdfSafe(row[i] ?? '').slice(0, MAX_CELL));
      const height = Math.min(this.rowHeight(cells, widths, cells.map(() => FONT)), BOTTOM - MARGIN.top - headerHeight - 4);
      if (this.doc.y + height > BOTTOM) { this.doc.addPage(); drawHeader(); }
      const y = this.doc.y;
      let x = MARGIN.left;
      cells.forEach((c, i) => { this.cell(c, x, y, widths[i], height, FONT, COLOR.text); x += widths[i]; });
      this.doc.moveTo(MARGIN.left, y + height).lineTo(MARGIN.left + WIDTH, y + height).lineWidth(0.4).strokeColor(COLOR.rule).stroke();
      this.doc.y = y + height;
    }
    this.doc.y += 6;
  }

  /** An image scaled to fit (never enlarged) with its caption below; a missing or unreadable file is named instead. */
  private image(bytes: Buffer | null, caption: string, size: 'large' | 'small'): void {
    const opened = this.open(bytes);
    if (typeof opened === 'string') { this.paragraph(`${caption} - ${opened}`, ITALIC, COLOR.muted); return; }
    const box = fitInto(opened.width, opened.height, IMAGE_WIDTH[size], IMAGE_HEIGHT[size]);
    const text = pdfSafe(caption);
    this.doc.font(FONT).fontSize(SIZE.small);
    const captionHeight = this.doc.heightOfString(text, { width: WIDTH });
    this.room(box.height + captionHeight + 8);
    const y = this.doc.y + 2;
    this.doc.image(opened.image as unknown as Buffer, MARGIN.left, y, { width: box.width, height: box.height });
    this.doc.fillColor(COLOR.muted).text(text, MARGIN.left, y + box.height + 2, { width: WIDTH });
    this.doc.y += 6;
  }

  // ---- helpers ----

  /** Starts a new page unless `height` still fits on this one. */
  private room(height: number): void {
    if (this.doc.y + height > BOTTOM) this.doc.addPage();
  }

  private rowHeight(cells: string[], widths: number[], fonts: string[]): number {
    let h = 0;
    cells.forEach((c, i) => {
      this.doc.font(fonts[i]).fontSize(SIZE.body);
      h = Math.max(h, this.doc.heightOfString(c || ' ', { width: widths[i] - PAD * 2, lineGap: 1 }));
    });
    return h + PAD * 2;
  }

  private cell(text: string, x: number, y: number, width: number, height: number, font: string, color: string): void {
    this.doc.font(font).fontSize(SIZE.body).fillColor(color)
      .text(text, x + PAD, y + PAD, { width: width - PAD * 2, height: height - PAD * 2, lineGap: 1, ellipsis: true });
  }

  private open(bytes: Buffer | null): { image: OpenedImage; width: number; height: number } | string {
    if (!bytes) return 'file not found';
    const problem = imageProblem(bytes);
    if (problem) return `the image could not be shown (${problem})`;
    try {
      const image = this.doc.openImage(bytes);
      const turned = (image.orientation ?? 1) > 4;      // EXIF: taken sideways
      return { image, width: turned ? image.height : image.width, height: turned ? image.width : image.height };
    } catch {
      return 'the image could not be shown (damaged file)';
    }
  }
}
