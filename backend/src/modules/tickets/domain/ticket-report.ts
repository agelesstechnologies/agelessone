import type { DailyUpdate, ExternalAttendance, TicketDetail, TicketTimelogs } from '@ageless/shared';
import type { ReportBlock, ReportColumn, ReportDocument, ReportSection } from '../../../platform/report-pdf';

/**
 * The full report of one ticket: everything in it, as sections of rows, tables, notes and photos (by file key), in
 * readable words. Pure: the service gathers the facts, platform/report-pdf draws the result. Times are shown in IST,
 * money in rupees ("Rs": the standard PDF fonts have no rupee sign). Lists run oldest first (time order).
 */

export interface ReportAssignment {
  employmentPublicId: string; employeeCode: string; personPublicId: string; personName: string; isPrimary: boolean;
  assignedAt: string; assignedBy: string; endedAt: string | null; endedBy: string | null;
}
export interface ReportAdjustment {
  workDate: string; personPublicId: string; personName: string; minutes: number; reason: string; adjustedBy: string; adjustedAs: string; at: string;
}
/** An attachment; `file` is the key its bytes are loaded by. */
export interface ReportFile { publicId: string; kind: string; fileType: string; file: string; uploadedBy: string; uploadedAt: string }
export interface ReportWorker {
  publicId: string; name: string; phone: string | null; agency: string | null; trade: string | null; fromDate: string; toDate: string | null;
  /** the photo's file key, if one was added */
  photo: string | null; addedBy: string; addedAt: string;
}
export interface ReportFacts {
  company: { code: string; name: string };
  ticket: TicketDetail;
  generatedBy: string;
  generatedAt: string;
  assignments: ReportAssignment[];
  timelogs: TicketTimelogs;
  adjustments: ReportAdjustment[];
  dailyUpdates: DailyUpdate[];
  files: ReportFile[];
  workers: ReportWorker[];
  attendance: ExternalAttendance[];
  /** names of the people the type's person fields point at, by publicId */
  personNames: Record<string, string>;
}

// ---- formatting ----

const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const CLOCK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const INR = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "12 Nov 2026 09:30" (IST) of an instant. */
export const istDateTime = (iso: string): string => `${DAY.format(new Date(iso))} ${CLOCK.format(new Date(iso))}`;
/** "09:30" (IST) of an instant. */
export const istTime = (iso: string): string => CLOCK.format(new Date(iso));
/** "12 Nov 2026" of a date (YYYY-MM-DD). */
export const dayText = (date: string): string => DAY.format(new Date(`${date}T12:00:00+05:30`));
/** Paise as rupees, Indian grouping: 12345650 → "Rs 1,23,456.50". */
export const rupees = (paise: number): string => `Rs ${INR.format(paise / 100)}`;
/** 45 → "45 min", 125 → "2 h 05 min", -30 → "-30 min". */
export function minutesText(minutes: number): string {
  const a = Math.abs(minutes);
  const h = Math.floor(a / 60);
  return `${minutes < 0 ? '-' : ''}${h ? `${h} h ${String(a % 60).padStart(2, '0')}` : a % 60} min`;
}
const signed = (minutes: number) => (minutes > 0 ? `+${minutesText(minutes)}` : minutesText(minutes));
const words = (s: string) => s.replace(/_/g, ' ');
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const at = (iso: string | null | undefined, by?: string | null) => (iso ? `${istDateTime(iso)}${by ? `, ${by}` : ''}` : '-');

/** A value of one of the type's fields, as text: money in rupees, dates as days, people and files by name. */
export function fieldText(type: string, value: unknown, names: { person: Map<string, string>; file: Map<string, ReportFile> }): string {
  if (value === undefined || value === null || value === '') return '-';
  switch (type) {
    case 'money': return typeof value === 'number' ? rupees(value) : str(value);
    case 'date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? dayText(value) : str(value);
    case 'person': return names.person.get(str(value)) ?? 'unknown person';
    case 'file': {
      const f = names.file.get(str(value));
      return f ? `${f.kind} (${f.fileType.toUpperCase()}) uploaded by ${f.uploadedBy}, ${istDateTime(f.uploadedAt)}` : 'file not found on this ticket';
    }
    default: return typeof value === 'object' ? JSON.stringify(value) : str(value);
  }
}

/** Lookups for names the timeline refers to by publicId. */
export interface Names {
  /** employment publicId → person */
  job: Map<string, string>;
  /** person publicId → name */
  person: Map<string, string>;
  /** outside worker publicId → name */
  worker: Map<string, string>;
  file: Map<string, ReportFile>;
}

