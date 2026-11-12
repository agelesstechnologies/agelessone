import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft, CalendarCheck, CalendarClock, ChevronDown, ChevronUp, Clock, Download, FileText, HardHat, History, ListChecks, MapPin, MessageSquare, Paperclip, Plus,
  Share2, User, Users,
} from 'lucide-react';
import {
  AddExternalStaffRequest, AssignTicketRequest, ChecklistResultRequest, EndExternalStaffRequest, LinkTicketRequest, ReasonRequest, RecordExternalAttendanceRequest,
  SignoffRequest, TicketPunchInRequest, TicketPunchOutRequest, UpdateTicketRequest,
  type ChecklistResult, type ExternalAttendance, type ExternalAttendanceStatus, type ExternalStaff, type RunningTicket, type TicketDetail as Detail,
  type TicketSummary, type TicketTimelogs,
} from '@ageless/shared';
import { api, downloadFile, errText, formError } from '../api';
import { useAuth } from '../auth';
import { addDays, dayLabel, devicePosition, hm, timeIst, todayIst, useLoad, uuidv7, words } from '../hooks';
import JobPicker from '../JobPicker';
import { TICKETS } from '../permissions';
import { TicketUpdates } from './TicketTime';
import { Badge, DAY_TONE, Empty, Loading, Modal, Notice, type Tone } from '../ui';

export const STATUS_TONE: Record<string, Tone> = { open: 'gray', assigned: 'blue', in_progress: 'amber', on_hold: 'red', completed: 'green', cancelled: 'gray' };
export const statusLabel = (s: string) => s.replace(/_/g, ' ');
const stamp = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

type Dialog = 'edit' | 'assign' | 'link' | 'signoff' | { reason: 'hold' | 'cancel' | 'reopen' | 'reassign-request' } | null;
const REASON_TITLE = { hold: 'Put on hold', cancel: 'Cancel ticket', reopen: 'Reopen ticket', 'reassign-request': 'Ask to be reassigned' } as const;
type View = 'home' | 'time' | 'files' | 'notes' | 'checklist' | 'staff' | 'history';
const VIEW_TITLE: Record<Exclude<View, 'home'>, string> = { time: 'Timelogs', files: 'Files and sign-off', notes: 'Notes', checklist: 'Checklist',
  staff: 'External staff', history: 'History' };

/**
 * One ticket as a page (#tickets/<id>), laid out like the Froid ticket screen: the ticket card, a grid of tiles
 * (Timelogs, Files, Notes, Checklist, External staff, History) and the main buttons. Each tile opens its own view.
 * Shows every action the signed-in person may take; the API answers each action with the updated ticket.
 */
