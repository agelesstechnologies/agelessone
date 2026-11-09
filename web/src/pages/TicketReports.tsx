import { useState } from 'react';
import type {
  HoursBy, HoursReport, MissingUpdatesReport, OnHoldReport, OverdueReport, TicketDashboard, UtilisationReport, WeeklyReport,
} from '@ageless/shared';
import { api, ApiFailure } from '../api';
import { addDays, dayLabel, hm, todayIst, useLoad } from '../hooks';
import { CsvButton, Empty, Loading, Notice, Panel, Tabs } from '../ui';

type Kind = 'dashboard' | 'hours' | 'utilisation' | 'overdue' | 'on-hold' | 'weekly' | 'missing-updates';
const KINDS: { key: Kind; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' }, { key: 'hours', label: 'Hours' }, { key: 'utilisation', label: 'Utilisation' },
  { key: 'overdue', label: 'Overdue' }, { key: 'on-hold', label: 'On hold' }, { key: 'weekly', label: 'Weekly' }, { key: 'missing-updates', label: 'Missing updates' },
];
const COMPANIES = [{ code: 'AE', name: 'Ageless Entertainments' }, { code: 'ATPL', name: 'Ageless Technologies' }];
/** Reports that need a date range; overdue and on-hold are "as of today", the dashboard is for the current month. */
const RANGED: Kind[] = ['hours', 'utilisation', 'weekly', 'missing-updates'];

export default function TicketReports() {
  const [kind, setKind] = useState<Kind>('dashboard');
  const [company, setCompany] = useState('');
  const [to, setTo] = useState(todayIst());
  const [from, setFrom] = useState(addDays(todayIst(), -29));
  const [by, setBy] = useState<HoursBy>('ticket');
  const [csvError, setCsvError] = useState('');
  // reports cover the departments a manager heads (HR, admin user and Management: everything); a manager who heads no
  // department is told so, instead of a red "forbidden"
  const access = useLoad(() => api('/tickets/reports/overdue').then(() => true)
    .catch((e) => (e instanceof ApiFailure && e.status === 403 ? false : true)), []);
  if (access.data === null) return <Panel title="Ticket reports"><div className="panel-body"><Loading /></div></Panel>;
  if (access.data === false) {
    return <Panel title="Ticket reports"><div className="panel-body">
      <Empty title="No department to report on" text="Ticket reports cover the departments you head. Ask HR to make you the head of a department to see its reports." />
    </div></Panel>;
  }

  const ranged = RANGED.includes(kind);
  const params = new URLSearchParams({ ...(company && { company }), ...(ranged && { from, to }), ...(kind === 'hours' && { by }) }).toString();
  const path = `/tickets/${kind === 'dashboard' ? 'dashboard' : `reports/${kind}`}${params ? `?${params}` : ''}`;

  return <Panel title="Ticket reports" note="Time is the shared time per work day, never overlapping timer time.">
    <div className="panel-body">
      <Tabs tabs={KINDS} value={kind} onChange={setKind} />
      <div className="filters">
        {ranged && <>
          <label className="inline-field">From<input id="tr-from" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="inline-field">To<input id="tr-to" type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label></>}
        {kind === 'hours' && <label className="inline-field">By<select id="tr-by" className="input" value={by} onChange={(e) => setBy(e.target.value as HoursBy)}>
          {['ticket', 'type', 'person', 'department', 'customer'].map((b) => <option key={b} value={b}>{b}</option>)}</select></label>}
        <label className="inline-field">Company<select id="tr-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
          <option value="">All</option>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        {kind !== 'dashboard' && <CsvButton path={path} name={`tickets-${kind}.csv`} onError={setCsvError} />}
      </div>
      {csvError && <Notice onClose={() => setCsvError('')}>{csvError}</Notice>}
      {kind === 'dashboard' && <Dashboard path={path} />}
      {kind === 'hours' && <Hours path={path} />}
      {kind === 'utilisation' && <Utilisation path={path} />}
      {kind === 'overdue' && <Overdue path={path} />}
      {kind === 'on-hold' && <OnHold path={path} />}
      {kind === 'weekly' && <Weekly path={path} />}
      {kind === 'missing-updates' && <MissingReport path={path} />}
    </div>
  </Panel>;
}

/** Loads one report and shows a loading line, an error, or an empty note around the table. */
function Report<T extends { rows: unknown[] }>({ path, children }: { path: string; children: (r: T) => React.ReactNode }) {
  const q = useLoad(() => api<T>(path), [path]);
  if (q.error) return <Notice>{q.error}</Notice>;
  if (q.loading && !q.data) return <Loading />;
  if (!q.data) return null;
  return q.data.rows.length ? <>{children(q.data)}</> : <Empty title="Nothing to show" text="No rows for these filters." />;
}

const Table = ({ head, children }: { head: string[]; children: React.ReactNode }) =>
  <div className="table-wrap"><table><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;

