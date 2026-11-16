import { useState, type FormEvent } from 'react';
import { ApproveSplitRequest, ReasonRequest, SuggestSplitRequest, type DayAllocation, type SplitSuggestion } from '@ageless/shared';
import { api, errText, formError } from '../api';
import { useAuth } from '../auth';
import { dayLabel, hm, todayIst, useLoad, uuidv7 } from '../hooks';
import { Badge, Empty, Loading, Modal, Notice, Panel } from '../ui';

/**
 * Split suggestions. A day's ticket time is shared equally between tickets that ran together, which is often not how the
 * day went. The person suggests another split (in percent); nothing changes until their department head approves,
 * changes or rejects it. With no suggestion the equal split stands.
 */

/** Whole minutes for each share of `total` in proportion to `weights`, adding up exactly (the minutes left go to the largest remainders). */
function shareOut(weights: number[], total: number): number[] {
  const sum = weights.reduce((x, y) => x + y, 0);
  if (sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w * total) / sum);
  const shares = exact.map(Math.floor);
  let left = total - shares.reduce((x, y) => x + y, 0);
  for (const { i } of exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((p, q) => q.rest - p.rest || p.i - q.i)) {
    if (left <= 0) break;
    shares[i] = shares[i]! + 1;
    left -= 1;
  }
  return shares;
}

/** The person suggests another split of their own day, in percent of its ticket time (e.g. 70 / 20 / 10). */
export function SuggestSplit({ a, onClose, onSaved }: { a: DayAllocation; onClose: () => void; onSaved: () => void }) {
  const total = a.rows.reduce((x, r) => x + r.minutes, 0);
  const [id] = useState(uuidv7);
  const [pct, setPct] = useState<number[]>(() => shareOut(a.rows.map((r) => r.minutes), 100));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pctSum = pct.reduce((x, y) => x + y, 0);
  const minutes = pctSum === 100 ? shareOut(pct, total) : a.rows.map(() => 0);
  const unchanged = pctSum === 100 && minutes.every((m, i) => m === a.rows[i]!.minutes);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pctSum !== 100) { setError(`The shares add up to ${pctSum}%: make them 100%`); return; }
    const parsed = SuggestSplitRequest.safeParse({ publicId: id, date: a.date, note: note.trim(),
      tickets: a.rows.map((r, i) => ({ ticketPublicId: r.ticket.publicId, minutes: minutes[i] })) });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setBusy(true); setError('');
    try { await api('/tickets/time/suggestions', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  return <Modal title="Suggest a different split" onClose={onClose}
    subtitle={`${dayLabel(a.date)} · ${hm(total)} on tickets, shared equally now. Say how it really went: your department head approves it, and only then your time changes.`}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        {a.rows.map((r, i) => <label key={r.ticket.publicId} className="span-two">{r.ticket.number} · {r.ticket.title}
          <span className="optional">% of the day · now {hm(r.minutes)}{pctSum === 100 ? ` → ${hm(minutes[i]!)}` : ''}</span>
          <input id={`sp-${r.ticket.publicId}`} type="number" min={0} max={100} step={1} value={pct[i]}
            onChange={(e) => { const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))); setPct((p) => p.map((x, j) => (j === i ? v : x))); }} /></label>)}
        <p className={`span-two ${pctSum === 100 ? 'muted-text' : 'field-error'}`}>Total {pctSum}%{pctSum === 100 ? '' : ': make it 100%'}</p>
        <label className="span-two">Note for your head <span className="optional">optional</span>
          <input id="sp-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. Most of the day on the first site" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" disabled={busy || pctSum !== 100 || unchanged}>{busy ? 'Sending...' : 'Send to my head'}</button></div>
    </form>
  </Modal>;
}

