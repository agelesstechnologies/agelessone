/** Drawing revisions: codes, what is still open, what a new issue supersedes. Pure. */

export type Stage = 'preliminary' | 'construction';
export type RevisionStatus = 'draft' | 'submitted' | 'qc_approved' | 'changes_needed' | 'issued' | 'accepted' | 'returned' | 'superseded';

/** Statuses in which a revision is still being worked on: a drawing has at most one, and no new revision meanwhile. */
export const IN_PROGRESS: RevisionStatus[] = ['draft', 'submitted'];
/** The drawing's earlier revisions that a newly issued one supersedes (issued ones, and approved ones never issued). */
export const SUPERSEDED_BY_ISSUE: RevisionStatus[] = ['qc_approved', 'issued', 'accepted', 'returned'];
/** Statuses of a revision that has gone to the client. */
export const ISSUED: RevisionStatus[] = ['issued', 'accepted', 'returned', 'superseded'];

/** A = 1 … Z = 26, AA = 27 … ZZ = 702. */
export function letterIndex(code: string): number {
  return [...code].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
}
/** 1 = A … 26 = Z, 27 = AA … 702 = ZZ. */
export function letters(n: number): string {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return s;
}

/**
 * The code of a drawing's next revision. preliminary: the letter after the highest so far (A first); construction: the
 * number after the highest so far (0 first). No more letters once the drawing has a construction revision.
 */
export function nextRevisionCode(stage: Stage, existing: { stage: Stage; code: string }[]): { code: string } | { problem: string } {
  if (stage === 'preliminary') {
    if (existing.some((r) => r.stage === 'construction')) {
      return { problem: 'The drawing already has a construction revision: the next ones are numbered (stage construction)' };
    }
    const highest = Math.max(0, ...existing.map((r) => letterIndex(r.code)));
    if (highest >= 702) return { problem: 'No letters left (ZZ is the last)' };
    return { code: letters(highest + 1) };
  }
  const numbers = existing.filter((r) => r.stage === 'construction').map((r) => Number(r.code));
  const next = numbers.length ? Math.max(...numbers) + 1 : 0;
  if (next > 999) return { problem: 'No numbers left (999 is the last)' };
  return { code: String(next) };
}
