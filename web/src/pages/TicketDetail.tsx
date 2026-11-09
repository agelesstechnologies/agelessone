import { useRef, useState, type FormEvent } from 'react';
import { Download, Plus } from 'lucide-react';
import {
  AddExternalStaffRequest, AssignTicketRequest, ChecklistResultRequest, EndExternalStaffRequest, LinkTicketRequest, ReasonRequest, SignoffRequest, UpdateTicketRequest,
  type ChecklistResult, type ExternalStaff, type TicketDetail as Detail, type TicketSummary,
} from '@ageless/shared';
import { api, downloadFile, errText } from '../api';
import { useAuth } from '../auth';
import { dayLabel, todayIst, useLoad, uuidv7 } from '../hooks';
import JobPicker from '../JobPicker';
import { TICKETS } from '../permissions';
import { TicketUpdates } from './TicketTime';
import { Badge, Loading, Modal, Notice, type Tone } from '../ui';

export const STATUS_TONE: Record<string, Tone> = { open: 'gray', assigned: 'blue', in_progress: 'amber', on_hold: 'red', completed: 'green', cancelled: 'gray' };
export const statusLabel = (s: string) => s.replace(/_/g, ' ');
const stamp = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

type Dialog = 'edit' | 'assign' | 'link' | 'signoff' | 'updates' | { reason: 'hold' | 'cancel' | 'reopen' | 'reassign-request' } | null;
const REASON_TITLE = { hold: 'Put on hold', cancel: 'Cancel ticket', reopen: 'Reopen ticket', 'reassign-request': 'Ask to be reassigned' } as const;

