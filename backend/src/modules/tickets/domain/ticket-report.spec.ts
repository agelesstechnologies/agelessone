import { describe, expect, it } from 'vitest';
import type { TicketDetail } from '@ageless/shared';
import { buildTicketReport, dayText, eventText, fieldText, istDateTime, lookups, minutesText, ReportFacts, rupees } from './ticket-report';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number, displayName: string) => ({ publicId: id(n), displayName });
const AT = '2026-11-10T03:30:00.000Z';            // 10 Nov 2026 09:00 IST

function facts(over: Partial<TicketDetail> = {}): ReportFacts {
  const ticket: TicketDetail = {
    publicId: id(1), number: 'AE-0042', company: 'AE', title: 'Gate repair', priority: 2, status: 'in_progress',
    type: { publicId: id(2), version: 3, code: 'site_work', name: 'Site work' }, department: { publicId: id(3), name: 'Rides' },
    supervisor: person(10, 'Sam Supervisor'), primaryAssignee: null, customerId: null, site: 'Test Park', scheduledAt: AT, dueDate: '2026-11-20',
    overdue: false, completedAt: null, createdAt: AT, description: 'Fix the gate', projectId: null, holdReason: null, cancelReason: null,
    requiredSkill: null, headApproval: null, createdBy: person(11, 'Maya Manager'),
    details: { customer: 'Wonder Park', amount: 12345650, visit: '2026-11-12', owner: id(12), bill: id(50) },
    typeRules: {
      fields: [{ key: 'customer', label: 'Customer', type: 'customer', required: true }, { key: 'amount', label: 'Amount', type: 'money', required: false },
        { key: 'visit', label: 'Visit date', type: 'date', required: false }, { key: 'owner', label: 'Owner', type: 'person', required: false },
        { key: 'bill', label: 'Bill', type: 'file', required: false }],
      completionRules: { photo_required: true, file_required: false, checklist_required: true, customer_signoff_required: true, head_approval_required: false, daily_update_required: false },
      checklistItems: ['Hinges oiled'],
    },
    assignees: [], checklist: [{ item: 'Hinges oiled', result: 'pass', note: 'Done twice', checkedBy: person(20, 'Tara Tech'), checkedAt: AT }],
    attachments: [],
    signoffs: [{ publicId: id(60), signerName: 'Cora Customer', signerRole: 'Park manager', signedAt: AT, photoPublicId: id(52), recordedBy: person(20, 'Tara Tech') }],
    links: [{ direction: 'to', kind: 'rework_of', ticket: { publicId: id(5), number: 'AE-0040', title: 'Gate install', status: 'completed' } }],
    timeline: [
      { action: 'created', actor: person(11, 'Maya Manager'), at: AT, details: { number: 'AE-0042', type: 'site_work', typeVersion: 3 } },
      { action: 'assignees_changed', actor: person(11, 'Maya Manager'), at: AT, details: { added: [id(120)], removed: [], primary: id(120), from: 'open', to: 'assigned' } },
      { action: 'external_attendance_changed', actor: person(10, 'Sam Supervisor'), at: AT,
        details: { externalStaff: id(70), workDate: '2026-11-10', from: { status: 'present', timeIn: null, timeOut: null }, to: { status: 'half_day', timeIn: AT, timeOut: null } } },
      { action: 'report_downloaded', actor: person(11, 'Maya Manager'), at: AT, details: {} },
    ],
    reassignRequests: [], missingForCompletion: ['photo', 'checklist:Hinges oiled'], warnings: [], canDownloadReport: true,
    ...over,
  };
  const file = (n: number, kind: string, fileType: string) => ({ publicId: id(n), kind, fileType, file: `tickets/2026/11/${n}.${fileType}`, uploadedBy: 'Tara Tech', uploadedAt: AT });
  return {
    company: { code: 'AE', name: 'Test Entertainments' }, ticket, generatedBy: 'Maya Manager', generatedAt: AT,
    assignments: [
      { employmentPublicId: id(120), employeeCode: 'T-1', personPublicId: id(20), personName: 'Tara Tech', isPrimary: true, assignedAt: AT, assignedBy: 'Maya Manager', endedAt: null, endedBy: null },
      { employmentPublicId: id(121), employeeCode: 'T-2', personPublicId: id(21), personName: 'Omar Old', isPrimary: false, assignedAt: AT, assignedBy: 'Maya Manager', endedAt: AT, endedBy: 'Maya Manager' },
    ],
    timelogs: { logs: [{ publicId: id(80), person: person(20, 'Tara Tech'), employeeCode: 'T-1', startedAt: AT, endedAt: '2026-11-10T05:30:00.000Z',
      endReason: 'manual', timerMinutes: 120, address: 'Test Road 1, Test Town' }], totals: [{ person: person(20, 'Tara Tech'), minutes: 125 }], totalMinutes: 125 },
    adjustments: [{ workDate: '2026-11-10', personPublicId: id(20), personName: 'Tara Tech', minutes: 5, reason: 'Forgot to punch', adjustedBy: 'Maya Manager', adjustedAs: 'head', at: AT }],
    dailyUpdates: [
      { publicId: id(91), workDate: '2026-11-11', person: person(20, 'Tara Tech'), note: 'Second day', percentComplete: 80, attachments: [], createdAt: AT },
      { publicId: id(90), workDate: '2026-11-10', person: person(20, 'Tara Tech'), note: 'First day', percentComplete: 40,
        attachments: [{ publicId: id(51), kind: 'photo', fileType: 'png' }], createdAt: AT },
    ],
    files: [file(50, 'file', 'pdf'), file(51, 'photo', 'png'), file(52, 'signoff', 'jpg'), file(53, 'file', 'jpg')],
    workers: [{ publicId: id(70), name: 'Ravi Welder', phone: '+91 00000 12345', agency: 'Goa Labour Co', trade: 'Welder', fromDate: '2026-11-01', toDate: null,
      photo: 'tickets/2026/11/ravi.png', addedBy: 'Sam Supervisor', addedAt: AT }],
    attendance: [
      { publicId: id(72), staff: { publicId: id(70), name: 'Ravi Welder' }, workDate: '2026-11-10', status: 'half_day', timeIn: AT, timeOut: null, minutes: null, note: null,
        recordedBy: person(10, 'Sam Supervisor'), recordedAt: AT, updatedBy: person(10, 'Sam Supervisor'), updatedAt: AT },
      { publicId: id(71), staff: { publicId: id(70), name: 'Ravi Welder' }, workDate: '2026-11-09', status: 'present', timeIn: AT, timeOut: '2026-11-09T12:00:00.000Z',
        minutes: 510, note: 'Bay 2', recordedBy: person(10, 'Sam Supervisor'), recordedAt: AT, updatedBy: null, updatedAt: null },
    ],
    personNames: { [id(12)]: 'Olga Owner' },
  };
}