const CHANGED: Record<string, string> = {
  typeDetails: 'type details', dueDate: 'due date', scheduledAt: 'scheduled time', supervisorPersonId: 'supervisor',
  requiredSkillId: 'required skill', customerId: 'customer', site: 'site', title: 'title', description: 'description', priority: 'priority',
};
const ENDED: Record<string, string> = { manual: 'Ticket punch-out', day_punch_out: 'Stopped by the daily punch-out', unfinished: 'Missed punch (no time counted)' };

/** One timeline event in readable words (who did it is shown beside it). */
export function eventText(e: { action: string; details: Record<string, unknown> | null }, n: Names): string {
  const d = e.details ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.map((id) => n.job.get(str(id)) ?? 'someone').join(', ') : '');
  const worker = () => n.worker.get(str(d.externalStaff)) ?? 'an outside worker';
  const move = d.from && d.to && typeof d.from === 'string' ? ` (${words(str(d.from))} to ${words(str(d.to))})` : '';
  const times = (v: unknown) => {
    const x = (v ?? {}) as Record<string, unknown>;
    const span = x.timeIn || x.timeOut ? ` ${x.timeIn ? istTime(str(x.timeIn)) : '?'}-${x.timeOut ? istTime(str(x.timeOut)) : '?'}` : '';
    return `${words(str(x.status))}${span}`;
  };
  switch (e.action) {
    case 'created': return d.automatic ? `Created automatically as rework after QC ${str(d.qc)} (rework of ${str(d.reworkOf)})`
      : `Created the ticket ${str(d.number)} (type ${str(d.type)}, version ${str(d.typeVersion)})`;
    case 'details_updated': return `Changed ${(Array.isArray(d.changed) ? d.changed : []).map((k) => CHANGED[str(k)] ?? words(str(k))).join(', ')}`;
    case 'assignees_changed': {
      const parts = [d.added && list(d.added) ? `added ${list(d.added)}` : '', d.removed && list(d.removed) ? `took off ${list(d.removed)}` : '',
        d.primary ? `primary: ${n.job.get(str(d.primary)) ?? 'someone'}` : ''].filter(Boolean);
      return `Assignees changed: ${parts.join('; ')}${move}`;
    }
    case 'started': return `Work started${d.by === 'ticket_punch' ? ' by the first ticket punch-in' : ''}${move}`;
    case 'held': return `Put on hold: ${str(d.reason)}`;
    case 'resumed': return 'Work resumed';
    case 'completed': return 'Ticket completed';
    case 'cancelled': return `Cancelled: ${str(d.reason)}`;
    case 'reopened': return `Reopened: ${str(d.reason)}`;
    case 'checklist_answered': return `Checklist "${str(d.item)}" answered ${words(str(d.result))}`;
    case 'attachment_added': return `Added a ${str(d.kind) || 'file'}`;
    case 'signoff_added': return `Recorded the customer's sign-off by ${str(d.signerName)}`;
    case 'daily_update': return `Daily update for ${d.date ? dayText(str(d.date)) : '?'}: ${str(d.percentComplete)}% done - ${str(d.note)}`
      + (Number(d.files) > 0 ? ` (${str(d.files)} file${Number(d.files) === 1 ? '' : 's'})` : '');
    case 'head_approved': return 'Head approval given';
    case 'linked': return d.to ? `Linked: this ticket ${d.kind === 'rework_of' ? 'is rework of' : 'follows'} ${str(d.to)}`
      : `Linked: ${str(d.from)} ${d.kind === 'rework_of' ? 'is rework of' : 'follows'} this ticket`;
    case 'rework_created': return `Rework ticket ${str(d.ticket)} created${Array.isArray(d.failed) ? ` (failed: ${d.failed.map(str).join('; ')})` : ''}`;
    case 'rework_skipped': return `No rework ticket created: ${str(d.reason)}`;
    case 'reassign_requested': return `Asked to be reassigned: ${str(d.reason)}`;
    case 'reassign_approved': return `Reassignment approved${d.decidedAs === 'management' ? ' (as Management)' : ''}: ${n.job.get(str(d.to)) ?? 'someone'} takes over`;
    case 'reassign_rejected': return `Reassignment rejected: ${str(d.reason)}`;
    case 'time_started': return 'Ticket punch-in (timer started)';
    case 'time_stopped': return `Timer stopped: ${ENDED[str(d.reason)] ?? words(str(d.reason))}`;
    case 'time_adjusted': return `Time of ${n.person.get(str(d.person)) ?? 'someone'} on ${d.date ? dayText(str(d.date)) : '?'} adjusted by ${signed(Number(d.minutes))}`
      + `${d.adjustedAs === 'management' ? ' (as Management)' : ''}: ${str(d.reason)}`;
    case 'external_staff_added': return `Outside worker ${worker()} added`;
    case 'external_staff_ended': return `Last day on site of ${worker()}: ${d.toDate ? dayText(str(d.toDate)) : '?'}`;
    case 'external_attendance_recorded': return `Attendance of ${worker()} for ${d.workDate ? dayText(str(d.workDate)) : '?'}: ${times(d)}`;
    case 'external_attendance_changed': return `Attendance of ${worker()} for ${d.workDate ? dayText(str(d.workDate)) : '?'} corrected from ${times(d.from)} to ${times(d.to)}`;
    case 'report_downloaded': return 'Downloaded the full report (PDF)';
    default: return capital(words(e.action));
  }
}