/** One ticket with every action the signed-in person may take. The API answers each action with the updated ticket. */
export default function TicketDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, me } = useAuth();
  const q = useLoad(() => api<Detail>(`/tickets/${id}`), [id]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const t = q.data;
  const manage = can(TICKETS.manage);
  /** the on-site supervisor of this ticket: requirements, external staff, hold and resume (not create, assign or cancel) */
  const siteSup = !manage && can(TICKETS.site) && !!t && t.supervisor.publicId === me?.person.publicId;
  const runSite = manage || siteSup;
  const work = can(TICKETS.work) || runSite;
  const live = t && t.status !== 'completed' && t.status !== 'cancelled';

  async function act(fn: () => Promise<Detail | void>) {
    setBusy(true); setError('');
    try { const r = await fn(); if (r) q.setData(r); onChanged(); setDialog(null); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }
  const post = (action: string, json: unknown = {}) => act(() => api<Detail>(`/tickets/${id}/${action}`, { method: 'POST', json }));
  const file = (attachmentId: string) => act(async () => { await downloadFile(`/tickets/${id}/attachments/${attachmentId}`, 'attachment'); });

  async function upload(kind: 'photo' | 'file', f: File | undefined) {
    if (!f) return;
    const body = new FormData(); body.append('kind', kind); body.append('file', f);
    await act(() => api<Detail>(`/tickets/${id}/attachments`, { method: 'POST', body }));
  }

  return <Modal title={t ? `${t.number} · ${t.title}` : 'Ticket'} subtitle={t ? `${t.type.name} · ${t.company} · ${t.department.name}` : undefined} onClose={onClose}>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {q.error && <Notice>{q.error}</Notice>}
    {!t ? <Loading /> : <>
      <div className="chip-row">
        <Badge tone={STATUS_TONE[t.status] ?? 'gray'}>{statusLabel(t.status)}</Badge>
        <Badge tone={t.priority <= 2 ? 'red' : t.priority === 3 ? 'amber' : 'gray'}>Priority {t.priority}</Badge>
        {t.overdue && <Badge tone="red">overdue</Badge>}
      </div>
      {t.warnings.map((w, i) => <Notice key={i}>{w.message}</Notice>)}
      <div className="detail-section">
        <div className="detail-row"><span>Scheduled</span><b>{stamp(t.scheduledAt)}</b></div>
        <div className="detail-row"><span>Due</span><b>{t.dueDate ? dayLabel(t.dueDate) : '—'}</b></div>
        {(t.site || !('site' in t.details)) && <div className="detail-row"><span>Site</span><b>{t.site ?? '—'}</b></div>}
        <div className="detail-row"><span>Supervisor</span><b>{t.supervisor.displayName}</b></div>
        {t.description && <div className="detail-row"><span>Description</span><b>{t.description}</b></div>}
        {t.holdReason && t.status === 'on_hold' && <div className="detail-row"><span>On hold because</span><b>{t.holdReason}</b></div>}
        {t.cancelReason && t.status === 'cancelled' && <div className="detail-row"><span>Cancelled because</span><b>{t.cancelReason}</b></div>}
        {Object.entries(t.details).map(([k, v]) => <div className="detail-row" key={k}>
          <span>{t.typeRules.fields.find((f) => f.key === k)?.label ?? k}</span><b>{String(v)}</b></div>)}
      </div>

      <div className="detail-section"><h3>Assignees</h3>
        {t.assignees.length ? t.assignees.map((a) => <div className="detail-row" key={a.employmentPublicId}>
          <span>{a.person.displayName}{a.isPrimary ? ' · primary' : ''}</span><b>{a.employeeCode}</b></div>) : <p className="muted-text">Nobody assigned yet.</p>}
      </div>

      {t.checklist.length > 0 && <div className="detail-section"><h3>Checklist</h3>
        {t.checklist.map((c) => <div className="detail-row" key={c.item}>
          <span>{c.item}{c.note ? ` — ${c.note}` : ''}</span>
          <span className="chip-row">{c.result ? <Badge tone={c.result === 'pass' ? 'green' : c.result === 'fail' ? 'red' : 'gray'}>{c.result}</Badge> : <Badge tone="amber">not answered</Badge>}
            {work && live && (['pass', 'fail', 'na'] as ChecklistResult[]).map((r) =>
              <button key={r} className="text-btn" disabled={busy} onClick={() => {
                const parsed = ChecklistResultRequest.safeParse({ item: c.item, result: r });
                if (parsed.success) void post('checklist', parsed.data);
              }}>{r}</button>)}</span></div>)}
      </div>}

      <div className="detail-section"><h3>Files and sign-off</h3>
        {t.attachments.map((a) => <div className="detail-row" key={a.publicId}><span>{a.kind} · {a.fileType} · {a.uploadedBy.displayName}</span>
          <button className="text-btn" onClick={() => void file(a.publicId)}><Download size={12} /> Open</button></div>)}
        {t.signoffs.map((s) => <div className="detail-row" key={s.publicId}><span>Signed off by {s.signerName}{s.signerRole ? `, ${s.signerRole}` : ''}</span><b>{stamp(s.signedAt)}</b></div>)}
        {t.headApproval && <div className="detail-row"><span>Head approval</span><b>{t.headApproval.by.displayName} · {stamp(t.headApproval.at)}</b></div>}
        {!t.attachments.length && !t.signoffs.length && !t.headApproval && <p className="muted-text">Nothing attached yet.</p>}
        {work && live && <div className="chip-row">
          <label className="outline-btn" style={{ cursor: 'pointer' }}><Plus size={13} /> Photo
            <input type="file" accept="image/jpeg,image/png" hidden onChange={(e) => { const i = e.currentTarget; void upload('photo', i.files?.[0]).then(() => { i.value = ''; }); }} /></label>
          <label className="outline-btn" style={{ cursor: 'pointer' }}><Plus size={13} /> File
            <input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => { const i = e.currentTarget; void upload('file', i.files?.[0]).then(() => { i.value = ''; }); }} /></label>
          <button className="outline-btn" onClick={() => setDialog('signoff')}>Customer sign-off</button></div>}
      </div>

      <ExternalStaffSection ticketId={id} canAdd={runSite && !!live} />

      {t.links.length > 0 && <div className="detail-section"><h3>Linked tickets</h3>
        {t.links.map((l) => <div className="detail-row" key={`${l.direction}-${l.ticket.publicId}`}>
          <span>{l.direction === 'to' ? l.kind.replace('_', ' ') : `${l.kind.replace('_', ' ')} (from)`}</span><b>{l.ticket.number} · {l.ticket.title} · {statusLabel(l.ticket.status)}</b></div>)}</div>}

      {t.reassignRequests.length > 0 && <div className="detail-section"><h3>Reassignment requests</h3>
        {t.reassignRequests.map((r) => <div className="detail-row" key={r.publicId}><span>{r.requestedBy.displayName}: {r.reason}</span><Badge tone={r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'amber'}>{r.status}</Badge></div>)}</div>}

      {t.missingForCompletion.length > 0 && live && <Notice>To complete: {t.missingForCompletion.join(', ')}.</Notice>}

      <div className="modal-foot" style={{ flexWrap: 'wrap' }}>
        <button className="outline-btn" onClick={() => setDialog('updates')}>Daily updates</button>
        {live && runSite && <button className="outline-btn" onClick={() => setDialog('edit')}>{siteSup ? 'Edit requirements' : 'Edit'}</button>}
        {live && manage && <button className="outline-btn" onClick={() => setDialog('assign')}>Assign</button>}
        {live && manage && <button className="outline-btn" onClick={() => setDialog('link')}>Link ticket</button>}
        {live && manage && t.typeRules.completionRules.head_approval_required && !t.headApproval && <button className="outline-btn" disabled={busy} onClick={() => void post('head-approval')}>Head approval</button>}
        {live && work && (t.status === 'assigned' || t.status === 'open') && <button className="outline-btn" disabled={busy} onClick={() => void post('start')}>Start work</button>}
        {live && runSite && t.status === 'on_hold' && <button className="outline-btn" disabled={busy} onClick={() => void post('resume')}>Resume</button>}
        {live && runSite && t.status === 'in_progress' && <button className="outline-btn" onClick={() => setDialog({ reason: 'hold' })}>Hold</button>}
        {live && can(TICKETS.work) && t.assignees.length > 0 && <button className="outline-btn" onClick={() => setDialog({ reason: 'reassign-request' })}>Ask to be reassigned</button>}
        {live && manage && <button className="outline-btn" onClick={() => setDialog({ reason: 'cancel' })}>Cancel ticket</button>}
        {t.status === 'completed' && manage && <button className="outline-btn" onClick={() => setDialog({ reason: 'reopen' })}>Reopen</button>}
        {live && work && t.status !== 'on_hold' && <button className="primary-btn" disabled={busy} onClick={() => void post('complete')}>Complete</button>}
      </div>

      <div className="detail-section"><h3>Timeline</h3>
        {t.timeline.map((e, i) => <div className="detail-row" key={i}><span>{e.action.replace(/_/g, ' ')}{e.actor ? ` · ${e.actor.displayName}` : ''}</span><b>{stamp(e.at)}</b></div>)}</div>
    </>}

    {t && dialog === 'edit' && <EditTicket t={t} limited={siteSup} onClose={() => setDialog(null)} run={(body) => act(() => api<Detail>(`/tickets/${id}`, { method: 'PATCH', json: body }))} />}
    {t && dialog === 'updates' && <TicketUpdates ticketId={id} label={t.number} onClose={() => setDialog(null)} />}
    {t && dialog === 'assign' && <AssignTicket onClose={() => setDialog(null)} run={(body) => act(() => api<Detail>(`/tickets/${id}/assignees`, { method: 'PUT', json: body }))} />}
    {t && dialog === 'link' && <LinkTicket t={t} onClose={() => setDialog(null)} run={(body) => act(() => api<Detail>(`/tickets/${id}/links`, { method: 'POST', json: body }))} />}
    {t && dialog === 'signoff' && <Signoff onClose={() => setDialog(null)} run={(body) => act(() => api<Detail>(`/tickets/${id}/signoffs`, { method: 'POST', body }))} />}
    {t && dialog && typeof dialog === 'object' && <Reason title={REASON_TITLE[dialog.reason]} onClose={() => setDialog(null)}
      run={(body) => post(dialog.reason === 'reassign-request' ? 'reassign-requests' : dialog.reason, body)} />}
  </Modal>;
}

