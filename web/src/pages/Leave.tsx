import { useEffect, useState, type FormEvent } from 'react';
import { Check, Plus, X } from 'lucide-react';
import {
  ApplyLeaveRequest, LeaveAdjustmentRequest, type LeaveBalance, type LeaveReport, type LeaveRequestView, type LeaveType,
} from '@ageless/shared';
import { api, errText, formError } from '../api';
import { useAuth } from '../auth';
import { VoiceInput } from '../VoiceInput';
import { addDays, dayLabel, todayIst, useLoad, useMyEmployments, uuidv7, words } from '../hooks';
import { LEAVE } from '../permissions';
import { Badge, Empty, Loading, Modal, Notice, PageHead, Panel, Tabs, CsvButton, type Tone } from '../ui';

type TabKey = 'mine' | 'approve' | 'report';
const LEAVE_TONE: Record<string, Tone> = { draft: 'gray', submitted: 'amber', approved: 'green', rejected: 'red', cancelled: 'gray' };

export default function Leave() {
  const { can } = useAuth();
  const tabs: { key: TabKey; label: string }[] = [
    ...(can(LEAVE.apply) ? [{ key: 'mine' as const, label: 'My leave' }] : []),
    ...(can(LEAVE.approve) ? [{ key: 'approve' as const, label: 'To approve' }] : []),
    ...(can(LEAVE.report) ? [{ key: 'report' as const, label: 'Report' }] : []),
  ];
  const [tab, setTab] = useState<TabKey>(tabs[0]?.key ?? 'mine');
  return <>
    <PageHead eyebrow="HRMS • LEAVE" title="Leave" subtitle={can(LEAVE.apply)
      ? (can(LEAVE.approve) ? 'Apply for leave, check balances, and approve your team\'s requests.' : 'Apply for leave and check your balances.')
      : 'Approve leave requests and see who is on leave.'} />
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'mine' && <MyLeave />}
    {tab === 'approve' && <Approvals />}
    {tab === 'report' && <Report />}
  </>;
}

const period = (r: LeaveRequestView) => {
  const half = (r.fromHalf === 'second_half' ? ' (from midday)' : '');
  const end = r.toHalf === 'first_half' ? ' (till midday)' : '';
  return r.fromDate === r.toDate ? `${dayLabel(r.fromDate)}${half}${end}` : `${dayLabel(r.fromDate)}${half} – ${dayLabel(r.toDate)}${end}`;
};
const StatusBadge = ({ status }: { status: string }) => <Badge tone={LEAVE_TONE[status] ?? 'gray'}>{status}</Badge>;
const note = (r: LeaveRequestView) => r.status === 'rejected' && r.decisionReason ? `Reason: ${r.decisionReason}` : r.reason ?? '';

