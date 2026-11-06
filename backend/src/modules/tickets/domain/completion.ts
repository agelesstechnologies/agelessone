import { FieldDef, missingRequired } from './type-details';

/** The completion rules of a type version (all false when absent). */
export interface Rules {
  photo_required?: boolean; file_required?: boolean; checklist_required?: boolean;
  customer_signoff_required?: boolean; head_approval_required?: boolean; daily_update_required?: boolean;
}

/** What has been done on the ticket so far. */
export interface WorkDone {
  photos: number; files: number; signoffs: number; dailyUpdates: number; headApproved: boolean;
  checklistItems: string[];
  /** items answered (pass, fail or na) */
  answered: Set<string>;
  fields: FieldDef[];
  details: Record<string, unknown>;
}

/**
 * What still stops completion, as stable codes: photo, file, checklist:<item>, customer_signoff, head_approval,
 * daily_update, field:<key> (every required field, files included). Empty: it can be completed.
 */
export function missingForCompletion(rules: Rules, done: WorkDone): string[] {
  const missing: string[] = missingRequired(done.fields, done.details).map((k) => `field:${k}`);
  if (rules.photo_required && done.photos === 0) missing.push('photo');
  if (rules.file_required && done.files === 0) missing.push('file');
  if (rules.checklist_required) for (const item of done.checklistItems) if (!done.answered.has(item)) missing.push(`checklist:${item}`);
  if (rules.customer_signoff_required && done.signoffs === 0) missing.push('customer_signoff');
  if (rules.head_approval_required && !done.headApproved) missing.push('head_approval');
  if (rules.daily_update_required && done.dailyUpdates === 0) missing.push('daily_update');
  return missing;
}