export default function TicketPage({ id, onBack }: { id: string; onBack: () => void }) {
  const { can, me } = useAuth();
  const q = useLoad(() => api<Detail>(`/tickets/${id}`), [id]);
  const [view, setView] = useState<View>('home');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [allPeople, setAllPeople] = useState(false);
  const t = q.data;
  const manage = can(TICKETS.manage);
  /** the on-site supervisor of this ticket: requirements, external staff, hold and resume (not create, assign or cancel) */
  const siteSup = !manage && can(TICKETS.site) && !!t && t.supervisor.publicId === me?.person.publicId;
  const runSite = manage || siteSup;
  const work = can(TICKETS.work) || runSite;
  const live = !!t && t.status !== 'completed' && t.status !== 'cancelled';
  const assignee = !!t && t.assignees.some((a) => a.person.publicId === me?.person.publicId);

  async function act(fn: () => Promise<Detail | void>, done?: string) {
    setBusy(true); setError(''); setNote('');
    try { const r = await fn(); if (r) q.setData(r); setDialog(null); if (done) setNote(done); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }
  const post = (action: string, json: unknown = {}, done?: string) => act(() => api<Detail>(`/tickets/${id}/${action}`, { method: 'POST', json }), done);
  async function upload(kind: 'photo' | 'file', f: File) {
    const body = new FormData(); body.append('kind', kind); body.append('file', f);
    await act(() => api<Detail>(`/tickets/${id}/attachments`, { method: 'POST', body }), kind === 'photo' ? 'Photo added.' : 'File added.');
  }
  async function share() {
    try { await navigator.clipboard.writeText(window.location.href); setNote('Link copied. Paste it in a message to share this ticket.'); }
    catch { setNote(`Ticket link: ${window.location.href}`); }
  }
  function back() {
    setError(''); setNote('');
    if (view === 'home') onBack(); else { setView('home'); q.reload(); }
  }

  const head = <div className="tp-bar">
    <button className="icon-button" aria-label="Back" onClick={back}><ArrowLeft size={20} /></button>
    <h1>{view === 'home' ? 'Ticket details' : VIEW_TITLE[view]}</h1>
    {view === 'home' ? <button className="icon-button" aria-label="Share" onClick={() => void share()}><Share2 size={19} /></button> : <span className="tp-bar-gap" />}
  </div>;

  if (!t) return <div className="ticket-page">{head}{q.error ? <Notice>{q.error}</Notice> : <Loading />}</div>;

  const people = [...t.assignees].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const shownPeople = allPeople ? people : people.slice(0, 2);
  const answered = t.checklist.filter((c) => c.result).length;
  const tiles: { key: Exclude<View, 'home'>; label: string; icon: ReactNode; count?: string }[] = [
    { key: 'time', label: 'Timelogs', icon: <Clock size={22} /> },
    { key: 'files', label: 'Files', icon: <Paperclip size={22} />, count: t.attachments.length ? String(t.attachments.length) : undefined },
    { key: 'notes', label: 'Notes', icon: <MessageSquare size={22} /> },
    ...(t.checklist.length ? [{ key: 'checklist' as const, label: 'Checklist', icon: <ListChecks size={22} />, count: `${answered}/${t.checklist.length}` }] : []),
    { key: 'staff', label: 'External staff', icon: <HardHat size={22} /> },
    { key: 'history', label: 'History', icon: <History size={22} /> },
  ];
  const canStart = live && work && (t.status === 'assigned' || t.status === 'open');
  const canComplete = live && work && (t.status === 'in_progress' || t.status === 'assigned');
  const manageButtons = [
    live && runSite && <button key="edit" className="outline-btn" onClick={() => setDialog('edit')}>{siteSup ? 'Edit requirements' : 'Edit'}</button>,
    live && manage && <button key="assign" className="outline-btn" onClick={() => setDialog('assign')}>Assign</button>,
    live && manage && <button key="link" className="outline-btn" onClick={() => setDialog('link')}>Link ticket</button>,
    live && manage && t.typeRules.completionRules.head_approval_required && !t.headApproval &&
      <button key="approve" className="outline-btn" disabled={busy} onClick={() => void post('head-approval', {}, 'Approved.')}>Head approval</button>,
    live && runSite && t.status === 'in_progress' && <button key="hold" className="outline-btn" onClick={() => setDialog({ reason: 'hold' })}>Hold</button>,
    live && manage && <button key="cancel" className="outline-btn" onClick={() => setDialog({ reason: 'cancel' })}>Cancel ticket</button>,
    t.status === 'completed' && manage && <button key="reopen" className="outline-btn" onClick={() => setDialog({ reason: 'reopen' })}>Reopen</button>,
    // the full report (PDF, photos included): the department head, the Manager who created or supervises it, Management
    t.canDownloadReport && <button key="report" className="outline-btn" disabled={busy} onClick={() => void act(async () => {
      await downloadFile(`/tickets/${id}/report.pdf`, `${t.number}-report.pdf`);
      return api<Detail>(`/tickets/${id}`);           // the history now shows the download
    }, 'Report downloaded.')}><FileText size={13} /> Download report</button>,
  ].filter(Boolean);

  return <div className="ticket-page">
    {head}
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}

    {view === 'home' && <>
      <section className="tp-card">
        <div className="tp-title">
          <div><b className="tp-number">{t.number}</b><span className="tp-sub">{t.company} · {t.department.name}</span></div>
          <div className="tp-badges">
            <Badge tone={STATUS_TONE[t.status] ?? 'gray'}>{statusLabel(t.status)}</Badge>
            <Badge tone={t.priority <= 2 ? 'red' : t.priority === 3 ? 'amber' : 'gray'}>P{t.priority}</Badge>
            {t.overdue && <Badge tone="red">overdue</Badge>}
          </div>
        </div>
        <h2 className="tp-name">{t.title}</h2>
        <p className="tp-type">{t.type.name}</p>
        <dl className="tp-rows">
          <Row icon={<CalendarClock size={16} />} label="Scheduled">{stamp(t.scheduledAt)}</Row>
          {t.dueDate && <Row icon={<CalendarClock size={16} />} label="Due">{dayLabel(t.dueDate)}</Row>}
          {t.site && <Row icon={<MapPin size={16} />} label="Site">{t.site}</Row>}
          <Row icon={<User size={16} />} label="Supervisor">{t.supervisor.displayName}</Row>
          <Row icon={<Users size={16} />} label="Employees">
            {people.length ? <span className="tp-people">{shownPeople.map((a) => <span key={a.employmentPublicId}>{a.person.displayName}{a.isPrimary ? ' (Primary)' : ''}</span>)}
              {people.length > 2 && <button className="text-btn" onClick={() => setAllPeople((v) => !v)}>
                {allPeople ? <>Show less <ChevronUp size={13} /></> : <>Show all ({people.length}) <ChevronDown size={13} /></>}</button>}</span>
              : <span className="muted-text">Nobody assigned yet</span>}
          </Row>
          {Object.entries(t.details).map(([k, v]) => <Row key={k} icon={<FileText size={16} />} label={t.typeRules.fields.find((f) => f.key === k)?.label ?? k}>{String(v)}</Row>)}
          {t.description && <Row icon={<FileText size={16} />} label="Description">{t.description}</Row>}
          {t.holdReason && t.status === 'on_hold' && <Row icon={<FileText size={16} />} label="On hold because">{t.holdReason}</Row>}
          {t.cancelReason && t.status === 'cancelled' && <Row icon={<FileText size={16} />} label="Cancelled because">{t.cancelReason}</Row>}
        </dl>
      </section>
      {t.warnings.map((w, i) => <Notice key={i}>{w.message}</Notice>)}

      <div className="tp-tiles">{tiles.map((x) => <button key={x.key} className="tp-tile" onClick={() => setView(x.key)}>
        <span className="tp-tile-icon">{x.icon}</span><span className="tp-tile-label">{x.label}</span>{x.count && <small>{x.count}</small>}</button>)}</div>

      {live && t.missingForCompletion.length > 0 && <Notice>To complete: {t.missingForCompletion.join(', ')}.</Notice>}
      <div className="tp-actions">
        {canStart && <button className="primary-btn tp-big" disabled={busy} onClick={() => void post('start', {}, 'Work started.')}>Start work</button>}
        {live && runSite && t.status === 'on_hold' && <button className="primary-btn tp-big" disabled={busy} onClick={() => void post('resume', {}, 'Work resumed.')}>Resume</button>}
        {canComplete && <button className="primary-btn tp-big" disabled={busy} onClick={() => void post('complete', {}, 'Ticket completed.')}>Complete ticket</button>}
        {live && can(TICKETS.work) && assignee && <button className="tp-big tp-warn" onClick={() => setDialog({ reason: 'reassign-request' })}>Ticket reassign request</button>}
      </div>
      {manageButtons.length > 0 && <div className="tp-manage"><span className="tp-manage-label">Manage</span>{manageButtons}</div>}
    </>}

    {view === 'time' && <Timelogs t={t} canPunch={live && can(TICKETS.work) && assignee} />}
    {view === 'notes' && <section className="tp-card"><TicketUpdates ticketId={id} label={t.number} inline /></section>}
    {view === 'staff' && <ExternalStaffSection ticketId={id} canAdd={runSite && live} canMark={t.status !== 'cancelled'} />}
    {view === 'files' && <section className="tp-card">
      {!t.attachments.length && !t.signoffs.length && !t.headApproval && <Empty title="Nothing attached yet" text="Photos, files and the customer's sign-off appear here." />}
      {t.attachments.map((a) => <div className="detail-row" key={a.publicId}><span>{a.kind} · {a.fileType} · {a.uploadedBy.displayName}</span>
        <button className="text-btn" onClick={() => void act(async () => { await downloadFile(`/tickets/${id}/attachments/${a.publicId}`, 'attachment'); })}><Download size={12} /> Open</button></div>)}
      {t.signoffs.map((s) => <div className="detail-row" key={s.publicId}><span>Signed off by {s.signerName}{s.signerRole ? `, ${s.signerRole}` : ''}</span><b>{stamp(s.signedAt)}</b></div>)}
      {t.headApproval && <div className="detail-row"><span>Head approval</span><b>{t.headApproval.by.displayName} · {stamp(t.headApproval.at)}</b></div>}
      {work && live && <div className="chip-row">
        <UploadButton label="Photo" accept="image/jpeg,image/png" onFile={(f) => upload('photo', f)} />
        <UploadButton label="File" accept="application/pdf,image/jpeg,image/png" onFile={(f) => upload('file', f)} />
        <button className="outline-btn" onClick={() => setDialog('signoff')}>Customer sign-off</button></div>}
    </section>}
    {view === 'checklist' && <section className="tp-card">
      {t.checklist.map((c) => <div className="detail-row" key={c.item}>
        <span>{c.item}{c.note ? ` — ${c.note}` : ''}</span>
        <span className="chip-row">{c.result ? <Badge tone={c.result === 'pass' ? 'green' : c.result === 'fail' ? 'red' : 'gray'}>{c.result}</Badge> : <Badge tone="amber">not answered</Badge>}
          {work && live && (['pass', 'fail', 'na'] as ChecklistResult[]).map((r) =>
            <button key={r} className="text-btn" disabled={busy} onClick={() => {
              const parsed = ChecklistResultRequest.safeParse({ item: c.item, result: r });
              if (parsed.success) void post('checklist', parsed.data);
            }}>{r}</button>)}</span></div>)}
    </section>}
    {view === 'history' && <section className="tp-card">
      {t.links.length > 0 && <><h3>Linked tickets</h3>
        {t.links.map((l) => <div className="detail-row" key={`${l.direction}-${l.ticket.publicId}`}>
          <span>{l.direction === 'to' ? l.kind.replace('_', ' ') : `${l.kind.replace('_', ' ')} (from)`}</span><b>{l.ticket.number} · {l.ticket.title} · {statusLabel(l.ticket.status)}</b></div>)}</>}
      {t.reassignRequests.length > 0 && <><h3>Reassignment requests</h3>
        {t.reassignRequests.map((r) => <div className="detail-row" key={r.publicId}><span>{r.requestedBy.displayName}: {r.reason}</span><Badge tone={r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'amber'}>{r.status}</Badge></div>)}</>}
      <h3>What happened</h3>
      {[...t.timeline].reverse().map((e, i) => <div className="detail-row" key={i}><span>{e.action.replace(/_/g, ' ')}{e.actor ? ` · ${e.actor.displayName}` : ''}</span><b>{stamp(e.at)}</b></div>)}
    </section>}

    {dialog === 'edit' && <EditTicket t={t} limited={siteSup} onClose={() => setDialog(null)} run={(body) => act(() => api<Detail>(`/tickets/${id}`, { method: 'PATCH', json: body }), 'Saved.')} />}
    {dialog === 'assign' && <AssignTicket onClose={() => setDialog(null)} run={(body) => act(() => api<Detail>(`/tickets/${id}/assignees`, { method: 'PUT', json: body }), 'Assigned.')} />}
    {dialog === 'link' && <LinkTicket t={t} onClose={() => setDialog(null)} run={(body) => act(() => api<Detail>(`/tickets/${id}/links`, { method: 'POST', json: body }), 'Linked.')} />}
    {dialog === 'signoff' && <Signoff onClose={() => setDialog(null)} run={(body) => act(() => api<Detail>(`/tickets/${id}/signoffs`, { method: 'POST', body }), 'Sign-off recorded.')} />}
    {dialog && typeof dialog === 'object' && <Reason title={REASON_TITLE[dialog.reason]} onClose={() => setDialog(null)}
      run={(body) => post(dialog.reason === 'reassign-request' ? 'reassign-requests' : dialog.reason, body,
        dialog.reason === 'reassign-request' ? 'Request sent to the supervisor.' : undefined)} />}
  </div>;
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return <div className="tp-row"><dt><span className="tp-row-icon">{icon}</span>{label}</dt><dd>{children}</dd></div>;
}

