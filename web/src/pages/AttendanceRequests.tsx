import { useEffect, useState, type FormEvent } from 'react';
import { Check, X } from 'lucide-react';
import {
  CreateCorrectionRequest, CreateOvertimeRequest, type Correction, type CorrectionKind, type HistoryRow, type OvertimeRequestView,
} from '@ageless/shared';
import { api, errText, formError } from '../api';
import { dayLabel, hm, timeIst, useLoad, uuidv7 } from '../hooks';
import { Badge, Empty, Loading, Modal, Notice, Panel, type Tone } from '../ui';

const STATUS_TONE: Record<string, Tone> = { submitted: 'amber', approved: 'green', rejected: 'red', cancelled: 'gray' };
const KIND_LABEL: Record<CorrectionKind, string> = { missed_out: 'Missed punch-out', missed_in: 'Missed punch-in', wrong_time: 'Wrong time', other: 'Other' };

/** A time typed in a datetime-local box is IST wall time; the API wants an ISO time with offset. */
const istToIso = (local: string): string | undefined => (local ? `${local}:00+05:30` : undefined);

type Kind = 'correction' | 'overtime';

/** What a correction or an overtime request shows in a list. */
interface Row {
  publicId: string; kind: Kind; person: string; company: string; date: string; title: string; reason: string;
  status: string; decisionReason: string | null; approver: string | null;
}
const fromCorrection = (c: Correction): Row => ({
  publicId: c.publicId, kind: 'correction', person: c.person.displayName, company: c.employment.company, date: c.workDate,
  title: `Correction · ${KIND_LABEL[c.kind]}${c.requestedIn ? ` · in ${timeIst(c.requestedIn)}` : ''}${c.requestedOut ? ` · out ${timeIst(c.requestedOut)}` : ''}`,
  reason: c.reason, status: c.status, decisionReason: c.decisionReason, approver: c.approver?.displayName ?? null,
});
const fromOvertime = (o: OvertimeRequestView): Row => ({
  publicId: o.publicId, kind: 'overtime', person: o.person.displayName, company: o.employment.company, date: o.workDate,
  title: `Overtime · ${hm(o.minutes)}${o.ticket ? ` · ticket ${o.ticket.number}` : ''}`,
  reason: o.reason, status: o.status, decisionReason: o.decisionReason, approver: o.approver?.displayName ?? null,
});
const path = (r: Row, action: string) => `/hrms/attendance/${r.kind === 'correction' ? 'corrections' : 'overtime'}/${r.publicId}/${action}`;
const sortNewest = (rows: Row[]) => [...rows].sort((a, b) => b.date.localeCompare(a.date));

function useRows(listPath: 'mine' | 'to-approve') {
  const c = useLoad(() => api<Correction[]>(`/hrms/attendance/corrections/${listPath}`));
  const o = useLoad(() => api<OvertimeRequestView[]>(`/hrms/attendance/overtime/${listPath}`));
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { if (c.data && o.data) setRows(sortNewest([...c.data.map(fromCorrection), ...o.data.map(fromOvertime)])); }, [c.data, o.data]);
  return { rows, setRows, loading: (c.loading || o.loading) && !rows.length, error: c.error || o.error, reload: () => { c.reload(); o.reload(); } };
}

