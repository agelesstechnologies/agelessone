import { describe, expect, it } from 'vitest';
import { designFileType, extensionOf, sniff } from './files';

const PDF = Buffer.from('%PDF-1.4\n% test\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const DWG = Buffer.from('AC1032\0\0\0\0\0\x01binary', 'latin1');
const STEP = Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\n');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
const CSV = Buffer.from('Part,Qty\nMZ-100 bolt,4\n');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
const SCRIPT = Buffer.from('#!/bin/sh\nrm -rf /\n');

describe('design files', () => {
  it('tells formats apart by their first bytes', () => {
    expect([PDF, PNG, DWG, STEP, ZIP, OLE, CSV, EXE, SCRIPT].map(sniff)).toEqual(['pdf', 'png', 'dwg', 'step', 'zip', 'ole', 'text', 'executable', 'executable']);
    expect(sniff(Buffer.from([1, 2, 0, 3]))).toBe('binary');
    expect(extensionOf('Pump Base.SLDPRT')).toBe('sldprt');
    expect(extensionOf('no-extension')).toBeNull();
  });

  it('a drawing is a PDF by its bytes, whatever the name says', () => {
    expect(designFileType(PDF, 'drawing.dwg', 'drawing_pdf')).toEqual({ ext: 'pdf' });
    expect(designFileType(PNG, 'drawing.pdf', 'drawing_pdf')).toMatchObject({ problem: expect.stringMatching(/PDF/) });
  });

  it('source files: the extension must match what is inside', () => {
    expect(designFileType(DWG, 'base.dwg', 'source')).toEqual({ ext: 'dwg' });
    expect(designFileType(STEP, 'base.stp', 'source')).toEqual({ ext: 'stp' });
    expect(designFileType(OLE, 'frame.ipt', 'source')).toEqual({ ext: 'ipt' });
    expect(designFileType(Buffer.from([1, 2, 0, 3]), 'part.SLDPRT', 'source')).toEqual({ ext: 'sldprt' });
    expect(designFileType(CSV, 'base.dwg', 'source')).toMatchObject({ problem: expect.stringMatching(/Source files/) });
    expect(designFileType(PDF, 'base.pdf', 'source')).toMatchObject({ problem: expect.stringMatching(/Source files/) });
  });

  it('bills of materials: CSV, XLSX or PDF; mark-ups: PDF or pictures', () => {
    expect(designFileType(CSV, 'bom.csv', 'bom')).toEqual({ ext: 'csv' });
    expect(designFileType(ZIP, 'bom.xlsx', 'bom')).toEqual({ ext: 'xlsx' });
    expect(designFileType(PDF, 'bom', 'bom')).toEqual({ ext: 'pdf' });
    expect(designFileType(PNG, 'redline.png', 'markup')).toEqual({ ext: 'png' });
    expect(designFileType(CSV, 'notes.csv', 'markup')).toMatchObject({ problem: expect.any(String) });
  });

  it('never accepts programs or scripts, whatever they are called', () => {
    for (const purpose of ['source', 'bom', 'attachment'] as const) {
      expect(designFileType(EXE, 'part.sldprt', purpose)).toEqual({ problem: 'Programs and scripts are not accepted' });
      expect(designFileType(SCRIPT, 'list.csv', purpose)).toEqual({ problem: 'Programs and scripts are not accepted' });
    }
  });
});