function UploadButton({ label, accept, onFile }: { label: string; accept: string; onFile: (f: File) => Promise<void> }) {
  return <label className="outline-btn" style={{ cursor: 'pointer' }}><Plus size={13} /> {label}
    <input type="file" accept={accept} hidden onChange={(e) => { const i = e.currentTarget; const f = i.files?.[0]; if (f) void onFile(f).then(() => { i.value = ''; }); }} /></label>;
}

/** Everyone's ticket punches on this ticket (newest first) and, for an assignee, punch in / out on it. */
function Timelogs({ t, canPunch }: { t: Detail; canPunch: boolean }) {
  const q = useLoad(() => api<TicketTimelogs>(`/tickets/${t.publicId}/timelogs`), [t.publicId]);
  const running = useLoad(() => (canPunch ? api<RunningTicket[]>('/tickets/time/running') : Promise.resolve([] as RunningTicket[])), [canPunch]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const on = !!running.data?.some((r) => r.ticket.publicId === t.publicId);

  async function punch() {
    setBusy(true); setError(''); setOk('');
    try {
      if (on) {
        await api('/tickets/punch-out', { method: 'POST', json: TicketPunchOutRequest.parse({ tickets: [t.publicId] }) });
        setOk('Punched out of this ticket.');
      } else {
        const parsed = TicketPunchInRequest.safeParse({ items: [{ publicId: uuidv7(), ticketPublicId: t.publicId }], ...(await devicePosition()) });
        if (!parsed.success) { setError(formError(parsed.error)); return; }
        const r = await api<{ confirmation?: { message?: string } }>('/tickets/punch-in', { method: 'POST', json: parsed.data });
        setOk(r.confirmation?.message ?? 'Punched in on this ticket.');
      }
      q.reload(); running.reload();
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  return <section className="tp-card">
    {(error || q.error) && <Notice onClose={() => setError('')}>{error || q.error}</Notice>}
    {ok && <Notice tone="ok" onClose={() => setOk('')}>{ok}</Notice>}
    {canPunch && <button className={`tp-big ${on ? 'tp-out' : 'primary-btn'}`} disabled={busy || running.loading} onClick={() => void punch()}>
      {busy ? 'Please wait…' : on ? 'Punch out' : 'Punch in'}</button>}
    {canPunch && !on && <p className="muted-text tp-hint">Punch in for the day on the Attendance page first.</p>}
    {q.data && q.data.totals.length > 0 && <div className="tp-totals"><b>Counted time {hm(q.data.totalMinutes)}</b>
      <span>{q.data.totals.map((x) => `${x.person.displayName} ${hm(x.minutes)}`).join(' · ')}</span></div>}
    <h3 className="tp-sub-head">Previous timelogs</h3>
    {q.loading && !q.data ? <Loading /> : !q.data?.logs.length ? <Empty title="No time logged yet" text="Ticket punches by anyone on this ticket appear here." /> :
      q.data.logs.map((l) => <div className="tp-log" key={l.publicId}>
        <div className="tp-log-top"><b>{l.person.displayName}</b>
          <span className={l.timerMinutes ? 'tp-hours' : 'muted-text'}>Hours: {l.timerMinutes != null ? hm(l.timerMinutes) : l.endReason === 'unfinished' ? 'not counted' : '—'}</span></div>
        <div><b>Start:</b> {stamp(l.startedAt)}</div>
        <div><b>Punch-in address:</b> {l.address ?? <span className="muted-text">not available</span>}</div>
        <div><b>End:</b> {l.endedAt ? `${stamp(l.endedAt)}${l.endReason === 'day_punch_out' ? ' (daily punch-out)' : l.endReason === 'unfinished' ? ' (missed punch)' : ''}` : <Badge tone="amber">running</Badge>}</div>
      </div>)}
  </section>;
}

function Reason({ title, onClose, run }: { title: string; onClose: () => void; run: (b: ReasonRequest) => Promise<void> }) {
  const [error, setError] = useState('');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = ReasonRequest.safeParse({ reason: String(new FormData(e.currentTarget).get('reason')) });
    if (!parsed.success) { setError(formError(parsed.error, 'Give a reason')); return; }
    void run(parsed.data);
  }
  return <Modal title={title} onClose={onClose}><form onSubmit={submit}>
    {error && <Notice>{error}</Notice>}
    <div className="form-grid"><label className="span-two">Reason<input id="tk-reason" name="reason" required minLength={3} maxLength={500} autoFocus /></label></div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn">{title}</button></div></form></Modal>;
}

/** Edit a ticket. limited (the on-site supervisor): the requirements only, not the title or priority. */
function EditTicket({ t, limited, onClose, run }: { t: Detail; limited: boolean; onClose: () => void; run: (b: UpdateTicketRequest) => Promise<void> }) {
  const [error, setError] = useState('');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const body: Record<string, unknown> = {};
    if (f.has('title') && text('title') !== t.title) body.title = text('title');
    if (text('description') !== (t.description ?? '')) body.description = text('description') || null;
    if (f.has('priority') && Number(f.get('priority')) !== t.priority) body.priority = Number(f.get('priority'));
    if (text('site') !== (t.site ?? '')) body.site = text('site') || null;
    if (text('due') !== (t.dueDate ?? '')) body.dueDate = text('due') || null;
    const parsed = UpdateTicketRequest.safeParse(body);
    if (!parsed.success) { setError('Change something first'); return; }
    void run(parsed.data);
  }
  return <Modal title="Edit ticket" subtitle={t.number} onClose={onClose}><form onSubmit={submit}>
    {error && <Notice>{error}</Notice>}
    <div className="form-grid">
      {!limited && <label className="span-two">Title<input id="te-title" name="title" required minLength={3} maxLength={150} defaultValue={t.title} /></label>}
      <label className="span-two">Description<input id="te-desc" name="description" maxLength={1000} defaultValue={t.description ?? ''} /></label>
      {!limited && <label>Priority<select id="te-priority" name="priority" defaultValue={t.priority}>{[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{p}{p === 1 ? ' (highest)' : p === 5 ? ' (lowest)' : ''}</option>)}</select></label>}
      <label>Due date<input id="te-due" name="due" type="date" defaultValue={t.dueDate ?? ''} /></label>
      <label className="span-two">Site<input id="te-site" name="site" maxLength={200} defaultValue={t.site ?? ''} /></label>
    </div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn">Save</button></div></form></Modal>;
}

/** One person takes the ticket (the whole assignee list is replaced). */
function AssignTicket({ onClose, run }: { onClose: () => void; run: (b: AssignTicketRequest) => Promise<void> }) {
  const [job, setJob] = useState('');
  const [error, setError] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = AssignTicketRequest.safeParse({ assignees: [{ employmentPublicId: job, isPrimary: true }] });
    if (!parsed.success) { setError('Choose a person and job'); return; }
    void run(parsed.data);
  }
  return <Modal title="Assign ticket" subtitle="The chosen person replaces the current assignees." onClose={onClose}><form onSubmit={submit}>
    {error && <Notice>{error}</Notice>}
    <div className="form-grid"><JobPicker idPrefix="asg" onChange={setJob} /></div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn">Assign</button></div></form></Modal>;
}

