/** Numbers of design records. Pure. */

export type Series = 'job' | 'transmittal';

/** A number of a series: the prefix, a dash, the counter with at least `digits` digits (DJ-025, TR-0001). */
export const seriesNumber = (prefix: string, n: number, digits: number): string => `${prefix}-${String(n).padStart(digits, '0')}`;

/** A drawing's number: <job number>-<discipline>-<seq, 3 digits> (DJ-025-MEC-001). */
export const drawingNumber = (jobNumber: string, discipline: string, seq: number): string => `${jobNumber}-${discipline}-${String(seq).padStart(3, '0')}`;

/** A file's name as the server gives it (never the uploaded name): DJ-025-MEC-001_B.pdf, DJ-025-MEC-001_B_source-2.dwg. */
export function revisionFileName(drawing: string, code: string, kind: 'pdf' | 'source' | 'bom', n: number, ext: string): string {
  return kind === 'pdf' ? `${drawing}_${code}.pdf` : `${drawing}_${code}_${kind}${n > 1 ? `-${n}` : ''}.${ext}`;
}
