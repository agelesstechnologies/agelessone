import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import {
  AdjustTimeRequest, DailyUpdateRequest, TicketPunchInRequest, TicketPunchOutRequest,
  type DailyUpdate, type DayAllocation, type MissingUpdate, type RunningTicket, type TicketPunchResult, type TicketSummary,
} from '@ageless/shared';
import { SplitSuggestions, SuggestSplit } from './SplitSuggestions';
import { api, errText, formError } from '../api';
import { useAuth } from '../auth';
import { addDays, dayLabel, devicePosition, hm, timeIst, todayIst, useLoad, uuidv7 } from '../hooks';
import { PersonPicker } from '../JobPicker';
import { TICKETS } from '../permissions';
import { Badge, Empty, Loading, Modal, Notice, Panel } from '../ui';

/** Ticket punch (several timers at once), daily updates, who is missing an update, and the day's shared time. */
export default function TicketTime() {
  const { can } = useAuth();
  return <>
    {can(TICKETS.work) && <Running />}
    <SplitSuggestions />
    <Missing />
    <Allocation />
  </>;
}

/** Ticks in a list of ticket IDs: toggle one, or all / none. */
const toggle = (s: Set<string>, id: string, on: boolean) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; };
const plural = (n: number) => `${n} ticket${n === 1 ? '' : 's'}`;