function LinkTicket({ t, onClose, run }: { t: Detail; onClose: () => void; run: (b: LinkTicketRequest) => Promise<void> }) {
  const others = useLoad(() => api<TicketSummary[]>(`/tickets?company=${t.company}&limit=200`), [t.company]);
  const [error, setError] = useState('');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = LinkTicketRequest.safeParse({ toTicketPublicId: String(f.get('to')), kind: String(f.get('kind')) });
    if (!parsed.success) { setError('Choose a ticket'); return; }
    void run(parsed.data);
  }
  return <Modal title="Link ticket" subtitle={`Another ticket of ${t.company}.`} onClose={onClose}><form onSubmit={submit}>
    {error && <Notice>{error}</Notice>}{others.error && <Notice>{others.error}</Notice>}
    <div className="form-grid">
      <label className="span-two">Ticket<select id="tl-to" name="to" required defaultValue="">
        <option value="" disabled>{others.loading ? 'Loading…' : 'Choose'}</option>
        {others.data?.filter((o) => o.publicId !== t.publicId).map((o) => <option key={o.publicId} value={o.publicId}>{o.number} · {o.title}</option>)}</select></label>
      <label className="span-two">Kind<select id="tl-kind" name="kind"><option value="follows">Follows (same project)</option><option value="rework_of">Rework of</option></select></label>
    </div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn">Link</button></div></form></Modal>;
}