function Dashboard({ path }: { path: string }) {
  const q = useLoad(() => api<TicketDashboard>(path), [path]);
  const d = q.data;
  if (q.error) return <Notice>{q.error}</Notice>;
  if (!d) return <Loading />;
  return <>
    <div className="mini-stats">
      <div><small>OPEN</small><strong>{d.open}</strong></div>
      <div><small>OVERDUE</small><strong>{d.overdue}</strong></div>
      <div><small>COMPLETED {d.month}</small><strong>{d.completedThisMonth}</strong></div>
      <div><small>COMPLETED {d.lastMonth}</small><strong>{d.completedLastMonth}</strong></div>
    </div>
    <div className="table-wrap"><table><thead><tr><th>OPEN BY TYPE</th><th>TICKETS</th></tr></thead>
      <tbody>{d.openByType.length ? d.openByType.map((t) => <tr key={t.type.code}><td>{t.type.name}</td><td>{t.count}</td></tr>) : <tr><td colSpan={2}>None</td></tr>}</tbody></table></div>
    <div className="table-wrap"><table><thead><tr><th>OPEN BY PRIORITY</th><th>TICKETS</th></tr></thead>
      <tbody>{d.openByPriority.length ? d.openByPriority.map((p) => <tr key={p.priority}><td>Priority {p.priority}</td><td>{p.count}</td></tr>) : <tr><td colSpan={2}>None</td></tr>}</tbody></table></div>
  </>;
}

const Hours = ({ path }: { path: string }) => <Report<HoursReport> path={path}>{(r) => <>
  <Table head={[r.by.toUpperCase(), 'HOURS']}>{r.rows.map((x) => <tr key={`${x.key}-${x.label}`}><td>{x.label}</td><td>{x.hours.toFixed(2)}</td></tr>)}
    <tr><td><b>Total</b></td><td><b>{r.totals.hours.toFixed(2)}</b></td></tr></Table></>}</Report>;

const Utilisation = ({ path }: { path: string }) => <Report<UtilisationReport> path={path}>{(r) =>
  <Table head={['PERSON', 'ATTENDED', 'ON TICKETS', 'UNALLOCATED', 'UTILISATION']}>{r.rows.map((x) => <tr key={x.person.publicId}>
    <td>{x.person.displayName}</td><td>{hm(x.attendanceMinutes)}</td><td>{hm(x.ticketMinutes)}</td><td>{hm(Math.max(x.unallocatedMinutes, 0))}</td>
    <td>{x.utilisationPercent === null ? '—' : `${x.utilisationPercent}%`}</td></tr>)}</Table>}</Report>;

const Overdue = ({ path }: { path: string }) => <Report<OverdueReport> path={path}>{(r) =>
  <Table head={['TICKET', 'TYPE', 'DEPARTMENT', 'ASSIGNEE', 'DUE', 'DAYS OVERDUE']}>{r.rows.map((x) => <tr key={x.ticket.publicId}>
    <td><b>{x.ticket.number}</b><small className="sub">{x.ticket.title}</small></td><td>{x.type.name}</td><td>{x.department.name}</td>
    <td>{x.primaryAssignee?.displayName ?? '—'}</td><td>{x.dueDate ? dayLabel(x.dueDate) : '—'}</td><td>{x.daysOverdue}</td></tr>)}</Table>}</Report>;

const OnHold = ({ path }: { path: string }) => <Report<OnHoldReport> path={path}>{(r) =>
  <Table head={['TICKET', 'TYPE', 'DEPARTMENT', 'REASON', 'SINCE']}>{r.rows.map((x) => <tr key={x.ticket.publicId}>
    <td><b>{x.ticket.number}</b><small className="sub">{x.ticket.title}</small></td><td>{x.type.name}</td><td>{x.department.name}</td>
    <td>{x.holdReason}</td><td>{x.heldSince ? dayLabel(x.heldSince.slice(0, 10)) : '—'}</td></tr>)}</Table>}</Report>;

const Weekly = ({ path }: { path: string }) => <Report<WeeklyReport> path={path}>{(r) =>
  <Table head={['WEEK STARTING', 'TYPE', 'CREATED', 'COMPLETED']}>{r.rows.map((x) => <tr key={`${x.weekStart}-${x.type.code}`}>
    <td>{dayLabel(x.weekStart)}</td><td>{x.type.name}</td><td>{x.created}</td><td>{x.completed}</td></tr>)}
    <tr><td colSpan={2}><b>Total</b></td><td><b>{r.totals.created}</b></td><td><b>{r.totals.completed}</b></td></tr></Table>}</Report>;

const MissingReport = ({ path }: { path: string }) => <Report<MissingUpdatesReport> path={path}>{(r) =>
  <Table head={['PERSON', 'DAYS WITHOUT UPDATE', 'TICKETS', 'TIME']}>{r.rows.map((x) => <tr key={x.person.publicId}>
    <td>{x.person.displayName}</td><td>{x.missingUpdates}</td><td>{x.tickets}</td><td>{hm(x.minutes)}</td></tr>)}</Table>}</Report>;
