import { describe, expect, it } from 'vitest';
import { checkDetails } from './type-details';
import { nextStatus } from './lifecycle';
import { missingForCompletion, WorkDone } from './completion';
import { canComplete, canCreate, canManage, canView, canWork } from './ticket-access';

const fields = [
  { key: 'vendor', label: 'Vendor', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'money', required: true },
  { key: 'dispatch_date', label: 'Dispatch date', type: 'date', required: false },
  { key: 'bill', label: 'Bill', type: 'file', required: true },
  { key: 'owner', label: 'Owner', type: 'person', required: false },
];
const ID = '00000000-0000-4000-8000-000000000001';

describe('type details', () => {
  it('accepts values of the right types and trims text', () => {
    const r = checkDetails(fields, { vendor: '  Acme ', amount: 150000, dispatch_date: '2026-11-06', owner: ID }, { filesLater: true });
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ vendor: 'Acme', amount: 150000, dispatch_date: '2026-11-06', owner: ID });
    expect(r.personIds).toEqual([ID]);
  });
  it('lists every problem: required, wrong type, unknown key', () => {
    const r = checkDetails(fields, { amount: 10.5, dispatch_date: '6/11/2026', colour: 'red', owner: 'Ravi' }, { filesLater: true });
    expect(r.errors).toEqual(['colour: not a field of this ticket type', 'vendor: required', 'amount: must be whole paise, 0 or more',
      'dispatch_date: must be a date (YYYY-MM-DD)', "owner: must be a person's publicId"]);
  });
  it('a required file can come later (it is checked at completion)', () => {
    expect(checkDetails(fields, { vendor: 'A', amount: 1 }, { filesLater: true }).errors).toEqual([]);
    expect(checkDetails(fields, { vendor: 'A', amount: 1 }, { filesLater: false }).errors).toEqual(['bill: required']);
  });
});

describe('lifecycle', () => {
  it('follows open → assigned → in_progress ⇄ on_hold → completed → (reopen) in_progress', () => {
    expect(nextStatus('open', 'assign')).toBe('assigned');
    expect(nextStatus('in_progress', 'assign')).toBe('in_progress');
    expect(nextStatus('assigned', 'start')).toBe('in_progress');
    expect(nextStatus('in_progress', 'hold')).toBe('on_hold');
    expect(nextStatus('on_hold', 'resume')).toBe('in_progress');
    expect(nextStatus('in_progress', 'complete')).toBe('completed');
    expect(nextStatus('completed', 'reopen')).toBe('in_progress');
  });
  it('refuses moves that skip steps or touch finished tickets', () => {
    expect(nextStatus('open', 'start')).toBeNull();
    expect(nextStatus('assigned', 'complete')).toBeNull();
    expect(nextStatus('on_hold', 'complete')).toBeNull();
    expect(nextStatus('completed', 'cancel')).toBeNull();
    expect(nextStatus('cancelled', 'reopen')).toBeNull();
    expect(nextStatus('cancelled', 'assign')).toBeNull();
    for (const s of ['open', 'assigned', 'in_progress', 'on_hold'] as const) expect(nextStatus(s, 'cancel')).toBe('cancelled');
  });
});

describe('completion', () => {
  const done = (over: Partial<WorkDone> = {}): WorkDone => ({ photos: 0, files: 0, signoffs: 0, dailyUpdates: 0, headApproved: false,
    checklistItems: ['A', 'B'], answered: new Set(), fields: [], details: {}, ...over });
  const all = { photo_required: true, file_required: true, checklist_required: true, customer_signoff_required: true,
    head_approval_required: true, daily_update_required: true };
  it('lists everything still missing', () => {
    expect(missingForCompletion(all, done({ answered: new Set(['A']), fields, details: { vendor: 'x' } }))).toEqual([
      'field:amount', 'field:bill', 'photo', 'file', 'checklist:B', 'customer_signoff', 'head_approval', 'daily_update']);
  });
  it('nothing missing when every rule is met; no rules, nothing to check', () => {
    expect(missingForCompletion(all, done({ photos: 1, files: 1, signoffs: 1, dailyUpdates: 1, headApproved: true, answered: new Set(['A', 'B']) }))).toEqual([]);
    expect(missingForCompletion({}, done())).toEqual([]);
  });
});

describe('who may do what', () => {
  const none = { headsDepartment: false, supervises: false, assignee: false, primary: false };
  const staff = { view: 'own', work: 'own', manage: undefined, management: false } as const;
  const head = { view: 'team', work: 'team', manage: 'team', management: false } as const;
  const hr = { view: 'all', work: undefined, manage: undefined, management: false } as const;
  it('staff see and work on tickets they are assigned to; complete only as primary', () => {
    expect(canView(staff, none)).toBe(false);
    expect(canView(staff, { ...none, assignee: true })).toBe(true);
    expect(canWork(staff, { ...none, assignee: true })).toBe(true);
    expect(canComplete(staff, { ...none, assignee: true })).toBe(false);
    expect(canComplete(staff, { ...none, assignee: true, primary: true })).toBe(true);
    expect(canManage(staff, { ...none, assignee: true, primary: true })).toBe(false);
  });
  it('a head manages only their departments\' (or supervised) tickets', () => {
    expect(canManage(head, none)).toBe(false);
    expect(canView(head, none)).toBe(false);
    expect(canManage(head, { ...none, headsDepartment: true })).toBe(true);
    expect(canManage(head, { ...none, supervises: true })).toBe(true);
  });
  it('HR only views; scope all and Management do everything', () => {
    expect(canView(hr, none)).toBe(true);
    expect(canWork(hr, none)).toBe(false);
    expect(canManage({ view: 'all', work: undefined, manage: 'all', management: false }, none)).toBe(true);
    expect(canComplete({ view: undefined, work: undefined, manage: undefined, management: true }, none)).toBe(true);
  });
});

describe('who creates a ticket', () => {
  const supervisor = { view: 'team', work: 'team', manage: 'team', create: 'team', management: false } as const;
  const headOnly = { view: 'team', work: undefined, manage: 'team', management: false } as const;
  const ceo = { view: 'all', work: undefined, manage: 'all', management: true } as const;
  const adminUser = { view: 'all', work: undefined, manage: 'all', management: false } as const;
  const staff = { view: 'own', work: 'own', manage: undefined, management: false } as const;

  it('a supervisor: any department of a company they work in, not another company', () => {
    expect(canCreate(supervisor, { headsDepartment: false, worksInCompany: true })).toBe(true);
    expect(canCreate(supervisor, { headsDepartment: false, worksInCompany: false })).toBe(false);
  });

  it('a department head: their own department', () => {
    expect(canCreate(headOnly, { headsDepartment: true, worksInCompany: true })).toBe(true);
    expect(canCreate(headOnly, { headsDepartment: false, worksInCompany: true })).toBe(false);
  });

  it('the CEO (Management) and Admin user run tickets but do not create them; staff neither', () => {
    for (const c of [ceo, adminUser, staff]) expect(canCreate(c, { headsDepartment: false, worksInCompany: true })).toBe(false);
  });
});
