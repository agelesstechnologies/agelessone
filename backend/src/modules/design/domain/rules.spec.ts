import { describe, expect, it } from 'vitest';
import { statusChange } from './jobs';
import { checklistProblem, storedChecklist } from './qc';
import { IssueCandidate, issueProblem } from './transmittals';

describe('design job statuses', () => {
  it('moves forward one step at a time: received, accepted, in design, closed', () => {
    expect(statusChange({ status: 'received', resumeStatus: null }, 'accepted')).toEqual({ status: 'accepted', resumeStatus: null });
    expect(statusChange({ status: 'accepted', resumeStatus: null }, 'in_design')).toEqual({ status: 'in_design', resumeStatus: null });
    expect(statusChange({ status: 'in_design', resumeStatus: null }, 'closed')).toEqual({ status: 'closed', resumeStatus: null });
    expect(statusChange({ status: 'received', resumeStatus: null }, 'closed')).toMatchObject({ problem: expect.stringMatching(/next: accepted/) });
  });

  it('a hold remembers where the job was and goes back only there; cancel from any open status; closed and cancelled stay', () => {
    expect(statusChange({ status: 'accepted', resumeStatus: null }, 'on_hold')).toEqual({ status: 'on_hold', resumeStatus: 'accepted' });
    expect(statusChange({ status: 'on_hold', resumeStatus: 'accepted' }, 'accepted')).toEqual({ status: 'accepted', resumeStatus: null });
    expect(statusChange({ status: 'on_hold', resumeStatus: 'accepted' }, 'in_design')).toMatchObject({ problem: expect.stringMatching(/goes back to accepted/) });
    expect(statusChange({ status: 'on_hold', resumeStatus: 'accepted' }, 'cancelled')).toEqual({ status: 'cancelled', resumeStatus: null });
    expect(statusChange({ status: 'closed', resumeStatus: null }, 'on_hold')).toMatchObject({ problem: expect.stringMatching(/no longer changes/) });
    expect(statusChange({ status: 'cancelled', resumeStatus: null }, 'accepted')).toMatchObject({ problem: expect.stringMatching(/no longer changes/) });
  });
});

describe('QC checklist', () => {
  const items = ['Title block complete', 'Dimensions checked'];
  const all = (passed: boolean) => items.map((item) => ({ item, passed }));

  it('every item answered once, nothing else; matched without regard to case or spacing', () => {
    expect(checklistProblem(items, all(true), 'approved')).toBeNull();
    expect(checklistProblem(items, [{ item: ' title  BLOCK complete ', passed: true }, { item: 'dimensions checked', passed: true }], 'approved')).toBeNull();
    expect(checklistProblem(items, [{ item: 'Title block complete', passed: true }], 'approved')).toMatch(/missing: Dimensions checked/);
    expect(checklistProblem(items, [...all(true), { item: 'Colour', passed: true }], 'approved')).toMatch(/not on the QC checklist/);
    expect(checklistProblem(items, [...all(true), { item: 'Dimensions checked', passed: false }], 'approved')).toMatch(/twice/);
  });

  it('approved only when every item passed; changes needed may have failures', () => {
    expect(checklistProblem(items, [{ item: items[0], passed: true }, { item: items[1], passed: false }], 'approved')).toMatch(/every checklist item passed/);
    expect(checklistProblem(items, all(false), 'changes_needed')).toBeNull();
  });

  it('stores the checklist\'s own wording and order', () => {
    expect(storedChecklist(items, [{ item: 'dimensions checked', passed: false, note: ' see sheet 2 ' }, { item: 'title block complete', passed: true }]))
      .toEqual([{ item: 'Title block complete', passed: true, note: null }, { item: 'Dimensions checked', passed: false, note: 'see sheet 2' }]);
  });
});

describe('what a transmittal may issue', () => {
  const rev = (over: Partial<IssueCandidate> = {}): IssueCandidate =>
    ({ label: 'DJ-001-MEC-001 rev A', jobId: 1, drawingId: 10, status: 'qc_approved', stage: 'preliminary', laterIssued: false, ...over });

  it('QC-approved revisions of the job, one per drawing', () => {
    expect(issueProblem(1, 'for_approval', [rev(), rev({ drawingId: 11 })])).toBeNull();
    expect(issueProblem(1, 'for_approval', [rev({ status: 'submitted' })])).toMatchObject({ code: 'DESIGN_NOT_QC_APPROVED' });
    expect(issueProblem(1, 'for_approval', [rev({ status: 'changes_needed' })])).toMatchObject({ code: 'DESIGN_NOT_QC_APPROVED' });
    expect(issueProblem(1, 'for_approval', [rev({ jobId: 2 })])).toMatchObject({ code: 'DESIGN_REVISION_OTHER_JOB' });
    expect(issueProblem(1, 'for_approval', [rev(), rev()])).toMatchObject({ code: 'DESIGN_ONE_PER_DRAWING' });
  });

  it('for construction: construction revisions only; never older than one already issued', () => {
    expect(issueProblem(1, 'for_construction', [rev()])).toMatchObject({ code: 'DESIGN_NOT_CONSTRUCTION' });
    expect(issueProblem(1, 'for_construction', [rev({ stage: 'construction' })])).toBeNull();
    expect(issueProblem(1, 'for_information', [rev({ laterIssued: true })])).toMatchObject({ code: 'DESIGN_NEWER_ISSUED' });
  });
});