// ---- the report ----

const cols = (...c: [string, number][]): ReportColumn[] => c.map(([label, width]) => ({ label, width }));
const table = (columns: ReportColumn[], rows: string[][]): ReportBlock => ({ kind: 'table', columns, rows });
const note = (text: string): ReportBlock => ({ kind: 'note', text });
const sub = (text: string): ReportBlock => ({ kind: 'subheading', text });

/** The whole report: one section per part of the ticket. */
export function buildTicketReport(f: ReportFacts): ReportDocument {
  const t = f.ticket;
  const names = lookups(f);
  return {
    title: `Ticket report ${t.number}`,
    subtitle: `${t.title} - ${f.company.name}`,
    footer: (page, pages) => `Ticket ${t.number} - page ${page} of ${pages}`,
    sections: [
      overviewSection(f), peopleSection(f), detailsSection(f, names), checklistSection(f), timeSection(f), updatesSection(f),
      filesSection(f), signoffSection(f), linksSection(f), externalStaffSection(f), historySection(f, names),
    ],
  };
}

export function lookups(f: ReportFacts): Names {
  const person = new Map(Object.entries(f.personNames));
  for (const p of [f.ticket.createdBy, f.ticket.supervisor, ...f.timelogs.logs.map((l) => l.person)]) person.set(p.publicId, p.displayName);
  for (const a of f.assignments) person.set(a.personPublicId, a.personName);
  for (const a of f.adjustments) person.set(a.personPublicId, a.personName);
  return {
    job: new Map(f.assignments.map((a) => [a.employmentPublicId, a.personName])), person,
    worker: new Map(f.workers.map((w) => [w.publicId, w.name])), file: new Map(f.files.map((x) => [x.publicId, x])),
  };
}

/** 1. Header: company, number, title, type, department, status, priority, dates, customer, people, who made the report. */
export function overviewSection(f: ReportFacts): ReportSection {
  const t = f.ticket;
  const started = t.timeline.find((e) => e.action === 'started');
  const status = t.status === 'on_hold' && t.holdReason ? `on hold: ${t.holdReason}` : t.status === 'cancelled' && t.cancelReason ? `cancelled: ${t.cancelReason}` : words(t.status);
  const customerField = t.typeRules.fields.find((x) => x.type === 'customer' && str(t.details[x.key]) !== '');
  const customer = customerField ? str(t.details[customerField.key]) : t.customerId ? `customer id ${t.customerId}` : '-';
  return { title: 'Ticket', blocks: [{ kind: 'rows', rows: [
    ['Company', `${f.company.name} (${f.company.code})`],
    ['Ticket number', t.number],
    ['Title', t.title],
    ['Type', `${t.type.name} (version ${t.type.version})`],
    ['Department', t.department.name],
    ['Status', capital(status)],
    ['Priority', `P${t.priority}${t.priority === 1 ? ' (highest)' : t.priority === 5 ? ' (lowest)' : ''}`],
    ['Scheduled', istDateTime(t.scheduledAt)],
    ['Due date', t.dueDate ? `${dayText(t.dueDate)}${t.overdue ? ' (overdue)' : ''}` : '-'],
    ['Created', `${istDateTime(t.createdAt)} by ${t.createdBy.displayName}`],
    ['Started', started ? at(started.at, started.actor?.displayName) : 'Not started'],
    ['Completed', t.completedAt ? istDateTime(t.completedAt) : 'Not completed'],
    ['Customer', customer],
    ['Site', t.site ?? '-'],
    ['Supervisor', t.supervisor.displayName],
    ['Required skill', t.requiredSkill?.name ?? '-'],
    ['Description', t.description ?? '-'],
    ['Report generated', `${istDateTime(f.generatedAt)} IST by ${f.generatedBy}`],
  ] }, note('All dates and times are India time (IST). Amounts are in Indian rupees (Rs).')] };
}