function Reason({ title, onClose, run }: { title: string; onClose: () => void; run: (b: ReasonRequest) => Promise<void> }) {
  const [error, setError] = useState('');
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = ReasonRequest.safeParse({ reason: String(new FormData(e.currentTarget).get('reason')) });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Give a reason'); return; }
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
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
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

/** Outside workers on site (contractor or agency staff): who, from where, which trade, which days, and a photo. */
function ExternalStaffSection({ ticketId, canAdd }: { ticketId: string; canAdd: boolean }) {
  const list = useLoad(() => api<ExternalStaff[]>(`/tickets/${ticketId}/external-staff`), [ticketId]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
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
  return <div className="detail-section"><h3>External staff</h3>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {list.error && <Notice>{list.error}</Notice>}
    {list.loading && !list.data ? <Loading /> : !rows.length ? <p className="muted-text">No outside workers recorded.</p> :
      rows.map((s) => <div className="detail-row ext-staff" key={s.publicId}>
        <span><b>{s.name}</b>
          {(s.trade || s.agency || s.phone) && <span>{[s.trade, s.agency, s.phone].filter(Boolean).join(' · ')}</span>}
          <small className="muted-text">{dayLabel(s.fromDate)} – {s.toDate ? dayLabel(s.toDate) : 'on site'} · added by {s.addedBy.displayName}</small></span>
        <span className="chip-row">
          {s.hasPhoto && <button className="text-btn" onClick={() => void photo(s)}><Download size={12} /> Photo</button>}
          {canAdd && !s.toDate && <button className="text-btn" onClick={() => void end(s)}>Last day today</button>}
        </span></div>)}
    {canAdd && <div className="chip-row"><button className="outline-btn" onClick={() => setAdding(true)}><Plus size={13} /> Add external staff</button></div>}
    {adding && <AddExternalStaff onClose={() => setAdding(false)}
      run={async (body) => { list.setData(await api<ExternalStaff[]>(`/tickets/${ticketId}/external-staff`, { method: 'POST', body })); setAdding(false); }} />}
  </div>;
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
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
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