const texts = (r: ReturnType<typeof buildTicketReport>, title: string) => {
  const s = r.sections.find((x) => x.title.startsWith(title))!;
  return JSON.stringify(s.blocks);
};

describe('ticket report formatting', () => {
  it('shows money in rupees, minutes as hours, times and days in IST', () => {
    expect(rupees(12345650)).toBe('Rs 1,23,456.50');
    expect(rupees(0)).toBe('Rs 0.00');
    expect([minutesText(45), minutesText(125), minutesText(0), minutesText(-30)]).toEqual(['45 min', '2 h 05 min', '0 min', '-30 min']);
    expect(istDateTime('2026-11-10T20:00:00.000Z')).toBe('11 Nov 2026 01:30');
    expect(dayText('2026-11-12')).toBe('12 Nov 2026');
  });

  it("writes the type's field values in words: money, dates, people and files by name", () => {
    const f = facts();
    const names = lookups(f);
    expect(fieldText('money', 150000, names)).toBe('Rs 1,500.00');
    expect(fieldText('date', '2026-11-12', names)).toBe('12 Nov 2026');
    expect(fieldText('person', id(12), names)).toBe('Olga Owner');
    expect(fieldText('file', id(50), names)).toBe('file (PDF) uploaded by Tara Tech, 10 Nov 2026 09:00');
    expect(fieldText('text', '', names)).toBe('-');
  });

  it('turns timeline events into sentences with names', () => {
    const names = lookups(facts());
    const [created, assigned, corrected, downloaded] = facts().ticket.timeline;
    expect(eventText(created, names)).toBe('Created the ticket AE-0042 (type site_work, version 3)');
    expect(eventText(assigned, names)).toBe('Assignees changed: added Tara Tech; primary: Tara Tech (open to assigned)');
    expect(eventText(corrected, names)).toBe('Attendance of Ravi Welder for 10 Nov 2026 corrected from present to half day 09:00-?');
    expect(eventText(downloaded, names)).toBe('Downloaded the full report (PDF)');
    expect(eventText({ action: 'time_stopped', details: { reason: 'unfinished' } }, names)).toBe('Timer stopped: Missed punch (no time counted)');
    expect(eventText({ action: 'something_new', details: null }, names)).toBe('Something new');
  });
});

