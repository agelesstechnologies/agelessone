/**
 * Which files the Design module accepts, told by their bytes (the uploaded name only picks between formats that share a
 * container, e.g. XLSX and ZIP). Programs and scripts are always refused. Files are stored under a random name and sent
 * back as downloads (never shown inline). Pure.
 */

export type FilePurpose = 'drawing_pdf' | 'source' | 'bom' | 'markup' | 'attachment';
export type Sniffed = 'pdf' | 'jpg' | 'png' | 'zip' | 'ole' | 'dwg' | 'step' | 'skp' | '3dm' | 'text' | 'executable' | 'binary';

/** What each accepted extension must look like inside. */
const SOURCE: Record<string, Sniffed[]> = {
  dwg: ['dwg'], dxf: ['text'], step: ['step'], stp: ['step'], igs: ['text'], iges: ['text'],
  // SolidWorks files have no fixed signature across versions; Inventor files are OLE compound files
  sldprt: ['ole', 'zip', 'binary'], sldasm: ['ole', 'zip', 'binary'], slddrw: ['ole', 'zip', 'binary'],
  ipt: ['ole'], iam: ['ole'], idw: ['ole'], skp: ['skp'], '3dm': ['3dm'], f3d: ['zip'], zip: ['zip'],
};
const BOM: Record<string, Sniffed[]> = { csv: ['text'], xlsx: ['zip'], pdf: ['pdf'] };
const DOCUMENTS: Record<string, Sniffed[]> = { pdf: ['pdf'], jpg: ['jpg'], jpeg: ['jpg'], png: ['png'], docx: ['zip'], txt: ['text'] };

export const CONTENT_TYPE: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', csv: 'text/csv; charset=utf-8' };
export const contentTypeOf = (ext: string): string => CONTENT_TYPE[ext] ?? 'application/octet-stream';

/** What the first bytes say a file is. */
export function sniff(b: Uint8Array): Sniffed {
  const starts = (...sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
  const ascii = (s: string) => starts(...[...s].map((c) => c.charCodeAt(0)));
  if (ascii('%PDF-')) return 'pdf';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06)) return 'zip';
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'ole';
  if (ascii('AC10') && b.length >= 6) return 'dwg';
  if (ascii('ISO-10303-21')) return 'step';
  if (starts(0xff, 0xfe, 0xff)) return 'skp';
  if (ascii('3D Geometry File Format')) return '3dm';
  const text = isText(b);
  if (ascii('#!') || (!text && (ascii('MZ') || starts(0x7f, 0x45, 0x4c, 0x46) || starts(0xca, 0xfe, 0xba, 0xbe)
    || starts(0xcf, 0xfa, 0xed, 0xfe) || starts(0xce, 0xfa, 0xed, 0xfe) || starts(0xfe, 0xed, 0xfa, 0xce)))) return 'executable';
  return text ? 'text' : 'binary';
}

/** UTF-8 text without NUL bytes (the first 64 KB are checked). */
function isText(b: Uint8Array): boolean {
  const head = b.subarray(0, 65536);
  if (head.length === 0 || head.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); return true; } catch { return false; }
}

/** The extension of the uploaded name, lower case (letters and digits only), or null. */
export function extensionOf(name: string | undefined): string | null {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name ?? '');
  return m ? m[1].toLowerCase() : null;
}

const WHAT: Record<FilePurpose, string> = {
  drawing_pdf: 'The drawing must be a PDF',
  markup: 'Mark-ups are PDF, JPEG or PNG files',
  bom: 'A bill of materials is a CSV, XLSX or PDF file',
  source: 'Source files are DWG, DXF, STEP, IGES, SolidWorks, Inventor, SketchUp, Rhino, Fusion 360 or ZIP files',
  attachment: 'Attachments are PDF, JPEG, PNG, DOCX, TXT, CSV, XLSX or CAD source files',
};

/** The type (extension) a file is stored as, or why it is refused. */
export function designFileType(bytes: Uint8Array, uploadedName: string | undefined, purpose: FilePurpose): { ext: string } | { problem: string } {
  const kind = sniff(bytes);
  if (kind === 'executable') return { problem: 'Programs and scripts are not accepted' };
  if (purpose === 'drawing_pdf') return kind === 'pdf' ? { ext: 'pdf' } : { problem: WHAT[purpose] };
  if (purpose === 'markup') return kind === 'pdf' || kind === 'jpg' || kind === 'png' ? { ext: kind } : { problem: WHAT[purpose] };
  const allowed = purpose === 'source' ? SOURCE : purpose === 'bom' ? BOM : { ...SOURCE, ...BOM, ...DOCUMENTS };
  // PDFs and pictures are recognised by their bytes, whatever the name says
  if (kind === 'pdf' && allowed.pdf) return { ext: 'pdf' };
  if ((kind === 'jpg' || kind === 'png') && allowed[kind]) return { ext: kind };
  const ext = extensionOf(uploadedName);
  if (ext && allowed[ext]?.includes(kind)) return { ext: ext === 'jpeg' ? 'jpg' : ext };
  return { problem: WHAT[purpose] };
}
