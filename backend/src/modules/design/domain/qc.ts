/** The QC checklist (policy design.qc_checklist). Pure. */

export interface Answer { item: string; passed: boolean; note?: string }
export interface StoredAnswer { item: string; passed: boolean; note: string | null }

const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Every item of the checklist answered exactly once, nothing else; approved only when every item passed (otherwise
 * the decision is changes_needed). Items match without regard to case or spacing.
 */
export function checklistProblem(items: string[], answers: Answer[], decision: 'approved' | 'changes_needed'): string | null {
  const wanted = new Set(items.map(key));
  const seen = new Set<string>();
  for (const a of answers) {
    const k = key(a.item);
    if (!wanted.has(k)) return `"${a.item}" is not on the QC checklist`;
    if (seen.has(k)) return `"${a.item}" is answered twice`;
    seen.add(k);
  }
  const missing = items.filter((i) => !seen.has(key(i)));
  if (missing.length) return `Answer every checklist item (missing: ${missing.join('; ')})`;
  if (decision === 'approved' && answers.some((a) => !a.passed)) return 'Approve only when every checklist item passed; otherwise decide changes_needed';
  return null;
}

/** The answers as stored: the checklist's own wording and order. Call after checklistProblem found none. */
export function storedChecklist(items: string[], answers: Answer[]): StoredAnswer[] {
  const byKey = new Map(answers.map((a) => [key(a.item), a]));
  return items.map((item) => {
    const a = byKey.get(key(item))!;
    return { item, passed: a.passed, note: a.note?.trim() || null };
  });
}