/** The signed-in person's corrections and overtime requests, with cancel. */
export function MyRequests() {
  const q = useRows('mine');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  async function cancel(r: Row) {
    setBusyId(r.publicId); setError('');
    try { await api(path(r, 'cancel'), { method: 'POST', json: {} }); q.reload(); }
    catch (e) { setError(errText(e)); }
    finally { setBusyId(''); }
  }
  return <Panel title="My requests" note="Corrections and overtime you asked for. Make new ones from My history.">
    <div className="panel-body">
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {q.loading ? <Loading /> : !q.rows.length ? <Empty title="No requests yet" text="Open My history and use Fix punch or Request overtime on a day." /> :
        <div className="table-wrap"><table><thead><tr><th>DAY</th><th>REQUEST</th><th>COMPANY</th><th>STATUS</th><th>NOTE</th><th /></tr></thead>
          <tbody>{q.rows.map((r) => <tr key={`${r.kind}-${r.publicId}`}>
            <td>{dayLabel(r.date)}</td><td>{r.title}</td><td>{r.company}</td>
            <td><Badge tone={STATUS_TONE[r.status] ?? 'gray'}>{r.status}</Badge></td>
            <td className="note-cell">{r.status === 'rejected' && r.decisionReason ? `Reason: ${r.decisionReason}` : r.reason}
              {r.status === 'submitted' && r.approver && <small className="sub">With {r.approver}</small>}</td>
            <td className="row-actions">{r.status === 'submitted' &&
              <button className="outline-btn danger" disabled={busyId === r.publicId} onClick={() => void cancel(r)}>Cancel</button>}</td></tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}

/** Corrections and overtime waiting for the manager. */
export function RequestApprovals() {
  const q = useRows('to-approve');
  const [rejecting, setRejecting] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const drop = (r: Row) => q.setRows((all) => all.filter((x) => !(x.kind === r.kind && x.publicId === r.publicId)));
  async function approve(r: Row) {
    setBusyId(r.publicId); setError('');
    try { await api(path(r, 'approve'), { method: 'POST', json: {} }); drop(r); }
    catch (e) { setError(errText(e)); }
    finally { setBusyId(''); }
  }
  return <Panel title="Requests to approve" note="Corrections and overtime from the people who report to you.">
    <div className="panel-body">
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {q.loading ? <Loading /> : !q.rows.length ? <Empty title="Nothing waiting" text="New requests from your team appear here." /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>DAY</th><th>REQUEST</th><th>REASON</th><th /></tr></thead>
          <tbody>{q.rows.map((r) => <tr key={`${r.kind}-${r.publicId}`}>
            <td><b>{r.person}</b><small className="sub">{r.company}</small></td><td>{dayLabel(r.date)}</td><td>{r.title}</td><td className="note-cell">{r.reason}</td>
            <td className="row-actions">
              <button className="outline-btn ok" disabled={busyId === r.publicId} onClick={() => void approve(r)}><Check size={13} /> Approve</button>
              <button className="outline-btn danger" onClick={() => setRejecting(r)}><X size={13} /> Reject</button></td></tr>)}</tbody></table></div>}
    </div>
    {rejecting && <Reject row={rejecting} onClose={() => setRejecting(null)} onDone={() => { drop(rejecting); setRejecting(null); }} />}
  </Panel>;
}

function Reject({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim().length < 3) { setError('Give a reason of at least 3 characters'); return; }
    setBusy(true); setError('');
    try { await api(path(row, 'reject'), { method: 'POST', json: { reason: text.trim() } }); onDone(); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  return <Modal title="Reject request" subtitle={`${row.person} · ${dayLabel(row.date)}`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid"><label className="span-two">Reason
        <input id="req-reject" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} autoFocus placeholder="Tell the person why" /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" disabled={busy}>Reject</button></div>
    </form>
  </Modal>;
}

/** Fix a missed or wrong punch on one day taken from My history. */
export function CorrectionModal({ day, onClose, onSaved }: { day: HistoryRow; onClose: () => void; onSaved: () => void }) {
  const [requestId] = useState(uuidv7); // one id per form, so pressing Send twice stores one request
  const [kind, setKind] = useState<CorrectionKind>(day.status === 'missed_punch' ? 'missed_out' : 'wrong_time');
  const [exclude, setExclude] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const needsIn = kind === 'missed_in' || kind === 'wrong_time' || kind === 'other';
  const needsOut = kind === 'missed_out' || kind === 'wrong_time' || kind === 'other';
  const toggle = (id: string) => setExclude((all) => (all.includes(id) ? all.filter((x) => x !== id) : [...all, id]));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const parsed = CreateCorrectionRequest.safeParse({
      publicId: requestId, employmentPublicId: day.employment.publicId, workDate: day.date, kind,
      requestedIn: needsIn ? istToIso(String(d.get('in') ?? '')) : undefined, requestedOut: needsOut ? istToIso(String(d.get('out') ?? '')) : undefined,
      punchIdsToExclude: kind === 'missed_in' || kind === 'missed_out' ? [] : exclude, reason: String(d.get('reason') ?? '').trim(),
    });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { await api('/hrms/attendance/corrections', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }

  const live = day.punches.filter((p) => !p.corrected);
  const dateTime = (id: string, name: string, label: string, optional: boolean) =>
    <label>{label}{optional && <span className="optional"> optional</span>}<input id={id} name={name} type="datetime-local" defaultValue={`${day.date}T09:00`} /></label>;
  return <Modal title="Fix a punch" subtitle={`${dayLabel(day.date)} · ${day.employment.company} · times are IST`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label className="span-two">What happened
          <select id="corr-kind" value={kind} onChange={(e) => setKind(e.target.value as CorrectionKind)}>
            {(Object.keys(KIND_LABEL) as CorrectionKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></label>
        {needsIn && dateTime('corr-in', 'in', 'Right punch-in', kind !== 'missed_in')}
        {needsOut && dateTime('corr-out', 'out', 'Right punch-out', kind !== 'missed_out')}
        {(kind === 'wrong_time' || kind === 'other') && <fieldset className="span-two"><legend>Punches to leave out</legend>
          {live.length ? live.map((p) => <label key={p.publicId} className="check-row"><input type="checkbox" checked={exclude.includes(p.publicId)} onChange={() => toggle(p.publicId)} />
            {p.kind === 'in' ? 'In' : 'Out'} at {timeIst(p.occurredAt)}</label>) : <span className="muted-text">No punches that day.</span>}</fieldset>}
        <label className="span-two">Reason<input id="corr-reason" name="reason" required minLength={10} maxLength={500} placeholder="At least 10 characters: what happened" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Sending…' : 'Send for approval'}</button></div>
    </form>
  </Modal>;
}

/** Ask for the extra time of one day (or a planned day) to be paid as overtime. */
export function OvertimeModal({ day, onClose, onSaved }: { day: HistoryRow; onClose: () => void; onSaved: () => void }) {
  const [requestId] = useState(uuidv7);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const parsed = CreateOvertimeRequest.safeParse({
      publicId: requestId, employmentPublicId: day.employment.publicId, workDate: day.date,
      minutes: Math.round(Number(d.get('hours')) * 60), reason: String(d.get('reason') ?? '').trim(),
    });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { await api('/hrms/attendance/overtime', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  const left = Math.max(day.extraMinutes - day.approvedOvertimeMinutes, 0);
  return <Modal title="Request overtime" subtitle={`${dayLabel(day.date)} · ${day.employment.company} · extra worked ${hm(day.extraMinutes)}`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Hours<input id="ot-hours" name="hours" type="number" step="0.25" min="0.25" max="24" required defaultValue={left ? (left / 60).toFixed(2).replace(/\.?0+$/, '') : ''} /></label>
        <label className="span-two">Reason<input id="ot-reason" name="reason" required minLength={3} maxLength={500} placeholder="Why the extra time was needed" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Sending…' : 'Send for approval'}</button></div>
    </form>
  </Modal>;
}
