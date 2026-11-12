import { describe, expect, it } from 'vitest';
import { attendanceDateProblem, attendanceMinutes, attendanceRange, istClock, sameAttendance } from './external-attendance';
import { canRecordExternalAttendance } from './ticket-access';

const today = '2026-11-11';

describe('external staff attendance: which days', () => {
  const onSite = { fromDate: '2026-11-01', toDate: null };
  it('today and earlier days on site within the window', () => {
    expect(attendanceDateProblem(today, onSite, today, 7)).toBeNull();
    expect(attendanceDateProblem('2026-11-04', onSite, today, 7)).toBeNull();     // exactly 7 days back
  });
  it('not a future day, before their first day, after their last day, or older than the window', () => {
    expect(attendanceDateProblem('2026-11-12', onSite, today, 7)).toBe('FUTURE');
    expect(attendanceDateProblem('2026-10-31', onSite, today, 30)).toBe('BEFORE_START');
    expect(attendanceDateProblem('2026-11-10', { fromDate: '2026-11-01', toDate: '2026-11-09' }, today, 7)).toBe('AFTER_END');
    expect(attendanceDateProblem('2026-11-03', onSite, today, 7)).toBe('TOO_OLD');
    expect(attendanceDateProblem('2026-11-10', onSite, today, 0)).toBe('TOO_OLD');  // 0: today only
  });
});

describe('external staff attendance: list range', () => {
  it('defaults to the last 31 days up to today, or up to the given end', () => {
    expect(attendanceRange({}, today)).toEqual({ from: '2026-10-12', to: today });
    expect(attendanceRange({ to: '2026-10-31' }, today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(attendanceRange({ from: '2026-11-01' }, today)).toEqual({ from: '2026-11-01', to: today });
  });
  it('refuses a reversed range or more than 92 days', () => {
    expect(attendanceRange({ from: '2026-11-05', to: '2026-11-01' }, today)).toBeNull();
    expect(attendanceRange({ from: '2026-08-12', to: today }, today)).toEqual({ from: '2026-08-12', to: today }); // 92 days
    expect(attendanceRange({ from: '2026-08-11', to: today }, today)).toBeNull();
  });
});

describe('external staff attendance: values', () => {
  it('IST clock times on the work date become UTC instants; minutes only with both times', () => {
    expect(istClock('2026-11-10', '09:00').toISOString()).toBe('2026-11-10T03:30:00.000Z');
    expect(istClock('2026-11-10', '00:15').toISOString()).toBe('2026-11-09T18:45:00.000Z');
    expect(attendanceMinutes(istClock('2026-11-10', '09:00'), istClock('2026-11-10', '17:45'))).toBe(525);
    expect(attendanceMinutes(istClock('2026-11-10', '09:00'), null)).toBeNull();
  });
  it('a resend with the same values is the same; any change is not', () => {
    const a = { status: 'present', timeIn: istClock(today, '09:00'), timeOut: null, note: null };
    expect(sameAttendance(a, { ...a, timeIn: istClock(today, '09:00') })).toBe(true);
    expect(sameAttendance(a, { ...a, timeOut: istClock(today, '18:00') })).toBe(false);
    expect(sameAttendance(a, { ...a, status: 'half_day' })).toBe(false);
    expect(sameAttendance(a, { ...a, note: 'Left early' })).toBe(false);
  });
});

describe('who records an outside worker\'s attendance', () => {
  const none = { headsDepartment: false, supervises: false, assignee: false, primary: false };
  const siteSup = { view: 'team', work: 'team', manage: undefined, site: 'team', management: false } as const;
  const head = { view: 'team', work: 'team', manage: 'team', management: false } as const;
  const staff = { view: 'own', work: 'own', manage: undefined, management: false } as const;
  const ceo = { view: 'all', work: undefined, manage: 'all', management: true } as const;
  it('the on-site supervisor who added the worker; not one who did not add them', () => {
    expect(canRecordExternalAttendance(siteSup, { ...none, supervises: true }, true)).toBe(true);
    expect(canRecordExternalAttendance(siteSup, { ...none, supervises: true }, false)).toBe(false);
  });
  it('not someone who added the worker but no longer runs the site (no longer the supervisor)', () => {
    expect(canRecordExternalAttendance(siteSup, none, true)).toBe(false);
  });
  it('an assignee never, even one who added the worker', () => {
    expect(canRecordExternalAttendance(staff, { ...none, assignee: true }, false)).toBe(false);
    expect(canRecordExternalAttendance(staff, { ...none, assignee: true }, true)).toBe(false);
  });
  it('the ticket\'s managers and Management, whoever added the worker', () => {
    expect(canRecordExternalAttendance(head, { ...none, headsDepartment: true }, false)).toBe(true);
    expect(canRecordExternalAttendance(head, none, false)).toBe(false);
    expect(canRecordExternalAttendance(ceo, none, false)).toBe(true);
  });
});