/** The customer's sign-off: signer and a photo of the signed sheet, sent as a form upload. */
function Signoff({ onClose, run }: { onClose: () => void; run: (b: FormData) => Promise<void> }) {
  const [error, setError] = useState('');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const role = String(f.get('role')).trim();
    const parsed = SignoffRequest.safeParse({ signerName: String(f.get('name')).trim(), signerRole: role });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    const photo = f.get('photo');
    if (!(photo instanceof File) || photo.size === 0) { setError('Attach a photo of the signed sheet'); return; }
    const body = new FormData();
    body.append('signerName', parsed.data.signerName);
    if (parsed.data.signerRole) body.append('signerRole', parsed.data.signerRole);
    body.append('photo', photo);
    void run(body);
  }
  return <Modal title="Customer sign-off" subtitle="Who signed, and a photo of the signed sheet (JPEG or PNG)." onClose={onClose}><form onSubmit={submit}>
    {error && <Notice>{error}</Notice>}
    <div className="form-grid">
      <label>Signer name<input id="so-name" name="name" required minLength={2} maxLength={100} /></label>
      <label>Role <span className="optional">optional</span><input id="so-role" name="role" maxLength={100} /></label>
      <label className="span-two">Photo<input id="so-photo" name="photo" type="file" accept="image/jpeg,image/png" required /></label>
    </div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn">Record sign-off</button></div></form></Modal>;
}