function Running() {
  const running = useLoad(() => api<RunningTicket[]>('/tickets/time/running'));
  const mine = useLoad(() => api<TicketSummary[]>('/tickets/mine'));
  const [picked, setPicked] = useState<Set<string>>(new Set());     // tickets to punch in on
  const [stopping, setStopping] = useState<Set<string>>(new Set()); // running tickets to punch out of
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [updating, setUpdating] = useState<{ id: string; label: string } | null>(null);
  const runs = running.data ?? [];
  const runningIds = new Set(runs.map((r) => r.ticket.publicId));
  const candidates = (mine.data ?? []).filter((t) => (t.status === 'assigned' || t.status === 'in_progress' || t.status === 'open') && !runningIds.has(t.publicId));
  const chosenOut = [...stopping].filter((id) => runningIds.has(id));
  const allTicked = runs.length > 0 && chosenOut.length === runs.length;

  async function call(path: string, json: unknown) {
    setBusy(true); setError(''); setOk('');
    try {
      const r = await api<TicketPunchResult>(path, { method: 'POST', json });
      setOk(r.started ? `Punched in on ${plural(r.started)}.` : `Punched out of ${plural(r.stopped)}.`);
      setPicked(new Set()); setStopping(new Set()); running.reload(); mine.reload();
    }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }
  async function punchIn() {
    setBusy(true);   // the position can take a few seconds: no second click meanwhile
    // the device position (when allowed) gives the punch-in address, as on the ticket screen
    const parsed = TicketPunchInRequest.safeParse({ items: [...picked].map((ticketPublicId) => ({ publicId: uuidv7(), ticketPublicId })), ...(await devicePosition()) });
    if (!parsed.success) { setBusy(false); setError(formError(parsed.error, 'Choose at least one ticket')); return; }
    void call('/tickets/punch-in', parsed.data);
  }
  /** Punch out of the tickets given (one, or the ticked ones), or of every running ticket. */
  function punchOut(ids?: string[]) {
    const parsed = TicketPunchOutRequest.safeParse(ids ? { tickets: ids } : { all: true });
    if (parsed.success) void call('/tickets/punch-out', parsed.data);
  }

  return <Panel title="Ticket time" note="Punch in for the day on the Attendance page first, then punch in on the tickets you work on. Time is shared when tickets run together.">
    <div className="panel-body">
      {(error || running.error) && <Notice onClose={() => setError('')}>{error || running.error}</Notice>}
      {ok && <Notice tone="ok" onClose={() => setOk('')}>{ok}</Notice>}
      <h3>Running now</h3>
      {running.loading && !running.data ? <Loading /> : !runs.length ? <Empty title="No tickets running" /> :
        <div className="table-wrap"><table><thead><tr>
          <th><input type="checkbox" aria-label="Tick all running tickets" checked={allTicked} disabled={busy}
            onChange={(e) => setStopping(e.target.checked ? new Set(runningIds) : new Set())} /></th>
          <th>TICKET</th><th>SINCE</th><th /></tr></thead>
          <tbody>{runs.map((r) => <tr key={r.timelogPublicId}>
            <td><input type="checkbox" aria-label={`Tick ${r.ticket.number}`} checked={stopping.has(r.ticket.publicId)} disabled={busy}
              onChange={(e) => setStopping((s) => toggle(s, r.ticket.publicId, e.target.checked))} /></td>
            <td><b>{r.ticket.number}</b><small className="sub">{r.ticket.title}</small></td><td>{timeIst(r.startedAt)}</td>
            <td><span className="chip-row">
              <button className="text-btn" disabled={busy} onClick={() => setUpdating({ id: r.ticket.publicId, label: r.ticket.number })}>Daily update</button>
              <button className="text-btn" disabled={busy} onClick={() => punchOut([r.ticket.publicId])}>Punch out</button></span></td></tr>)}</tbody></table></div>}
      {runs.length > 0 && <div className="chip-row">
        {runs.length > 1 && <button className="primary-btn" disabled={busy || !chosenOut.length} onClick={() => punchOut(chosenOut)}>
          {chosenOut.length ? `Punch out of ${plural(chosenOut.length)}` : 'Tick tickets to punch out'}</button>}
        <button className="outline-btn" disabled={busy} onClick={() => punchOut()}>Punch out of all ({runs.length})</button></div>}
      <h3>Start work</h3>
      {mine.loading && !mine.data ? <Loading /> : !candidates.length ? <Empty title="Nothing to start" text="Tickets assigned to you appear here." /> : <>
        <ul className="plain-list">{candidates.map((t) => <li key={t.publicId}>
          <label className="check-row"><input type="checkbox" checked={picked.has(t.publicId)}
            onChange={(e) => setPicked((s) => toggle(s, t.publicId, e.target.checked))} /> {t.number} · {t.title}</label></li>)}</ul>
        <div className="chip-row"><button className="primary-btn" disabled={busy || !picked.size} onClick={() => void punchIn()}>
          {picked.size ? `Punch in on ${plural(picked.size)}` : 'Tick tickets to punch in'}</button></div></>}
    </div>
    {updating && <TicketUpdates ticketId={updating.id} label={updating.label} onClose={() => setUpdating(null)} />}
  </Panel>;
}

