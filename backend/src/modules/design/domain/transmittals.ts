import { RevisionStatus, Stage } from './revisions';

/** What a transmittal may issue. Pure. */

export type Purpose = 'for_approval' | 'for_construction' | 'for_information';
export const PURPOSE_LABEL: Record<Purpose, string> = { for_approval: 'For approval', for_construction: 'For construction', for_information: 'For information' };

export interface IssueCandidate {
  label: string;          // DJ-025-MEC-001 rev B
  jobId: number;
  drawingId: number;
  status: RevisionStatus;
  stage: Stage;
  /** a later revision of the same drawing has already gone to the client */
  laterIssued: boolean;
}

/**
 * Why these revisions cannot be issued together for the job, or null. Only QC-approved revisions of this job; one per
 * drawing; never one older than a revision already issued; for construction: construction revisions only.
 */
export function issueProblem(jobId: number, purpose: Purpose, revisions: IssueCandidate[]): { code: string; message: string } | null {
  const drawings = new Set<number>();
  for (const r of revisions) {
    if (r.jobId !== jobId) return { code: 'DESIGN_REVISION_OTHER_JOB', message: `${r.label} belongs to another design job` };
    if (r.status !== 'qc_approved') return { code: 'DESIGN_NOT_QC_APPROVED', message: `${r.label} is ${r.status.replace('_', ' ')}: only QC-approved revisions are issued` };
    if (r.laterIssued) return { code: 'DESIGN_NEWER_ISSUED', message: `A later revision than ${r.label} has already been issued` };
    if (purpose === 'for_construction' && r.stage !== 'construction') {
      return { code: 'DESIGN_NOT_CONSTRUCTION', message: `${r.label} is a preliminary revision: only construction revisions (0, 1, 2 …) are issued for construction` };
    }
    if (drawings.has(r.drawingId)) return { code: 'DESIGN_ONE_PER_DRAWING', message: 'A transmittal issues one revision of each drawing' };
    drawings.add(r.drawingId);
  }
  return null;
}