describe('buildTicketReport', () => {
  const r = buildTicketReport(facts());

  it('has every part of the ticket, in order, with the page footer', () => {
    expect(r.sections.map((s) => s.title)).toEqual(['Ticket', 'Assignees and reassignments', 'Details (Site work)', 'Checklist', 'Time',
      'Daily updates and notes', 'Files and photos', 'Customer sign-off and approval', 'Linked tickets', 'External staff', 'History']);
    expect(r.title).toBe('Ticket report AE-0042');
    expect(r.footer(2, 9)).toBe('Ticket AE-0042 - page 2 of 9');
  });

  it('header: company, customer from the type field, who generated it', () => {
    const header = texts(r, 'Ticket');
    for (const s of ['Test Entertainments (AE)', 'AE-0042', 'Wonder Park', 'Site work (version 3)', 'In progress', 'P2', '20 Nov 2026', 'Maya Manager']) expect(header).toContain(s);
  });

  it('people, details, checklist and time in words', () => {
    expect(texts(r, 'Assignees')).toMatch(/Tara Tech.*Primary.*Omar Old.*Taken off/);
    const details = texts(r, 'Details');
    for (const s of ['Rs 1,23,456.50', '12 Nov 2026', 'Olga Owner', 'photo, checklist, customer signoff', 'checklist item \\"Hinges oiled\\"']) expect(details).toContain(s);
    expect(texts(r, 'Checklist')).toContain('PASS');
    const time = texts(r, 'Time');
    for (const s of ['2 h 05 min', 'Test Road 1, Test Town', 'Ticket punch-out', '+5 min', 'Forgot to punch']) expect(time).toContain(s);
  });

  it('daily updates oldest first; photos and image files shown, PDFs listed, the signed sheet under sign-off', () => {
    expect(texts(r, 'Daily updates')).toMatch(/First day.*Second day/);
    const files = r.sections.find((s) => s.title === 'Files and photos')!;
    const images = files.blocks.filter((b) => b.kind === 'image').map((b) => (b.kind === 'image' ? b.file : null));
    expect(images).toEqual(['tickets/2026/11/51.png', 'tickets/2026/11/53.jpg']);
    expect(JSON.stringify(files.blocks)).toContain('with the daily update of 10 Nov 2026');
    const signoff = r.sections.find((s) => s.title.startsWith('Customer sign-off'))!;
    expect(signoff.blocks).toContainEqual(expect.objectContaining({ kind: 'image', file: 'tickets/2026/11/52.jpg' }));
    expect(JSON.stringify(signoff.blocks)).toContain('Cora Customer');
  });

  it('links, outside workers with photo and attendance oldest day first, history', () => {
    expect(texts(r, 'Linked')).toContain('This ticket is rework of');
    const staff = r.sections.find((s) => s.title === 'External staff')!;
    expect(staff.blocks).toContainEqual({ kind: 'image', file: 'tickets/2026/11/ravi.png', size: 'small', caption: 'Photo of Ravi Welder' });
    const json = JSON.stringify(staff.blocks);
    for (const s of ['Goa Labour Co', '+91 00000 12345', 'still on site', '8 h 30 min']) expect(json).toContain(s);
    expect(json.indexOf('["09 Nov 2026","Present","09:00","17:30"')).toBeGreaterThan(-1);
    expect(json.indexOf('["09 Nov 2026"')).toBeLessThan(json.indexOf('["10 Nov 2026","Half day"'));
    expect(texts(r, 'History')).toContain('Downloaded the full report (PDF)');
  });

  it('says so when parts are empty', () => {
    const empty = buildTicketReport({ ...facts({ checklist: [], links: [], signoffs: [] }), files: [], workers: [], attendance: [], dailyUpdates: [], adjustments: [],
      timelogs: { logs: [], totals: [], totalMinutes: 0 } });
    expect(texts(empty, 'Checklist')).toContain('This ticket type has no checklist.');
    expect(texts(empty, 'Files')).toContain('Nothing attached.');
    expect(texts(empty, 'Customer sign-off')).toContain('No customer sign-off recorded (the ticket type requires one).');
    expect(texts(empty, 'External staff')).toContain('No outside workers recorded.');
    expect(texts(empty, 'Time')).toContain('No ticket punches.');
  });
});
