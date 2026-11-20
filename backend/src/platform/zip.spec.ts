import { describe, expect, it } from 'vitest';
import { makeZip } from './zip';
import { readZip } from '../test/zip';

describe('makeZip', () => {
  it('writes files that read back byte for byte (deflated when smaller, stored otherwise), with UTF-8 names', () => {
    const text = Buffer.from('Transmittal cover sheet. '.repeat(200));
    const random = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 7919) % 251));
    const zip = makeZip([{ name: 'TR-0001_cover.pdf', data: text }, { name: 'DJ-001-MEC-001_A.pdf', data: random }, { name: 'empty.txt', data: Buffer.alloc(0) },
      { name: 'Nüsse/plan ✓.pdf', data: Buffer.from('x') }], new Date('2026-11-20T06:30:00Z'));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['TR-0001_cover.pdf', 'DJ-001-MEC-001_A.pdf', 'empty.txt', 'Nüsse/plan ✓.pdf']);
    expect(files.get('TR-0001_cover.pdf')!.equals(text)).toBe(true);
    expect(files.get('DJ-001-MEC-001_A.pdf')!.equals(random)).toBe(true);
    expect(files.get('empty.txt')!.length).toBe(0);
    expect(zip.length).toBeLessThan(text.length);   // the repeated text was deflated
  });

  it('refuses two files of the same name and unsafe names', () => {
    expect(() => makeZip([{ name: 'a.pdf', data: Buffer.from('1') }, { name: 'a.pdf', data: Buffer.from('2') }])).toThrow(/Two files/);
    expect(() => makeZip([{ name: '../evil.pdf', data: Buffer.from('1') }])).toThrow(/safe/);
    expect(() => makeZip([{ name: '/abs.pdf', data: Buffer.from('1') }])).toThrow(/safe/);
  });
});