/** After the daily punch-out (Attendance): today's ticket time per ticket, and a way to suggest a different split. */
export function TodaySplit() {
  const { me } = useAuth();
  const q = useLoad(() => (me ? api<DayAllocation>(`/tickets/time/allocations?person=${me.person.publicId}&date=${todayIst()}`) : Promise.resolve(null)),
    [me?.person.publicId]);
  const [suggesting, setSuggesting] = useState(false);
  const [sent, setSent] = useState(false);
  const a = q.data;
  if (!a || a.rows.length < 2) return null;   // one ticket or none: nothing to split
  return <div className="detail-section">
    <h3>Today's ticket time</h3>
    {a.rows.map((r) => <div className="detail-row" key={r.ticket.publicId}><span>{r.ticket.number} · {r.ticket.title}</span><b>{hm(r.minutes)}</b></div>)}
    {sent ? <p className="muted-text">Suggestion sent to your department head.</p>
      : <div className="chip-row"><span className="muted-text">Not how your day went?</span>
        <button className="outline-btn" onClick={() => setSuggesting(true)}>Suggest a different split</button></div>}
    {suggesting && <SuggestSplit a={a} onClose={() => setSuggesting(false)} onSaved={() => { setSuggesting(false); setSent(true); }} />}
  </div>;
}