/** 2. Assignees (current, primary first, then those taken off) and reassignment requests. */
export function peopleSection(f: ReportFacts): ReportSection {
  const current = f.assignments.filter((a) => a.endedAt === null).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const former = f.assignments.filter((a) => a.endedAt !== null);
  const blocks: ReportBlock[] = [sub('Assignees')];
  blocks.push(f.assignments.length === 0 ? note('Nobody has been assigned.') : table(cols(['Person', 0.24], ['Code', 0.12], ['Role', 0.14], ['Assigned', 0.25], ['Taken off', 0.25]),
    [...current, ...former].map((a) => [a.personName, a.employeeCode, a.endedAt ? 'Taken off' : a.isPrimary ? 'Primary' : 'Assignee',
      at(a.assignedAt, a.assignedBy), at(a.endedAt, a.endedBy)])));
  blocks.push(sub('Reassignment requests'));
  const requests = [...f.ticket.reassignRequests].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  blocks.push(requests.length === 0 ? note('No reassignment requests.') : table(cols(['Asked', 0.16], ['By', 0.16], ['Reason', 0.26], ['Status', 0.1], ['Decision', 0.32]),
    requests.map((r) => [istDateTime(r.createdAt), r.requestedBy.displayName, r.reason, r.status,
      r.status === 'pending' ? `Waiting for ${r.approver?.displayName ?? 'an approver'}`
        : `${capital(r.status)} by ${r.decidedBy?.displayName ?? '?'}${r.decidedAs === 'management' ? ' (as Management)' : ''}, ${at(r.decidedAt)}`
          + (r.newAssignee ? `; ${r.newAssignee.displayName} takes over` : '') + (r.decisionReason ? `; reason: ${r.decisionReason}` : '')])));
  return { title: 'Assignees and reassignments', blocks };
}

/** 3. The type's fields with their values, what completion needs and what is still missing. */
export function detailsSection(f: ReportFacts, names: Names): ReportSection {
  const t = f.ticket;
  const fields = t.typeRules.fields;
  const blocks: ReportBlock[] = [fields.length === 0 ? note('This ticket type asks for no details.')
    : { kind: 'rows', rows: fields.map((x) => [`${x.label}${x.required ? ' (required)' : ''}`, fieldText(x.type, t.details[x.key], names)]) }];
  const rules = Object.entries(t.typeRules.completionRules).filter(([, on]) => on).map(([k]) => words(k.replace(/_required$/, '')));
  const missing = t.missingForCompletion.map((m) => (m.startsWith('field:') ? fields.find((x) => x.key === m.slice(6))?.label ?? m.slice(6)
    : m.startsWith('checklist:') ? `checklist item "${m.slice(10)}"` : words(m)));
  blocks.push({ kind: 'rows', rows: [['Needed to complete', rules.length ? rules.join(', ') : 'Nothing besides the required fields'],
    ...(t.status === 'completed' || t.status === 'cancelled' ? [] : [['Still missing', missing.length ? missing.join(', ') : 'Nothing: ready to complete'] as [string, string]])] });
  return { title: `Details (${t.type.name})`, blocks };
}

/** 4. Checklist items with their newest answers. */
export function checklistSection(f: ReportFacts): ReportSection {
  const items = f.ticket.checklist;
  return { title: 'Checklist', blocks: [items.length === 0 ? note('This ticket type has no checklist.')
    : table(cols(['Item', 0.32], ['Result', 0.14], ['Note', 0.28], ['Checked', 0.26]),
      items.map((c) => [c.item, c.result ? words(c.result).toUpperCase() : 'Not answered', c.note ?? '', c.checkedAt ? at(c.checkedAt, c.checkedBy?.displayName) : '-']))] };
}

