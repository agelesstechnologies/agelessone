/** Design job statuses. Pure. */

export type JobStatus = 'received' | 'accepted' | 'in_design' | 'on_hold' | 'closed' | 'cancelled';
export interface JobState { status: JobStatus; resumeStatus: JobStatus | null }

const LABEL: Record<JobStatus, string> = {
  received: 'received', accepted: 'accepted', in_design: 'in design', on_hold: 'on hold', closed: 'closed', cancelled: 'cancelled',
};
const NEXT: Partial<Record<JobStatus, JobStatus>> = { received: 'accepted', accepted: 'in_design', in_design: 'closed' };

/** A closed or cancelled job no longer changes (no edits, drawings, revisions, links or transmittals). */
export const isOpen = (s: JobStatus): boolean => s !== 'closed' && s !== 'cancelled';

/**
 * The job after a status change, or why not. Forward one step: received → accepted → in_design → closed. on_hold from
 * any open status (it remembers where it was), and back only to that status; cancelled from any open status.
 */
export function statusChange(s: JobState, to: Exclude<JobStatus, 'received'>): { status: JobStatus; resumeStatus: JobStatus | null } | { problem: string } {
  if (!isOpen(s.status)) return { problem: `The job is ${LABEL[s.status]}: it no longer changes` };
  if (to === s.status) return { problem: `The job is already ${LABEL[to]}` };
  if (to === 'cancelled') return { status: 'cancelled', resumeStatus: null };
  if (to === 'on_hold') return { status: 'on_hold', resumeStatus: s.status };
  if (s.status === 'on_hold') {
    return to === s.resumeStatus ? { status: to, resumeStatus: null }
      : { problem: `A job on hold goes back to ${LABEL[s.resumeStatus ?? 'received']} (or is cancelled)` };
  }
  if (NEXT[s.status] === to) return { status: to, resumeStatus: null };
  return { problem: `A job that is ${LABEL[s.status]} does not become ${LABEL[to]} (next: ${LABEL[NEXT[s.status]!]})` };
}