function MyLeave() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [applying, setApplying] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [cancelling, setCancelling] = useState<LeaveRequestView | null>(null);
  const [ok, setOk] = useState('');
  const balances = useLoad(() => api<LeaveBalance[]>('/hrms/leave/balances/mine'));
  const q = useLoad(() => api<LeaveRequestView[]>(`/hrms/leave/requests/mine${status ? `?status=${status}` : ''}`), [status]);
  const refresh = () => { balances.reload(); q.reload(); };
  return <>
    <Panel title="Balances" note="1 sick + 1 earned day a month; unused sick leave lapses at year end, earned leave carries forward." action={can(LEAVE.manage) && <button className="outline-btn" onClick={() => setAdjusting(true)}>Adjust balance</button>}>
      <div className="panel-body">
        {balances.error && <Notice>{balances.error}</Notice>}
        {balances.loading && !balances.data ? <Loading /> : !balances.data?.length ? <Empty title="No balances yet" text="1 sick and 1 earned day are added on the 1st of every month." /> :
          <div className="mini-stats">{balances.data.map((b) => <div key={`${b.employment.publicId}-${b.leaveType.code}`}>
            <small>{b.leaveType.name.toUpperCase()} · {b.employment.company}</small><strong>{b.balance}</strong></div>)}</div>}
      </div>
    </Panel>
    <Panel title="My requests" action={<button className="primary-btn" onClick={() => setApplying(true)}><Plus size={16} /> Apply for leave</button>}>
      <div className="panel-body">
        <div className="filters">
          <label className="inline-field">Status
            <select id="leave-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option><option value="submitted">Submitted</option><option value="approved">Approved</option>
              <option value="rejected">Rejected</option><option value="cancelled">Cancelled</option></select></label>
        </div>
        {ok && <Notice tone="ok" onClose={() => setOk('')}>{ok}</Notice>}
        {q.error && <Notice>{q.error}</Notice>}
        {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No leave requests" text="Use Apply for leave to add one." /> :
          <div className="table-wrap"><table><thead><tr><th>DATES</th><th>TYPE</th><th>DAYS</th><th>COMPANY</th><th>STATUS</th><th>NOTE</th><th /></tr></thead>
            <tbody>{q.data.map((r) => <tr key={r.publicId}>
              <td>{period(r)}</td><td>{r.leaveType.name}</td><td>{r.days}{r.unpaidDays > 0 && <small className="sub lop">{r.unpaidDays} loss of pay</small>}</td><td>{r.employment.company}</td><td><StatusBadge status={r.status} /></td>
              <td className="note-cell">{note(r)}{r.approver && r.status === 'submitted' && <small className="sub">With {r.approver.displayName}</small>}</td>
              <td className="row-actions">{(r.status === 'submitted' || r.status === 'approved') &&
                <button className="outline-btn danger" onClick={() => setCancelling(r)}>Cancel</button>}</td></tr>)}</tbody></table></div>}
      </div>
    </Panel>
    {applying && <Apply onClose={() => setApplying(false)} onSaved={() => { setApplying(false); setOk('Leave request sent.'); refresh(); }} />}
    {adjusting && <Adjust onClose={() => setAdjusting(false)} onSaved={() => { setAdjusting(false); setOk('Balance updated.'); refresh(); }} />}
    {cancelling && <Cancel request={cancelling} onClose={() => setCancelling(null)} onSaved={() => { setCancelling(null); setOk('Leave cancelled.'); refresh(); }} />}
  </>;
}

function Apply({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { jobs, primary, error: jobsError } = useMyEmployments();
  const types = useLoad(() => api<LeaveType[]>('/hrms/leave/types'));
  const balances = useLoad(() => api<LeaveBalance[]>('/hrms/leave/balances/mine'));
  const [requestId] = useState(uuidv7); // one id per form, so pressing Send twice stores one request
  const [jobId, setJobId] = useState('');
  const [type, setType] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!jobId && primary) setJobId(primary.publicId); }, [primary, jobId]);
  useEffect(() => { if (!type && types.data?.[0]) setType(types.data[0].code); }, [types.data, type]);

  // what the chosen type has left; days beyond it are loss of pay
  function balanceNote(): string {
    const t = types.data?.find((x) => x.code === type);
    if (!t) return '';
    if (!t.isPaid) return 'Leave without pay: these days are deducted from salary.';
    const left = balances.data?.find((b) => b.employment.publicId === jobId && b.leaveType.code === type)?.balance ?? 0;
    return `You have ${left} day${left === 1 ? '' : 's'} of ${t.name.toLowerCase()} left. Days beyond that are loss of pay.`;
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const reason = String(d.get('reason') ?? '').trim();
    const parsed = ApplyLeaveRequest.safeParse({
      publicId: requestId, employmentPublicId: jobId, leaveTypeCode: type, fromDate: d.get('fromDate'), toDate: d.get('toDate'),
      fromHalf: d.get('fromHalf'), toHalf: d.get('toHalf'), ...(reason ? { reason } : {}),
    });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { await api('/hrms/leave/requests', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }

  return <Modal title="Apply for leave" subtitle="Your manager decides; HR decides if you have none." onClose={onClose}>
    <form onSubmit={submit}>
      {(error || jobsError || types.error) && <Notice>{error || jobsError || types.error}</Notice>}
      <div className="form-grid">
        {jobs.length > 1 && <label className="span-two">Company
          <select id="leave-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            {jobs.map((j) => <option key={j.publicId} value={j.publicId}>{j.company.name} · {j.employeeCode}</option>)}</select></label>}
        <label className="span-two">Leave type
          <select id="leave-type" value={type} onChange={(e) => setType(e.target.value)}>
            {types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}{t.isPaid ? '' : ' (unpaid)'}</option>)}</select></label>
        <p className="span-two muted-text">{balanceNote()}</p>
        <label>From<input id="leave-from" name="fromDate" type="date" required defaultValue={todayIst()} /></label>
        <label>Starts<select id="leave-from-half" name="fromHalf" defaultValue="full"><option value="full">Full day</option><option value="second_half">Second half only</option></select></label>
        <label>To<input id="leave-to" name="toDate" type="date" required defaultValue={todayIst()} /></label>
        <label>Ends<select id="leave-to-half" name="toHalf" defaultValue="full"><option value="full">Full day</option><option value="first_half">First half only</option></select></label>
        <label className="span-two">Reason<VoiceInput id="leave-reason" name="reason" maxLength={500} placeholder="At least 3 characters" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" disabled={saving || !jobId || !type}>{saving ? 'Sending…' : 'Send request'}</button></div>
    </form>
  </Modal>;
}