/** 5. Counted time per person, every ticket punch (with the punch-in place that was confirmed) and reviewers' adjustments. */
export function timeSection(f: ReportFacts): ReportSection {
  const { logs, totals, totalMinutes } = f.timelogs;
  const blocks: ReportBlock[] = [sub('Counted time per person'),
    note('Shared between tickets that ran at the same time, adjustments included; never more than the day\'s attendance.')];
  blocks.push(totals.length === 0 ? note('No time counted yet.')
    : table(cols(['Person', 0.7], ['Counted time', 0.3]), [...totals.map((x) => [x.person.displayName, minutesText(x.minutes)]), ['Total', minutesText(totalMinutes)]]));
  blocks.push(sub('Ticket punches (timelogs)'),
    note('Oldest first. Punch-in place: the address confirmed to the person at the ticket punch-in (coordinates are never shown).'));
  const ordered = [...logs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  blocks.push(ordered.length === 0 ? note('No ticket punches.') : table(
    cols(['Person', 0.18], ['Started', 0.15], ['Ended', 0.15], ['How it ended', 0.16], ['Timer', 0.1], ['Punch-in place', 0.26]),
    ordered.map((l) => [`${l.person.displayName} (${l.employeeCode})`, istDateTime(l.startedAt), l.endedAt ? istDateTime(l.endedAt) : '-',
      l.endReason ? ENDED[l.endReason] : 'Still running', l.timerMinutes !== null ? minutesText(l.timerMinutes) : l.endReason === 'unfinished' ? 'not counted' : '-',
      l.address ?? 'not available'])));
  blocks.push(sub('Time adjustments'));
  blocks.push(f.adjustments.length === 0 ? note('No adjustments.') : table(cols(['Day', 0.12], ['Person', 0.17], ['Change', 0.11], ['Reason', 0.3], ['By', 0.3]),
    f.adjustments.map((a) => [dayText(a.workDate), a.personName, signed(a.minutes), a.reason,
      `${a.adjustedBy}${a.adjustedAs === 'management' ? ' (Management)' : ' (head)'}, ${istDateTime(a.at)}`])));
  return { title: 'Time', blocks };
}

/** 6. Daily updates and notes, oldest first. */
export function updatesSection(f: ReportFacts): ReportSection {
  const updates = [...f.dailyUpdates].sort((a, b) => a.workDate.localeCompare(b.workDate) || a.createdAt.localeCompare(b.createdAt));
  return { title: 'Daily updates and notes', blocks: updates.length === 0 ? [note('No daily updates.')] : [note('Oldest first.'),
    table(cols(['Day', 0.11], ['Person', 0.16], ['Done', 0.07], ['Note', 0.45], ['Files', 0.06], ['Sent', 0.15]),
      updates.map((u) => [dayText(u.workDate), u.person.displayName, `${u.percentComplete}%`, u.note, String(u.attachments.length), istDateTime(u.createdAt)]))] };
}

const isImage = (x: ReportFile) => x.fileType === 'jpg' || x.fileType === 'png';

/** 7. Every file (who, when); every JPEG / PNG photo or file shown (the signed sheets under sign-off). */
export function filesSection(f: ReportFacts): ReportSection {
  if (f.files.length === 0) return { title: 'Files and photos', blocks: [note('Nothing attached.')] };
  const updateDay = new Map(f.dailyUpdates.flatMap((u) => u.attachments.map((a) => [a.publicId, u.workDate] as const)));
  const withUpdate = (x: ReportFile) => (updateDay.has(x.publicId) ? `with the daily update of ${dayText(updateDay.get(x.publicId)!)}` : '');
  const shown = (x: ReportFile) => (x.kind === 'signoff' ? 'signed sheet: shown under Customer sign-off' : isImage(x) ? 'shown below' : 'listed only');
  const blocks: ReportBlock[] = [table(cols(['#', 0.05], ['Kind', 0.1], ['Type', 0.07], ['Uploaded by', 0.2], ['When', 0.17], ['Note', 0.41]),
    f.files.map((x, i) => [String(i + 1), x.kind, x.fileType.toUpperCase(), x.uploadedBy, istDateTime(x.uploadedAt), [shown(x), withUpdate(x)].filter(Boolean).join('; ')]))];
  const pictures = f.files.map((x, i) => ({ x, n: i + 1 })).filter(({ x }) => isImage(x) && x.kind !== 'signoff');
  if (pictures.length) blocks.push(sub('Photos'));
  for (const { x, n } of pictures) {
    const extra = withUpdate(x);
    blocks.push({ kind: 'image', file: x.file, size: 'large',
      caption: `#${n} ${x.kind}, uploaded by ${x.uploadedBy}, ${istDateTime(x.uploadedAt)}${extra ? ` (${extra})` : ''}` });
  }
  return { title: 'Files and photos', blocks };
}

/** 8. The customer's sign-off with the photo of the signed sheet, and the head's approval. */
export function signoffSection(f: ReportFacts): ReportSection {
  const t = f.ticket;
  const rules = t.typeRules.completionRules;
  const files = new Map(f.files.map((x) => [x.publicId, x]));
  const blocks: ReportBlock[] = [];
  if (t.signoffs.length === 0) blocks.push(note(`No customer sign-off recorded${rules.customer_signoff_required ? ' (the ticket type requires one)' : ''}.`));
  for (const s of t.signoffs) {
    blocks.push(sub(`Signed by ${s.signerName}`), { kind: 'rows', rows: [['Signer', s.signerName], ['Role', s.signerRole ?? '-'],
      ['Signed', istDateTime(s.signedAt)], ['Recorded by', s.recordedBy.displayName]] });
    const sheet = files.get(s.photoPublicId);
    blocks.push({ kind: 'image', file: sheet?.file ?? null, size: 'large',
      caption: `Signed sheet${sheet ? `, uploaded by ${sheet.uploadedBy}, ${istDateTime(sheet.uploadedAt)}` : ''}` });
  }
  blocks.push(sub('Head approval'), { kind: 'rows', rows: [['Head approval', t.headApproval ? at(t.headApproval.at, t.headApproval.by.displayName)
    : `Not given${rules.head_approval_required ? ' (the ticket type requires it)' : ''}`]] });
  return { title: 'Customer sign-off and approval', blocks };
}

/** 9. Linked tickets, both ways. */
export function linksSection(f: ReportFacts): ReportSection {
  const relation = (l: TicketDetail['links'][number]) => (l.direction === 'to' ? (l.kind === 'follows' ? 'This ticket follows' : 'This ticket is rework of')
    : (l.kind === 'follows' ? 'Followed by' : 'Reworked in'));
  const links = f.ticket.links;
  return { title: 'Linked tickets', blocks: [links.length === 0 ? note('No linked tickets.')
    : table(cols(['Relation', 0.26], ['Ticket', 0.16], ['Title', 0.42], ['Status', 0.16]),
      links.map((l) => [relation(l), l.ticket.number, l.ticket.title, words(l.ticket.status)]))] };
}

/** 10. Outside workers (with a small photo) and their daily attendance, oldest day first. */
export function externalStaffSection(f: ReportFacts): ReportSection {
  if (f.workers.length === 0) return { title: 'External staff', blocks: [note('No outside workers recorded.')] };
  const blocks: ReportBlock[] = [note('Contractor or agency workers on this site and their attendance, oldest day first.')];
  for (const w of f.workers) {
    blocks.push(sub(w.name), { kind: 'rows', rows: [['Agency / contractor', w.agency ?? '-'], ['Trade', w.trade ?? '-'], ['Phone', w.phone ?? '-'],
      ['Days on site', `${dayText(w.fromDate)} to ${w.toDate ? dayText(w.toDate) : 'still on site'}`], ['Added by', at(w.addedAt, w.addedBy)]] });
    if (w.photo) blocks.push({ kind: 'image', file: w.photo, size: 'small', caption: `Photo of ${w.name}` });
    const days = f.attendance.filter((a) => a.staff.publicId === w.publicId).sort((a, b) => a.workDate.localeCompare(b.workDate));
    blocks.push(days.length === 0 ? note('No attendance recorded.') : table(
      cols(['Day', 0.12], ['Status', 0.09], ['In', 0.07], ['Out', 0.07], ['Time', 0.1], ['Note', 0.23], ['Recorded', 0.16], ['Corrected', 0.16]),
      days.map((a) => [dayText(a.workDate), capital(words(a.status)), a.timeIn ? istTime(a.timeIn) : '-', a.timeOut ? istTime(a.timeOut) : '-',
        a.minutes !== null ? minutesText(a.minutes) : '-', a.note ?? '', at(a.recordedAt, a.recordedBy.displayName),
        a.updatedAt ? at(a.updatedAt, a.updatedBy?.displayName) : '-'])));
  }
  return { title: 'External staff', blocks };
}

/** 11. Everything that happened, oldest first, in words. */
export function historySection(f: ReportFacts, names: Names): ReportSection {
  return { title: 'History', blocks: [note('Everything that happened on the ticket, oldest first.'),
    table(cols(['When', 0.17], ['Who', 0.18], ['What', 0.65]),
      f.ticket.timeline.map((e) => [istDateTime(e.at), e.actor?.displayName ?? 'System', eventText(e, names)]))] };
}
