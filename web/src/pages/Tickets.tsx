import { useEffect, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import {
  ApproveReassignRequest, CreateTicketRequest, NumberSeriesRequest, ReasonRequest,
  type Department, type NumberSeries, type ReassignmentRequest, type TicketDetail as Detail, type TicketSummary, type TicketType,
} from '@ageless/shared';
import { api, errText, formError } from '../api';
import { useAuth } from '../auth';
import { dayLabel, uuidv7, useLoad, useMyEmployments } from '../hooks';
import JobPicker, { PersonPicker } from '../JobPicker';
import { TICKET_TYPES, TICKETS } from '../permissions';
import { Badge, Empty, Loading, Modal, Notice, PageHead, Panel, Tabs } from '../ui';
import TicketPage, { STATUS_TONE, statusLabel } from './TicketDetail';
import TicketReports from './TicketReports';
import TicketTime from './TicketTime';
import TicketTypes from './TicketTypes';

type TabKey = 'mine' | 'all' | 'time' | 'reassign' | 'reports' | 'types' | 'numbers';
const COMPANIES = [{ code: 'AE', name: 'Ageless Entertainments' }, { code: 'ATPL', name: 'Ageless Technologies' }];
const STATUSES = ['open', 'assigned', 'in_progress', 'on_hold', 'completed', 'cancelled'];

/** The ticket in the address (#tickets/<id>), if one is open. */
const ticketInHash = () => /^#tickets\/([0-9a-f-]{36})/i.exec(window.location.hash)?.[1] ?? null;
/** Open a ticket as its own page; the browser's back (or the page's back arrow) returns to where the person came from. */
export const openTicket = (publicId: string) => { window.location.hash = `tickets/${publicId}`; };
/** The tab to show again when coming back from a ticket. */
let lastTab: TabKey | null = null;

export default function Tickets() {
  const { can, scopeOf } = useAuth();
  // a supervisor (tickets.create) or a department head (tickets.manage, team) creates tickets; the CEO and admin user do not
  const createsTickets = can(TICKETS.create) || scopeOf(TICKETS.manage) === 'team';
  const sees = can(TICKETS.view) || can(TICKETS.work) || can(TICKETS.manage);
  // employees (their own tickets only) see neither reports nor ticket types: reports are for heads, HR, admin user and
  // Management (as the backend allows); types for those who manage them, and HR who sees every ticket
  const seesAll = scopeOf(TICKETS.view) === 'all';
  const reports = can(TICKETS.manage) || seesAll;
  const types = can(TICKET_TYPES.manage) || seesAll;
  const tabs: { key: TabKey; label: string }[] = [
    ...(sees ? [{ key: 'mine' as const, label: 'My tickets' }, { key: 'all' as const, label: 'All tickets' }, { key: 'time' as const, label: 'Time' }, { key: 'reassign' as const, label: 'Reassignments' }] : []),
    ...(reports ? [{ key: 'reports' as const, label: 'Reports' }] : []),
    ...(types ? [{ key: 'types' as const, label: 'Ticket types' }] : []),
    ...(can(TICKETS.numbering) ? [{ key: 'numbers' as const, label: 'Numbering' }] : []),
  ];
  const [tab, setTabState] = useState<TabKey>(lastTab && tabs.some((x) => x.key === lastTab) ? lastTab : tabs[0]?.key ?? 'types');
  const setTab = (k: TabKey) => { lastTab = k; setTabState(k); };
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);
  const [openId, setOpenId] = useState(ticketInHash);
  useEffect(() => {
    const onHash = () => setOpenId(ticketInHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (openId) {
    return <TicketPage id={openId} onBack={() => { if (window.history.length > 1) window.history.back(); else window.location.hash = 'tickets'; }} />;
  }
  return <>
    <PageHead eyebrow="OPERATIONS • TICKETS" title="Tickets" subtitle="Service work: who does what, for how long, and what is left."
      action={createsTickets ? <button className="primary-btn" onClick={() => setCreating(true)}><Plus size={16} /> New ticket</button> : undefined} />
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'mine' && <TicketList key={`m${version}`} mine />}
    {tab === 'all' && <TicketList key={`a${version}`} />}
    {tab === 'time' && <TicketTime />}
    {tab === 'reassign' && <Reassignments />}
    {tab === 'reports' && <TicketReports />}
    {tab === 'types' && <TicketTypes />}
    {tab === 'numbers' && <Numbering />}
    {creating && <NewTicket onClose={() => setCreating(false)} onSaved={() => { setCreating(false); setVersion((v) => v + 1); }} />}
  </>;
}

function TicketList({ mine }: { mine?: boolean }) {
  const [status, setStatus] = useState('');
  const [company, setCompany] = useState('');
  const [overdue, setOverdue] = useState(false);
  const path = mine ? `/tickets/mine${status ? `?status=${status}` : ''}`
    : `/tickets?${new URLSearchParams({ limit: '200', ...(status && { status }), ...(company && { company }), ...(overdue && { overdue: 'true' }) })}`;
  const q = useLoad(() => api<TicketSummary[]>(path), [path]);
  return <Panel title={mine ? 'My tickets' : 'All tickets'} note={mine ? 'Tickets you are assigned to, supervise or created.' : 'Tickets you may see, newest first.'}>
    <div className="panel-body">
      <div className="filters">
        <label className="inline-field">Status<select id="tk-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>
        {!mine && <label className="inline-field">Company<select id="tk-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
          <option value="">All</option>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>}
        {!mine && <label className="inline-field check-row"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> Overdue only</label>}
      </div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No tickets" /> :
        <div className="table-wrap"><table><thead><tr><th>NUMBER</th><th>TITLE</th><th>TYPE</th><th>STATUS</th><th>PRIORITY</th><th>ASSIGNEE</th><th>DUE</th></tr></thead>
          <tbody>{q.data.map((t) => <tr key={t.publicId} className="link-row" onClick={() => openTicket(t.publicId)}>
            <td><b>{t.number}</b></td><td>{t.title}{t.site && <small className="sub">{t.site}</small>}</td><td>{t.type.name}</td>
            <td><Badge tone={STATUS_TONE[t.status] ?? 'gray'}>{statusLabel(t.status)}</Badge></td>
            <td>{t.priority}</td><td>{t.primaryAssignee?.person.displayName ?? '—'}</td>
            <td>{t.dueDate ? dayLabel(t.dueDate) : '—'}{t.overdue && <> <Badge tone="red">overdue</Badge></>}</td></tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}

/** Fields of the type are asked as the type defines them. File fields are filled after uploading, on the ticket. */
function NewTicket({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  // tickets are created in a company you work in (a supervisor's rule); start with your main job's company
  const mine = useMyEmployments();
  const myCodes = new Set(mine.jobs.map((j) => j.company.code));
  const companies = myCodes.size ? COMPANIES.filter((c) => myCodes.has(c.code)) : COMPANIES;
  const [picked, setCompany] = useState('');
  const company = picked || mine.primary?.company.code || companies[0]!.code;
  const [typeId, setTypeId] = useState('');
  const [job, setJob] = useState('');
  const [supervisor, setSupervisor] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const types = useLoad(() => api<TicketType[]>(`/tickets/types?active=true&company=${company}`), [company]);
  const depts = useLoad(() => api<Department[]>(`/hrms/departments?company=${company}`), [company]);
  const type = types.data?.find((t) => t.publicId === typeId);
  const noDepts = !depts.loading && !depts.error && (depts.data?.length ?? 0) === 0;
  const companyName = COMPANIES.find((c) => c.code === company)?.name ?? company;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const details: Record<string, unknown> = {};
    for (const fld of type?.fields ?? []) {
      const v = text(`d_${fld.key}`);
      if (fld.type === 'file' || !v) continue;
      details[fld.key] = fld.type === 'number' ? Number(v) : fld.type === 'money' ? Math.round(Number(v) * 100) : v;
    }
    const scheduled = text('scheduled');
    const parsed = CreateTicketRequest.safeParse({
      publicId: id, company, typePublicId: typeId, title: text('title'), priority: Number(f.get('priority')),
      departmentPublicId: text('department'), scheduledAt: scheduled ? new Date(scheduled).toISOString() : undefined,
      ...(text('description') ? { description: text('description') } : {}), ...(text('site') ? { site: text('site') } : {}),
      ...(text('due') ? { dueDate: text('due') } : {}), ...(supervisor ? { supervisorPublicId: supervisor } : {}), details,
      ...(job ? { assignees: [{ employmentPublicId: job, isPrimary: true }] } : {}),
    });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { await api<Detail>('/tickets', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="New ticket" subtitle="The ticket number is made for you." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      {noDepts && <Notice tone="error">{companyName} has no departments yet, so a ticket can't be created there. HR adds departments under Organisation.</Notice>}
      <div className="form-grid">
        <label>Company<select id="nt-company" value={company} onChange={(e) => { setCompany(e.target.value); setTypeId(''); setJob(''); }}>{companies.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <label>Type<select id="nt-type" value={typeId} onChange={(e) => setTypeId(e.target.value)} required>
          <option value="" disabled>{types.loading ? 'Loading…' : 'Choose a type'}</option>{types.data?.map((t) => <option key={t.publicId} value={t.publicId}>{t.name}</option>)}</select></label>
        <label className="span-two">Title<input id="nt-title" name="title" required minLength={3} maxLength={150} /></label>
        <label className="span-two">Description <span className="optional">optional</span><input id="nt-desc" name="description" maxLength={1000} /></label>
        <label>Department<select id="nt-dept" name="department" required key={`d${company}${depts.data?.length ?? 0}`} defaultValue="">
          <option value="" disabled>{depts.loading ? 'Loading…' : noDepts ? 'No departments yet' : 'Choose'}</option>{depts.data?.map((d) => <option key={d.publicId} value={d.publicId}>{d.name}</option>)}</select></label>
        <label>Priority<select id="nt-priority" name="priority" defaultValue="3">{[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{p}{p === 1 ? ' (highest)' : p === 5 ? ' (lowest)' : ''}</option>)}</select></label>
        <label>Scheduled for<input id="nt-sched" name="scheduled" type="datetime-local" required /></label>
        <label>Due date <span className="optional">optional</span><input id="nt-due" name="due" type="date" /></label>
        <label className="span-two">Site <span className="optional">optional</span><input id="nt-site" name="site" maxLength={200} /></label>
        {type?.fields.map((fld) => fld.type === 'file'
          ? <p key={fld.key} className="span-two muted-text">{fld.label}: upload it on the ticket after creating it.</p>
          : <label key={fld.key} className="span-two">{fld.label}{fld.required ? '' : ' '}{!fld.required && <span className="optional">optional</span>}
            <input id={`nt-d-${fld.key}`} name={`d_${fld.key}`} required={fld.required} type={fld.type === 'number' || fld.type === 'money' ? 'number' : fld.type === 'date' ? 'date' : 'text'}
              step={fld.type === 'money' ? '0.01' : undefined} placeholder={fld.type === 'money' ? 'Amount in ₹' : fld.type === 'person' ? "Person's ID" : undefined} /></label>)}
        <PersonPicker idPrefix="nt-sup" label="Supervisor" hint="optional — the department head, or you, if left empty" onChange={setSupervisor} />
        <JobPicker key={company} idPrefix="nt-asg" label="Assign to" hint="optional" company={company} onChange={setJob} />
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving || noDepts}>{saving ? 'Creating…' : 'Create ticket'}</button></div>
    </form>
  </Modal>;
}

function Reassignments() {
  const [status, setStatus] = useState('pending');
  const [error, setError] = useState('');
  const [deciding, setDeciding] = useState<{ r: ReassignmentRequest; kind: 'approve' | 'reject' } | null>(null);
  const q = useLoad(() => api<ReassignmentRequest[]>(`/tickets/reassign-requests${status ? `?status=${status}` : ''}`), [status]);
  return <Panel title="Reassignment requests" note="Assignees who asked to hand a ticket over. You see the ones you decide.">
    <div className="panel-body">
      <div className="filters"><label className="inline-field">Status<select id="ra-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">All</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label></div>
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No requests" /> :
        <div className="table-wrap"><table><thead><tr><th>TICKET</th><th>REQUESTED BY</th><th>REASON</th><th>STATUS</th><th /></tr></thead>
          <tbody>{q.data.map((r) => <tr key={r.publicId}>
            <td><b>{r.ticketNumber}</b></td><td>{r.requestedBy.displayName}</td><td>{r.reason}</td>
            <td><Badge tone={r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'amber'}>{r.status}</Badge>{r.newAssignee && <small className="sub">to {r.newAssignee.displayName}</small>}</td>
            <td>{r.status === 'pending' && <span className="chip-row">
              <button className="text-btn" onClick={() => setDeciding({ r, kind: 'approve' })}>Approve</button>
              <button className="text-btn" onClick={() => setDeciding({ r, kind: 'reject' })}>Reject</button></span>}</td></tr>)}</tbody></table></div>}
    </div>
    {deciding && <Decide r={deciding.r} kind={deciding.kind} onClose={() => setDeciding(null)} onDone={() => { setDeciding(null); q.reload(); }} onError={setError} />}
  </Panel>;
}

function Decide({ r, kind, onClose, onDone, onError }: { r: ReassignmentRequest; kind: 'approve' | 'reject'; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [job, setJob] = useState('');
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = kind === 'approve' ? ApproveReassignRequest.safeParse({ newEmploymentPublicId: job }) : ReasonRequest.safeParse({ reason: String(new FormData(e.currentTarget).get('reason')) });
    if (!body.success) { setError(kind === 'approve' ? 'Choose who takes over' : formError(body.error, 'Give a reason')); return; }
    try { await api(`/tickets/reassign-requests/${r.publicId}/${kind}`, { method: 'POST', json: body.data }); onDone(); }
    catch (err) { onError(errText(err)); onClose(); }
  }
  return <Modal title={kind === 'approve' ? 'Approve reassignment' : 'Reject reassignment'} subtitle={`${r.ticketNumber} · ${r.requestedBy.displayName}: ${r.reason}`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">{kind === 'approve' ? <JobPicker idPrefix="dec" onChange={setJob} />
        : <label className="span-two">Reason<input id="dec-reason" name="reason" required minLength={3} maxLength={500} /></label>}</div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn">{kind === 'approve' ? 'Approve' : 'Reject'}</button></div>
    </form>
  </Modal>;
}

function Numbering() {
  const q = useLoad(() => api<NumberSeries[]>('/tickets/number-series'));
  const [editing, setEditing] = useState<NumberSeries | null>(null);
  return <Panel title="Ticket numbering" note="Each company's prefix and next number. Imported Froid tickets keep their numbers.">
    <div className="panel-body">
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No number series" /> :
        <div className="table-wrap"><table><thead><tr><th>COMPANY</th><th>PREFIX</th><th>NEXT NUMBER</th><th>EXAMPLE</th><th /></tr></thead>
          <tbody>{q.data.map((s) => <tr key={s.company}><td>{s.company}</td><td>{s.prefix}</td><td>{s.nextNumber}</td><td>{s.example}</td>
            <td><button className="text-btn" onClick={() => setEditing(s)}>Edit</button></td></tr>)}</tbody></table></div>}
    </div>
    {editing && <EditSeries s={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(); }} />}
  </Panel>;
}

function EditSeries({ s, onClose, onSaved }: { s: NumberSeries; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = NumberSeriesRequest.safeParse({ prefix: String(f.get('prefix')).trim().toUpperCase(), nextNumber: Number(f.get('next')) });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    try { await api(`/tickets/number-series/${s.company}`, { method: 'PUT', json: parsed.data }); onSaved(); } catch (err) { setError(errText(err)); }
  }
  return <Modal title={`Numbering · ${s.company}`} onClose={onClose}><form onSubmit={submit}>
    {error && <Notice>{error}</Notice>}
    <div className="form-grid">
      <label>Prefix<input id="ns-prefix" name="prefix" required maxLength={10} defaultValue={s.prefix} /></label>
      <label>Next number<input id="ns-next" name="next" type="number" min={1} required defaultValue={s.nextNumber} /></label>
    </div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn">Save</button></div></form></Modal>;
}
