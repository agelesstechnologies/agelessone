import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A small .zip writer (no package needed): each file deflated, or stored when that is not smaller. File names are
 * UTF-8 (flag bit 11); times are IST, as zip keeps local times. No ZIP64: refuses 65,535 files or 4 GB. Pure.
 */
export interface ZipEntry { name: string; data: Buffer; modified?: Date }

const LIMIT = 0xffffffff;

export function makeZip(entries: ZipEntry[], now = new Date()): Buffer {
  if (entries.length > 0xffff) throw new Error('Too many files for one zip');
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  const names = new Set<string>();
  let offset = 0;
  for (const e of entries) {
    if (!e.name || e.name.includes('\\') || e.name.startsWith('/') || e.name.split('/').includes('..')) throw new Error(`Not a safe file name: ${e.name}`);
    if (names.has(e.name)) throw new Error(`Two files named ${e.name}`);
    names.add(e.name);
    const name = Buffer.from(e.name, 'utf8');
    const deflated = deflateRawSync(e.data);
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const crc = crc32(e.data) >>> 0;
    const { time, date } = dosTime(e.modified ?? now);
    const fields = (h: Buffer, at: number) => {
      h.writeUInt16LE(0x0800, at);                 // general purpose: UTF-8 names
      h.writeUInt16LE(stored ? 0 : 8, at + 2);     // method: stored or deflate
      h.writeUInt16LE(time, at + 4);
      h.writeUInt16LE(date, at + 6);
      h.writeUInt32LE(crc, at + 8);
      h.writeUInt32LE(body.length, at + 12);
      h.writeUInt32LE(e.data.length, at + 16);
      h.writeUInt16LE(name.length, at + 20);
    };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                    // version needed: 2.0
    fields(local, 6);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);                    // version made by
    entry.writeUInt16LE(20, 6);                    // version needed
    fields(entry, 8);
    entry.writeUInt32LE(offset, 42);               // where the local header starts
    parts.push(local, name, body);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
    if (offset > LIMIT) throw new Error('The zip would be larger than 4 GB');
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** MS-DOS time and date fields, in IST. */
function dosTime(d: Date): { time: number; date: number } {
  const t = new Date(d.getTime() + 330 * 60_000);
  const year = Math.min(Math.max(t.getUTCFullYear(), 1980), 2107);
  return {
    time: (t.getUTCHours() << 11) | (t.getUTCMinutes() << 5) | Math.floor(t.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((t.getUTCMonth() + 1) << 5) | t.getUTCDate(),
  };
}