/** The ticket's daily updates and a form to add today's (a note, percent done, and up to 5 photos or files). */
export function TicketUpdates({ ticketId, label, onClose, inline = false }: { ticketId: string; label: string; onClose?: () => void; inline?: boolean }) {
  const q = useLoad(() => api<DailyUpdate[]>(`/tickets/${ticketId}/updates`), [ticketId]);
  const { can } = useAuth();
  const [id, setId] = useState(uuidv7);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const parsed = DailyUpdateRequest.safeParse({ publicId: id, note: String(f.get('note')).trim(), percentComplete: Number(f.get('percent')) });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    const files = f.getAll('files').filter((x): x is File => x instanceof File && x.size > 0);
    if (files.length > 5) { setError('At most 5 files'); return; }
    setSaving(true); setError('');
    try {
      if (files.length) {
        const body = new FormData();
        body.append('publicId', id); body.append('note', parsed.data.note); body.append('percentComplete', String(parsed.data.percentComplete));
        files.forEach((x) => body.append('files', x));
        await api(`/tickets/${ticketId}/updates`, { method: 'POST', body });
      } else await api(`/tickets/${ticketId}/updates`, { method: 'POST', json: parsed.data });
      form.reset(); setId(uuidv7()); q.reload();
    } catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  const body = <>
    {q.error && <Notice>{q.error}</Notice>}
    {q.loading && !q.data ? <Loading /> : !q.data?.length ? <p className="muted-text">No notes yet. Add today's progress below.</p> : inline
      ? <div className="tp-notes">{q.data.map((u) => <div className="tp-note" key={u.publicId}>
          <div className="tp-note-top"><b>{u.person.displayName}</b><span>{dayLabel(u.workDate)}</span><span className="tp-pct">{u.percentComplete}% done</span></div>
          <p>{u.note}</p>{u.attachments.length > 0 && <small className="muted-text">{u.attachments.length} file{u.attachments.length === 1 ? '' : 's'} attached</small>}</div>)}</div>
      : q.data.map((u) => <div className="detail-row" key={u.publicId}><span>{dayLabel(u.workDate)} · {u.person.displayName}: {u.note}</span><b>{u.percentComplete}%{u.attachments.length ? ` · ${u.attachments.length} file${u.attachments.length === 1 ? '' : 's'}` : ''}</b></div>)}
    {can(TICKETS.work) && <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label className="span-two">Note<input id="du-note" name="note" required minLength={3} maxLength={1000} /></label>
        <label>Percent complete<input id="du-pct" name="percent" type="number" min={0} max={100} required defaultValue={0} /></label>
        <label>Photos / files <span className="optional">up to 5</span><input id="du-files" name="files" type="file" multiple accept="application/pdf,image/jpeg,image/png" /></label>
      </div>
      <div className="modal-foot">{!inline && <button type="button" className="outline-btn" onClick={onClose}>Close</button>}<button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : inline ? 'Add note' : 'Add update'}</button></div>
    </form>}
  </>;
  return inline ? <div className="tp-updates">{body}</div> : <Modal title="Daily updates" subtitle={label} onClose={onClose ?? (() => {})}>{body}</Modal>;
}