const RECENT_DAYS = 14;
const ATTENDANCE_LABEL: Record<ExternalAttendanceStatus, string> = { present: 'Present', half_day: 'Half day', absent: 'Absent' };
/** 'HH:MM' (24-hour, IST) of an instant, for a time input. */
const clockIst = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const byDayThenName = (a: ExternalAttendance, b: ExternalAttendance) => b.workDate.localeCompare(a.workDate) || a.staff.name.localeCompare(b.staff.name);

/**
 * Outside workers on site (contractor or agency staff): who, from where, which trade, which days, and a photo; under each
 * one their attendance of the last two weeks. The person who added a worker (or a manager) marks it. canMark: the ticket is not cancelled.
 */
function ExternalStaffSection({ ticketId, canAdd, canMark }: { ticketId: string; canAdd: boolean; canMark: boolean }) {
  const list = useLoad(() => api<ExternalStaff[]>(`/tickets/${ticketId}/external-staff`), [ticketId]);
  const attendance = useLoad(() => api<ExternalAttendance[]>(
    `/tickets/${ticketId}/external-staff/attendance?from=${addDays(todayIst(), -(RECENT_DAYS - 1))}&to=${todayIst()}`), [ticketId]);
  const [adding, setAdding] = useState(false);
  const [marking, setMarking] = useState<ExternalStaff | null>(null);
  const [error, setError] = useState('');
  function saved(a: ExternalAttendance) {
    attendance.setData([a, ...(attendance.data ?? []).filter((x) => x.publicId !== a.publicId)].sort(byDayThenName));
    setMarking(null);
  }
  async function end(s: ExternalStaff) {
    setError('');
    const parsed = EndExternalStaffRequest.safeParse({ toDate: todayIst() < s.fromDate ? s.fromDate : todayIst() });
    if (!parsed.success) return;
    try { list.setData(await api<ExternalStaff[]>(`/tickets/${ticketId}/external-staff/${s.publicId}/end`, { method: 'POST', json: parsed.data })); }
    catch (e) { setError(errText(e)); }
  }
  async function photo(s: ExternalStaff) {
    setError('');
    try { await downloadFile(`/tickets/${ticketId}/external-staff/${s.publicId}/photo`, `${s.name}.jpg`); } catch (e) { setError(errText(e)); }
  }
  const rows = list.data ?? [];
  return <section className="tp-card">
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {list.error && <Notice>{list.error}</Notice>}
    {attendance.error && <Notice>{attendance.error}</Notice>}
    {list.loading && !list.data ? <Loading /> : !rows.length ? <p className="muted-text">No outside workers recorded.</p> :
      rows.map((s) => {
        const days = (attendance.data ?? []).filter((a) => a.staff.publicId === s.publicId);
        return <div className="ext-worker" key={s.publicId}>
          <div className="detail-row ext-staff">
            <span><b>{s.name}</b>
              {(s.trade || s.agency || s.phone) && <span>{[s.trade, s.agency, s.phone].filter(Boolean).join(' · ')}</span>}
              <small className="muted-text">{dayLabel(s.fromDate)} – {s.toDate ? dayLabel(s.toDate) : 'on site'} · added by {s.addedBy.displayName}</small></span>
            <span className="chip-row">
              {canMark && s.canRecordAttendance && <button className="text-btn" onClick={() => setMarking(s)}><CalendarCheck size={12} /> Mark attendance</button>}
              {s.hasPhoto && <button className="text-btn" onClick={() => void photo(s)}><Download size={12} /> Photo</button>}
              {canAdd && !s.toDate && <button className="text-btn" onClick={() => void end(s)}>Last day today</button>}
            </span></div>
          {days.length > 0 && <div className="xa-days" aria-label={`${s.name}: attendance of the last ${RECENT_DAYS} days`}>
            {days.map((a) => <div className="xa-day" key={a.publicId}>
              <span className="xa-date">{dayLabel(a.workDate)}</span>
              <Badge tone={DAY_TONE[a.status] ?? 'gray'}>{words(a.status)}</Badge>
              {(a.timeIn || a.timeOut) && <span>{timeIst(a.timeIn)} – {timeIst(a.timeOut)}{a.minutes != null ? ` · ${hm(a.minutes)}` : ''}</span>}
              {a.note && <span className="xa-note">{a.note}</span>}
            </div>)}</div>}
        </div>;
      })}
    {canAdd && <div className="chip-row"><button className="outline-btn" onClick={() => setAdding(true)}><Plus size={13} /> Add external staff</button></div>}
    {adding && <AddExternalStaff onClose={() => setAdding(false)}
      run={async (body) => { list.setData(await api<ExternalStaff[]>(`/tickets/${ticketId}/external-staff`, { method: 'POST', body })); setAdding(false); }} />}
    {marking && <MarkAttendance ticketId={ticketId} staff={marking} recorded={attendance.data ?? []} onClose={() => setMarking(null)} onSaved={saved} />}
  </section>;
}