/** Split suggestions: mine (withdraw while waiting) and the ones I decide (approve, change, reject). */
export function SplitSuggestions() {
  const { me } = useAuth();
  const [status, setStatus] = useState('pending');
  const q = useLoad(() => api<SplitSuggestion[]>(`/tickets/time/suggestions${status ? `?status=${status}` : ''}`), [status]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [deciding, setDeciding] = useState<{ s: SplitSuggestion; kind: 'change' | 'reject' } | null>(null);

  async function call(s: SplitSuggestion, action: 'approve' | 'reject' | 'cancel', json: unknown, done: string) {
    setBusy(true); setError(''); setOk('');
    try { await api(`/tickets/time/suggestions/${s.publicId}/${action}`, { method: 'POST', json }); setOk(done); setDeciding(null); q.reload(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }
  const tone = (s: SplitSuggestion) => (s.status === 'approved' ? 'green' : s.status === 'rejected' ? 'red' : s.status === 'cancelled' ? 'gray' : 'amber');

  return <Panel title="Split suggestions" note="People suggest how their day's ticket time really went; the department head approves, changes or rejects it. Until then the equal split stands.">
    <div className="panel-body">
      <div className="filters"><label className="inline-field">Status<select id="ss-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="pending">Waiting</option><option value="">All</option></select></label></div>
      {(error || q.error) && <Notice onClose={() => setError('')}>{error || q.error}</Notice>}
      {ok && <Notice tone="ok" onClose={() => setOk('')}>{ok}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title={status ? 'Nothing waiting' : 'No suggestions'} /> :
        q.data.map((s) => <div className="detail-section" key={s.publicId}>
          <div className="detail-row"><span><b>{s.person.displayName}</b> · {dayLabel(s.date)}{s.note ? ` · "${s.note}"` : ''}</span>
            <Badge tone={tone(s)}>{s.status === 'pending' ? 'waiting' : s.status}</Badge></div>
          <div className="table-wrap"><table><thead><tr><th>TICKET</th><th>EQUAL SPLIT</th><th>SUGGESTED</th>{s.status === 'approved' && <th>APPROVED</th>}</tr></thead>
            <tbody>{s.rows.map((r) => <tr key={r.ticket.publicId}><td><b>{r.ticket.number}</b><small className="sub">{r.ticket.title}</small></td>
              <td>{hm(r.beforeMinutes)}</td><td><b>{hm(r.suggestedMinutes)}</b></td>
              {s.status === 'approved' && <td>{r.approvedMinutes === null ? '-' : hm(r.approvedMinutes)}</td>}</tr>)}</tbody></table></div>
          {s.decidedBy && <p className="muted-text">{s.status === 'approved' ? 'Approved' : 'Rejected'} by {s.decidedBy.displayName}{s.decisionReason ? `: ${s.decisionReason}` : ''}</p>}
          {s.canDecide && <div className="chip-row">
            <button className="primary-btn" disabled={busy} onClick={() => void call(s, 'approve', {}, `Approved: ${s.person.displayName}'s time on ${dayLabel(s.date)} is changed.`)}>Approve</button>
            <button className="outline-btn" disabled={busy} onClick={() => setDeciding({ s, kind: 'change' })}>Change...</button>
            <button className="outline-btn" disabled={busy} onClick={() => setDeciding({ s, kind: 'reject' })}>Reject...</button></div>}
          {s.status === 'pending' && s.person.publicId === me?.person.publicId && <div className="chip-row">
            <span className="muted-text">Waiting for your department head.</span>
            <button className="text-btn" disabled={busy} onClick={() => void call(s, 'cancel', {}, 'Suggestion withdrawn.')}>Withdraw</button></div>}
        </div>)}
    </div>
    {deciding?.kind === 'change' && <ChangeSplit s={deciding.s} busy={busy} onClose={() => setDeciding(null)}
      run={(body) => call(deciding.s, 'approve', body, `Approved with your changes: ${deciding.s.person.displayName}'s time on ${dayLabel(deciding.s.date)} is changed.`)} />}
    {deciding?.kind === 'reject' && <RejectSplit s={deciding.s} busy={busy} onClose={() => setDeciding(null)}
      run={(body) => call(deciding.s, 'reject', body, 'Rejected. The split stays as it was.')} />}
  </Panel>;
}

/** The head approves with their own minutes per ticket (the same total) and says why. */
function ChangeSplit({ s, busy, onClose, run }: { s: SplitSuggestion; busy: boolean; onClose: () => void; run: (b: ApproveSplitRequest) => Promise<void> }) {
  const total = s.rows.reduce((x, r) => x + r.beforeMinutes, 0);
  const [mins, setMins] = useState(s.rows.map((r) => r.suggestedMinutes));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const sum = mins.reduce((x, y) => x + y, 0);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (sum !== total) { setError(`The minutes add up to ${hm(sum)}; they must add up to ${hm(total)}`); return; }
    const parsed = ApproveSplitRequest.safeParse({ reason: reason.trim(), tickets: s.rows.map((r, i) => ({ ticketPublicId: r.ticket.publicId, minutes: mins[i] })) });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    void run(parsed.data);
  }
  return <Modal title="Change and approve" subtitle={`${s.person.displayName} · ${dayLabel(s.date)} · ${hm(total)} on these tickets, in minutes.`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        {s.rows.map((r, i) => <label key={r.ticket.publicId} className="span-two">{r.ticket.number} · {r.ticket.title}
          <span className="optional">equal {hm(r.beforeMinutes)} · suggested {hm(r.suggestedMinutes)}</span>
          <input id={`cs-${r.ticket.publicId}`} type="number" min={0} max={1440} step={1} value={mins[i]}
            onChange={(e) => { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); setMins((m) => m.map((x, j) => (j === i ? v : x))); }} /></label>)}
        <p className={`span-two ${sum === total ? 'muted-text' : 'field-error'}`}>Total {hm(sum)} of {hm(total)}</p>
        <label className="span-two">Why you changed it<input id="cs-reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={300} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" disabled={busy || sum !== total}>Approve with changes</button></div>
    </form>
  </Modal>;
}

function RejectSplit({ s, busy, onClose, run }: { s: SplitSuggestion; busy: boolean; onClose: () => void; run: (b: ReasonRequest) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = ReasonRequest.safeParse({ reason: reason.trim() });
    if (!parsed.success) { setError(formError(parsed.error, 'Give a reason')); return; }
    void run(parsed.data);
  }
  return <Modal title="Reject the suggestion" subtitle={`${s.person.displayName} · ${dayLabel(s.date)}. The split stays as it is.`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid"><label className="span-two">Reason<input id="rs-reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={500} /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn" disabled={busy}>Reject</button></div>
    </form>
  </Modal>;
}
