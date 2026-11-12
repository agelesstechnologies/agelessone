import { crc32, deflateSync, inflateSync } from 'node:zlib';

/**
 * Small made-up pictures and PDF text for tests (nothing real). png(): a striped PNG, RGB or RGBA (with transparency,
 * which pdfkit decodes); JPEG: a 1 x 1 picture.
 */
export function png(width: number, height: number, alpha = false): Buffer {
  const channels = alpha ? 4 : 3;
  const row = width * channels + 1;
  const raw = Buffer.alloc(row * height);                        // filter byte 0 (none) on each row
  for (let y = 0; y < height; y++) for (let x = 0; x < width * channels; x++) raw[y * row + 1 + x] = (x * 7 + y * 13) & 0xff;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;                    // bit depth
  header[9] = alpha ? 6 : 2;        // colour type: RGBA or RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A PNG with transparency whose picture data is not valid zlib (a damaged upload). */
export function damagedAlphaPng(): Buffer {
  const good = png(4, 4, true);
  const idat = good.indexOf('IDAT', 0, 'latin1');
  const bad = Buffer.from(good);
  bad.fill(0x41, idat + 4, idat + 12);
  return bad;
}

export const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////'
  + 'wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

/**
 * The text of a pdfkit PDF (standard fonts), every drawn line joined by one space (so a phrase wrapped inside a table
 * cell still reads as one). Reads the compressed page contents.
 */
export function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const lines: string[] = [];
  for (let at = raw.indexOf('stream\n'); at !== -1; at = raw.indexOf('stream\n', at + 1)) {
    if (raw.slice(at - 3, at) === 'end') continue;
    const end = raw.indexOf('\nendstream', at);
    if (end === -1) break;
    let content: string;
    try { content = inflateSync(pdf.subarray(at + 7, end)).toString('latin1'); } catch { continue; }
    for (const m of content.matchAll(/\[([^\]]*)\] TJ/g)) {
      lines.push([...m[1].matchAll(/<([0-9a-f]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join(''));
    }
  }
  return lines.join(' ');
}