/**
 * Mark one outside worker's attendance for a day (today by default): present, half day or absent, optional times in
 * IST and a note. A day already marked opens with its values, and saving corrects it.
 */
function MarkAttendance({ ticketId, staff, recorded, onClose, onSaved }: {
  ticketId: string; staff: ExternalStaff; recorded: ExternalAttendance[]; onClose: () => void; onSaved: (a: ExternalAttendance) => void;
}) {
  const today = todayIst();
  const lastDay = staff.toDate && staff.toDate < today ? staff.toDate : today;
  const marked = (d: string) => recorded.find((a) => a.staff.publicId === staff.publicId && a.workDate === d);
  const values = (a?: ExternalAttendance) => ({ status: a?.status ?? 'present' as ExternalAttendanceStatus, timeIn: clockIst(a?.timeIn), timeOut: clockIst(a?.timeOut), note: a?.note ?? '' });
  const id = useRef(uuidv7());            // the same id on a retry of the same day, so it is stored once
  const [date, setDate] = useState(lastDay);
  const [form, setForm] = useState(() => values(marked(lastDay)));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const existing = marked(date);
  function pickDate(d: string) {
    setDate(d); setForm(values(marked(d))); setError('');
    id.current = uuidv7();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const absent = form.status === 'absent';
    const parsed = RecordExternalAttendanceRequest.safeParse({ publicId: id.current, workDate: date, status: form.status,
      timeIn: absent ? undefined : form.timeIn, timeOut: absent ? undefined : form.timeOut, note: form.note.trim() });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setBusy(true); setError('');
    try { onSaved(await api<ExternalAttendance>(`/tickets/${ticketId}/external-staff/${staff.publicId}/attendance`, { method: 'PUT', json: parsed.data })); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  return <Modal title="Mark attendance" subtitle={[staff.name, staff.trade, staff.agency].filter(Boolean).join(' · ')} onClose={onClose}><form onSubmit={submit}>
    {error && <Notice>{error}</Notice>}
    <div className="form-grid">
      <label className="span-two">Day<input id="xa-date" type="date" required value={date} min={staff.fromDate} max={lastDay} onChange={(e) => pickDate(e.target.value)} /></label>
      <div className="span-two xa-status" role="group" aria-label="Attendance">
        {(Object.keys(ATTENDANCE_LABEL) as ExternalAttendanceStatus[]).map((s) =>
          <button key={s} type="button" className={`outline-btn${form.status === s ? ' on' : ''}`} aria-pressed={form.status === s}
            onClick={() => setForm({ ...form, status: s })}>{ATTENDANCE_LABEL[s]}</button>)}</div>
      {form.status !== 'absent' && <>
        <label>Time in <span className="optional">optional</span>
          <input id="xa-in" type="time" value={form.timeIn} onChange={(e) => setForm({ ...form, timeIn: e.target.value })} /></label>
        <label>Time out <span className="optional">optional</span>
          <input id="xa-out" type="time" value={form.timeOut} onChange={(e) => setForm({ ...form, timeOut: e.target.value })} /></label>
      </>}
      <label className="span-two">Note <span className="optional">optional</span>
        <input id="xa-note" maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      {existing && <p className="muted-text span-two">Marked {words(existing.status)} by {(existing.updatedBy ?? existing.recordedBy).displayName}: saving corrects it.</p>}
    </div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
      <button className="primary-btn" disabled={busy}>{existing ? 'Save correction' : 'Save'}</button></div></form></Modal>;
}

function AddExternalStaff({ onClose, run }: { onClose: () => void; run: (b: FormData) => Promise<void> }) {
  const id = useRef(uuidv7());            // the same id on a retry, so the worker is stored once
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const parsed = AddExternalStaffRequest.safeParse({ publicId: id.current, name: text('name'), phone: text('phone'), agency: text('agency'),
      trade: text('trade'), fromDate: text('from'), toDate: text('to') });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    const body = new FormData();
    for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) body.append(k, String(v));
    const p = f.get('photo');
    if (p instanceof File && p.size > 0) body.append('photo', p);
    setBusy(true); setError('');
    try { await run(body); } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }
  return <Modal title="Add external staff" subtitle="A contractor's or agency's worker on this site." onClose={onClose}><form onSubmit={submit}>
    {error && <Notice>{error}</Notice>}
    <div className="form-grid">
      <label>Name<input id="xs-name" name="name" required minLength={2} maxLength={100} autoFocus /></label>
      <label>Phone <span className="optional">optional</span><input id="xs-phone" name="phone" type="tel" maxLength={20} /></label>
      <label>Agency / contractor <span className="optional">optional</span><input id="xs-agency" name="agency" maxLength={100} /></label>
      <label>Trade / work <span className="optional">optional</span><input id="xs-trade" name="trade" maxLength={60} placeholder="Welder, electrician, helper…" /></label>
      <label>First day on site<input id="xs-from" name="from" type="date" required defaultValue={todayIst()} /></label>
      <label>Last day <span className="optional">optional</span><input id="xs-to" name="to" type="date" /></label>
      <label className="span-two">Photo <span className="optional">optional, JPEG or PNG</span><input id="xs-photo" name="photo" type="file" accept="image/jpeg,image/png" /></label>
    </div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn" disabled={busy}>Add</button></div></form></Modal>;
}
