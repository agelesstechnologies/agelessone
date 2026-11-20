/**
 * Permission codes of the Design module (rows in core.permissions, migration 0055). Held with scope all they count in
 * every company; with scope own or team, in the companies the person holds a job in. The Designing head needs none: they
 * are the head of the department in policy design.department_prefix. Assignees of a job's tickets work on its drawings.
 */
export const DESIGN = {
  /** see every design job, drawing, transmittal and the reports (Management, Design QC, Admin user) */
  view: 'design.view',
  /** create and run design jobs, issue transmittals, record client responses (Admin user) */
  manage: 'design.jobs.manage',
  /** review submitted revisions (Design QC) */
  qc: 'design.qc',
} as const;