function Cancel({ request, onClose, onSaved }: { request: LeaveRequestView; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api(`/hrms/leave/requests/${request.publicId}/cancel`, { method: 'POST', json: text.trim() ? { reason: text.trim() } : {} }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  return <Modal title="Cancel this leave?" subtitle={`${request.leaveType.name} · ${period(request)}`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid"><label className="span-two">Reason <span className="optional">optional</span>
        <input id="cancel-reason" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} autoFocus /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Keep it</button>
        <button className="primary-btn" disabled={busy}>Cancel leave</button></div>
    </form>
  </Modal>;
}

function Approvals() {
  const q = useLoad(() => api<LeaveRequestView[]>('/hrms/leave/requests/to-approve'));
  const [rows, setRows] = useState<LeaveRequestView[]>([]);
  const [rejecting, setRejecting] = useState<LeaveRequestView | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  useEffect(() => { if (q.data) setRows(q.data); }, [q.data]);
  const drop = (id: string) => setRows((all) => all.filter((r) => r.publicId !== id));

  async function approve(r: LeaveRequestView) {
    setBusyId(r.publicId); setError('');
    try { await api(`/hrms/leave/requests/${r.publicId}/approve`, { method: 'POST', json: {} }); drop(r.publicId); }
    catch (e) { setError(errText(e)); }
    finally { setBusyId(''); }
  }

  return <Panel title="Leave to approve" note="Submitted requests from the people who report to you.">
    <div className="panel-body">
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {q.loading ? <Loading /> : !rows.length ? <Empty title="Nothing waiting" text="New leave requests from your team appear here." /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>DATES</th><th>TYPE</th><th>DAYS</th><th>NOTE</th><th /></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.publicId}>
            <td><b>{r.person.displayName}</b><small className="sub">{r.employment.company}</small></td><td>{period(r)}</td><td>{r.leaveType.name}</td><td>{r.days}{r.unpaidDays > 0 && <small className="sub lop">{r.unpaidDays} loss of pay</small>}</td>
            <td className="note-cell">{r.reason ?? ''}</td>
            <td className="row-actions">
              <button className="outline-btn ok" disabled={busyId === r.publicId} onClick={() => void approve(r)}><Check size={13} /> Approve</button>
              <button className="outline-btn danger" onClick={() => setRejecting(r)}><X size={13} /> Reject</button></td></tr>)}</tbody></table></div>}
    </div>
    {rejecting && <Reject request={rejecting} onClose={() => setRejecting(null)} onDone={() => { drop(rejecting.publicId); setRejecting(null); }} />}
  </Panel>;
}

