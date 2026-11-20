import { describe, expect, it } from 'vitest';
import { letterIndex, letters, nextRevisionCode } from './revisions';
import { drawingNumber, revisionFileName, seriesNumber } from './numbers';

describe('revision codes', () => {
  it('counts letters like spreadsheet columns: A … Z, AA … ZZ', () => {
    expect([1, 2, 26, 27, 28, 52, 702].map(letters)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'ZZ']);
    expect(['A', 'Z', 'AA', 'ZZ'].map(letterIndex)).toEqual([1, 26, 27, 702]);
  });

  it('preliminary revisions are lettered from A; construction revisions numbered from 0', () => {
    expect(nextRevisionCode('preliminary', [])).toEqual({ code: 'A' });
    expect(nextRevisionCode('preliminary', [{ stage: 'preliminary', code: 'A' }, { stage: 'preliminary', code: 'B' }])).toEqual({ code: 'C' });
    expect(nextRevisionCode('preliminary', [{ stage: 'preliminary', code: 'Z' }])).toEqual({ code: 'AA' });
    expect(nextRevisionCode('construction', [{ stage: 'preliminary', code: 'B' }])).toEqual({ code: '0' });
    expect(nextRevisionCode('construction', [{ stage: 'preliminary', code: 'B' }, { stage: 'construction', code: '0' }, { stage: 'construction', code: '1' }])).toEqual({ code: '2' });
  });

  it('no letters once a construction revision exists; nothing after ZZ', () => {
    expect(nextRevisionCode('preliminary', [{ stage: 'construction', code: '0' }])).toMatchObject({ problem: expect.stringMatching(/numbered/) });
    expect(nextRevisionCode('preliminary', [{ stage: 'preliminary', code: 'ZZ' }])).toMatchObject({ problem: expect.stringMatching(/ZZ/) });
  });
});

describe('design numbers', () => {
  it('jobs and transmittals: prefix, dash, padded counter; drawings: job-discipline-seq', () => {
    expect(seriesNumber('DJ', 25, 3)).toBe('DJ-025');
    expect(seriesNumber('TR', 1, 4)).toBe('TR-0001');
    expect(seriesNumber('DJ', 1234, 3)).toBe('DJ-1234');
    expect(drawingNumber('DJ-025', 'MEC', 1)).toBe('DJ-025-MEC-001');
  });

  it('names files from the drawing and revision, never from the upload', () => {
    expect(revisionFileName('DJ-025-MEC-001', 'B', 'pdf', 1, 'pdf')).toBe('DJ-025-MEC-001_B.pdf');
    expect(revisionFileName('DJ-025-MEC-001', 'B', 'source', 1, 'dwg')).toBe('DJ-025-MEC-001_B_source.dwg');
    expect(revisionFileName('DJ-025-MEC-001', '0', 'bom', 2, 'csv')).toBe('DJ-025-MEC-001_0_bom-2.csv');
  });
});