function Missing() {
  const [date, setDate] = useState(addDays(todayIst(), -1));
  const q = useLoad(() => api<MissingUpdate[]>(`/tickets/daily-updates/missing?date=${date}`), [date]);
  return <Panel title="Missing daily updates" note="People who ran a timer on a ticket but wrote no update.">
    <div className="panel-body">
      <div className="filters"><label className="inline-field">Date<input id="mu-date" type="date" className="input" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} /></label></div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="Nothing missing" /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>TICKET</th><th>DEPARTMENT</th><th>TIME</th></tr></thead>
          <tbody>{q.data.map((m) => <tr key={`${m.person.publicId}-${m.ticket.publicId}`}><td>{m.person.displayName}</td>
            <td><b>{m.ticket.number}</b><small className="sub">{m.ticket.title}</small></td><td>{m.department.name}</td><td>{hm(m.minutes)}</td></tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}

function Allocation() {
  const { can, me } = useAuth();
  const [person, setPerson] = useState('');
  const [date, setDate] = useState(todayIst());
  const [shown, setShown] = useState<{ person: string; date: string } | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [sent, setSent] = useState('');
  const q = useLoad(() => shown ? api<DayAllocation>(`/tickets/time/allocations?person=${shown.person}&date=${shown.date}`) : Promise.resolve(null), [shown?.person, shown?.date]);
  const a = q.data;
  return <Panel title="Time per ticket" note="A person's attended minutes for one day, shared across the tickets they worked on.">
    <div className="panel-body">
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (person) setShown({ person, date }); }}>
        <PersonPicker idPrefix="al" label="Person" onChange={setPerson} />
        <label>Date<input id="al-date" type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} /></label>
        <div className="chip-row"><button className="outline-btn" disabled={!person}>Show</button></div>
      </form>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && shown && !a ? <Loading /> : a && <>
        <div className="mini-stats"><div><small>ATTENDED</small><strong>{hm(a.attendanceMinutes)}</strong></div><div><small>ON TICKETS</small><strong>{hm(a.totalMinutes)}</strong></div></div>
        {!a.rows.length ? <Empty title="No ticket time that day" /> :
          <div className="table-wrap"><table><thead><tr><th>TICKET</th><th>CALCULATED</th><th>ADJUSTED</th><th>TOTAL</th></tr></thead>
            <tbody>{a.rows.map((r) => <tr key={r.ticket.publicId}><td><b>{r.ticket.number}</b><small className="sub">{r.ticket.title}</small></td>
              <td>{hm(r.calculatedMinutes)}</td><td>{r.adjustedMinutes ? `${r.adjustedMinutes > 0 ? '+' : '−'}${hm(Math.abs(r.adjustedMinutes))}` : '—'}</td><td><b>{hm(r.minutes)}</b></td></tr>)}</tbody></table></div>}
        {a.adjustments.map((x) => <div className="detail-row" key={`${x.batchId}-${x.ticket.publicId}`}>
          <span>{x.ticket.number}: {x.minutes > 0 ? '+' : '−'}{Math.abs(x.minutes)} min · {x.reason}</span><Badge tone="blue">{x.adjustedBy.displayName} ({x.adjustedAs})</Badge></div>)}
        {sent && <Notice tone="ok" onClose={() => setSent('')}>{sent}</Notice>}
        <div className="chip-row">
          {can(TICKETS.timeAdjust) && a.person.publicId !== me?.person.publicId && !!a.rows.length && <button className="outline-btn" onClick={() => setAdjusting(true)}><Plus size={13} /> Adjust time</button>}
          {can(TICKETS.work) && a.person.publicId === me?.person.publicId && a.rows.length >= 2 &&
            <button className="outline-btn" onClick={() => setSuggesting(true)}>Suggest a different split</button>}</div>
        {adjusting && <Adjust a={a} onClose={() => setAdjusting(false)} onSaved={() => { setAdjusting(false); q.reload(); }} />}
        {suggesting && <SuggestSplit a={a} onClose={() => setSuggesting(false)}
          onSaved={() => { setSuggesting(false); setSent('Sent to your department head. Your time changes only when they approve it.'); }} />}
      </>}
    </div>
  </Panel>;
}

/** Move minutes between tickets of one day: + adds, − takes away. The reason is kept with the change. */
function Adjust({ a, onClose, onSaved }: { a: DayAllocation; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const changes = a.rows.map((r) => ({ ticketPublicId: r.ticket.publicId, minutes: Math.round(Number(f.get(`m_${r.ticket.publicId}`)) || 0) })).filter((c) => c.minutes !== 0);
    const parsed = AdjustTimeRequest.safeParse({ personPublicId: a.person.publicId, date: a.date, reason: String(f.get('reason')).trim(), changes });
    if (!parsed.success) { setError(changes.length ? formError(parsed.error, 'Check the form') : 'Enter minutes for at least one ticket'); return; }
    try { await api('/tickets/time/adjustments', { method: 'POST', json: parsed.data }); onSaved(); } catch (err) { setError(errText(err)); }
  }
  return <Modal title="Adjust ticket time" subtitle={`${a.person.displayName} · ${dayLabel(a.date)}. Minutes: + adds, − takes away.`} onClose={onClose}><form onSubmit={submit}>
    {error && <Notice>{error}</Notice>}
    <div className="form-grid">
      {a.rows.map((r) => <label key={r.ticket.publicId} className="span-two">{r.ticket.number} · {r.ticket.title} <span className="optional">now {hm(r.minutes)}</span>
        <input id={`adj-${r.ticket.publicId}`} name={`m_${r.ticket.publicId}`} type="number" step={1} min={-1440} max={1440} placeholder="0" /></label>)}
      <label className="span-two">Reason<input id="adj-reason" name="reason" required minLength={3} maxLength={500} /></label>
    </div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn">Save adjustment</button></div></form></Modal>;
}