function Reject({ request, onClose, onDone }: { request: LeaveRequestView; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim().length < 3) { setError('Give a reason of at least 3 characters'); return; }
    setBusy(true); setError('');
    try { await api(`/hrms/leave/requests/${request.publicId}/reject`, { method: 'POST', json: { reason: text.trim() } }); onDone(); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  return <Modal title="Reject leave" subtitle={`${request.person.displayName} · ${period(request)}`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid"><label className="span-two">Reason
        <input id="reject-reason" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} autoFocus placeholder="Tell the person why" /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" disabled={busy}>Reject leave</button></div>
    </form>
  </Modal>;
}

function Report() {
  const [to, setTo] = useState(addDays(todayIst(), 30));
  const [from, setFrom] = useState(addDays(todayIst(), -30));
  const [company, setCompany] = useState('');
  const [csvError, setCsvError] = useState('');
  const q = useLoad(() => api<LeaveReport>(`/hrms/leave/report?from=${from}&to=${to}${company ? `&company=${company}` : ''}`), [from, to, company]);
  const r = q.data;
  return <Panel title="Leave report" note="Submitted and approved leave that touches these dates.">
    <div className="panel-body">
      <div className="filters">
        <label className="inline-field">From<input id="lrep-from" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline-field">To<input id="lrep-to" type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="inline-field">Company
          <select id="lrep-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All companies</option><option value="AE">Ageless Entertainments</option><option value="ATPL">Ageless Technologies</option></select></label>
        <CsvButton path={`/hrms/leave/report?from=${from}&to=${to}${company ? `&company=${company}` : ''}`} name="leave-report.csv" onError={setCsvError} />
      </div>
      {(q.error || csvError) && <Notice onClose={() => setCsvError('')}>{q.error || csvError}</Notice>}
      {q.loading && !r ? <Loading /> : r && <>
        {!!r.approvedDaysByType.length && <div className="mini-stats">{r.approvedDaysByType.map((t) => <div key={t.code}><small>{t.code.toUpperCase()} APPROVED</small><strong>{t.days}</strong></div>)}</div>}
        {!r.rows.length ? <Empty title="No leave in this range" /> :
          <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>DATES</th><th>TYPE</th><th>DAYS</th><th>STATUS</th></tr></thead>
            <tbody>{r.rows.map((x) => <tr key={x.publicId}>
              <td><b>{x.person.displayName}</b><small className="sub">{x.employment.company} · {x.employment.employeeCode}</small></td>
              <td>{period(x)}</td><td>{x.leaveType.name}</td><td>{x.days}{x.unpaidDays > 0 && <small className="sub lop">{x.unpaidDays} loss of pay</small>}</td><td><StatusBadge status={words(x.status)} /></td></tr>)}</tbody></table></div>}
      </>}
    </div>
  </Panel>;
}

/** HR only: an opening balance or a plus/minus adjustment for one person's job. */
function Adjust({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const types = useLoad(() => api<LeaveType[]>('/hrms/leave/types'));
  const people = useLoad(() => api<{ items: { publicId: string; displayName: string }[] }>('/hrms/people?pageSize=100'));
  const [personId, setPersonId] = useState('');
  const jobs = useLoad(() => (personId ? api<{ employments: { publicId: string; company: { code: string }; employeeCode: string; status: string }[] }>(`/hrms/people/${personId}`) : Promise.resolve(null)), [personId]);
  const [entryId] = useState(uuidv7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = (jobs.data?.employments ?? []).filter((j) => j.status !== 'exited');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const parsed = LeaveAdjustmentRequest.safeParse({
      publicId: entryId, employmentPublicId: d.get('job'), leaveTypeCode: d.get('type'), year: Number(d.get('year')),
      entry: d.get('entry'), days: Number(d.get('days')), reason: String(d.get('reason') ?? '').trim(),
    });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setBusy(true); setError('');
    try { await api('/hrms/leave/ledger/adjustments', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }

  return <Modal title="Adjust leave balance" subtitle="An opening balance is once per job, type and year." onClose={onClose}>
    <form onSubmit={submit}>
      {(error || types.error || people.error) && <Notice>{error || types.error || people.error}</Notice>}
      <div className="form-grid">
        <label className="span-two">Person
          <select id="adj-person" value={personId} onChange={(e) => setPersonId(e.target.value)} required>
            <option value="" disabled>{people.loading ? 'Loading people…' : 'Choose a person'}</option>
            {people.data?.items.map((p) => <option key={p.publicId} value={p.publicId}>{p.displayName}</option>)}</select></label>
        <label>Job<select id="adj-job" name="job" required>{active.map((j) => <option key={j.publicId} value={j.publicId}>{j.company.code} · {j.employeeCode}</option>)}</select></label>
        <label>Leave type<select id="adj-type" name="type" required>{types.data?.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</select></label>
        <label>Entry<select id="adj-entry" name="entry" defaultValue="adjustment"><option value="adjustment">Adjustment (+ or −)</option><option value="opening">Opening balance</option></select></label>
        <label>Year<input id="adj-year" name="year" type="number" min={2000} max={2100} defaultValue={new Date().getFullYear()} required /></label>
        <label>Days<input id="adj-days" name="days" type="number" step="0.5" required placeholder="e.g. 12 or -1.5" /></label>
        <label>Reason<input id="adj-reason" name="reason" required maxLength={500} placeholder="At least 3 characters" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" disabled={busy || !personId}>Save</button></div>
    </form>
  </Modal>;
}
