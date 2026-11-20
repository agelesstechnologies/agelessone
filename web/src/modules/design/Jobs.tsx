import { useState, type FormEvent } from 'react';
import { ArrowLeft, Link2, Pencil, Plus, Send } from 'lucide-react';
import {
  CreateDesignJobRequest, CreateDrawingRequest, LinkJobTicketRequest, UpdateDesignJobRequest,
  type Customer, type DesignAccessInfo, type DesignJob, type DesignJobDetail, type DrawingSummary, type TicketSummary,
} from '@ageless/shared';
import { api, errText, formError } from '../../api';
import { dayLabel, hm, todayIst, useApi, uuidv7 } from '../../hooks';
import { openTicket } from '../../pages/Tickets';
import { Badge, Empty, Loading, Modal, Notice, Panel } from '../../ui';
import {
  ACCEPT, DISCIPLINES, disciplineName, DownloadButton, fileSize, goDesign, JOB_STATUS_LABEL, JOB_TONE, PURPOSE_LABEL, refreshDesign, REV_LABEL, REV_TONE, stampIst,
} from './common';
import { IssueTransmittal } from './Transmittals';

const SERVICE_LABEL: Record<string, string> = { design: 'Design', software: 'Software', iot_hardware: 'IoT hardware', cgi: 'CGI' };
const isOpen = (status: string) => status !== 'closed' && status !== 'cancelled';
/** The next step of a job, as a button. */
const NEXT: Record<string, [string, string]> = { received: ['accepted', 'Accept job'], accepted: ['in_design', 'Start design'], in_design: ['closed', 'Close job'] };

// ---------------- the list ----------------

export function JobList({ access }: { access: DesignAccessInfo }) {
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const params = new URLSearchParams({ ...(status && { status }), ...(search && { q: search }) }).toString();
  const list = useApi<DesignJob[]>(`/design/jobs${params ? `?${params}` : ''}`);
  const creatable = access.companies.filter((c) => c.enabled && c.manage);
  const today = todayIst();
  return <Panel title="Design jobs" note="Jobs received from clients. You see every job of your company's design work, or the jobs whose tickets you work on."
    action={creatable.length ? <button className="primary-btn" onClick={() => setCreating(true)}><Plus size={16} /> New job</button> : undefined}>
    <div className="panel-body">
      <form className="filters" onSubmit={(e) => { e.preventDefault(); setSearch(text.trim()); }}>
        <label className="inline-field">Status<select id="dj-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>{Object.entries(JOB_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="inline-field">Search<input id="dj-search" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Number, client reference or scope" /></label>
        <button className="outline-btn">Search</button>
      </form>
      {list.error && <Notice>{list.error}</Notice>}
      {list.loading && !list.data ? <Loading /> : !list.data?.length ? <Empty title="No design jobs" text={creatable.length ? 'Receive the first one with New job.' : 'Jobs you may see appear here.'} /> :
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>JOB</th><th>CLIENT</th><th>STATUS</th><th>DUE</th><th>DRAWINGS</th></tr></thead>
          <tbody>{list.data.map((j) => <tr key={j.publicId} className="link-row" onClick={() => goDesign('jobs', j.publicId)}>
            <td><b>{j.number}</b><small className="sub dz-clip">{j.scope}</small></td>
            <td>{j.customer.name}<small className="sub">{j.clientProjectReference ?? 'No client reference'}</small></td>
            <td><Badge tone={JOB_TONE[j.status]}>{JOB_STATUS_LABEL[j.status]}</Badge>{j.holdReason && <small className="sub">{j.holdReason}</small>}</td>
            <td>{j.dueDate ? <>{dayLabel(j.dueDate)}{isOpen(j.status) && j.dueDate < today && <> <Badge tone="red">Overdue</Badge></>}</> : '—'}</td>
            <td>{j.drawings}</td>
          </tr>)}</tbody></table></div>}
    </div>
    {creating && <NewJob companies={creatable} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); void refreshDesign(); goDesign('jobs', id); }} />}
  </Panel>;
}

// ---------------- new and edit ----------------

interface JobForm { reference: string; site: string; scope: string; requirements: string; dueDate: string; fromName: string; fromContact: string }

function JobFields({ f, set }: { f: JobForm; set: (p: Partial<JobForm>) => void }) {
  return <>
    <label>Client project reference<span className="optional">their name for it</span>
      <input id="dj-reference" value={f.reference} onChange={(e) => set({ reference: e.target.value })} placeholder="e.g. AE PRJ-014 Hungama Dome" maxLength={200} /></label>
    <label>Site<input id="dj-site" value={f.site} onChange={(e) => set({ site: e.target.value })} maxLength={300} /></label>
    <label className="span-two">Scope<textarea id="dj-scope" rows={3} value={f.scope} onChange={(e) => set({ scope: e.target.value })} maxLength={4000} placeholder="What is to be designed" /></label>
    <label className="span-two">Requirements<span className="optional">optional</span>
      <textarea id="dj-req" rows={3} value={f.requirements} onChange={(e) => set({ requirements: e.target.value })} maxLength={8000} /></label>
    <label>Due date<input id="dj-due" type="date" value={f.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /></label>
    <span />
    <label>Received from<input id="dj-from" value={f.fromName} onChange={(e) => set({ fromName: e.target.value })} placeholder="The client's person" maxLength={120} /></label>
    <label>Their contact<span className="optional">phone or email</span><input id="dj-contact" value={f.fromContact} onChange={(e) => set({ fromContact: e.target.value })} maxLength={120} /></label>
  </>;
}

function NewJob({ companies, onClose, onSaved }: { companies: DesignAccessInfo['companies']; onClose: () => void; onSaved: (publicId: string) => void }) {
  const customers = useApi<Customer[]>('/core/customers?status=active');
  const [company, setCompany] = useState(companies[0].company);
  const [customer, setCustomer] = useState('');
  const [f, setF] = useState<JobForm>({ reference: '', site: '', scope: '', requirements: '', dueDate: '', fromName: '', fromContact: '' });
  const [publicId] = useState(uuidv7);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = CreateDesignJobRequest.safeParse({ publicId, company, customerPublicId: customer, clientProjectReference: f.reference, site: f.site, scope: f.scope,
      requirements: f.requirements, dueDate: f.dueDate, receivedFrom: { name: f.fromName, contact: f.fromContact } });
    if (!parsed.success) { setError(customer ? formError(parsed.error) : 'Choose the client'); return; }
    setSaving(true); setError('');
    try { onSaved((await api<DesignJobDetail>('/design/jobs', { method: 'POST', json: parsed.data })).publicId); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="New design job" subtitle="Numbered from the company's series (DJ-025). A job for a group company (AE) makes its tickets billable to it." onClose={onClose} wide>
    <form onSubmit={submit}>
      {(error || customers.error) && <Notice>{error || customers.error}</Notice>}
      <div className="form-grid">
        {companies.length > 1 ? <label>Company<select id="dj-company" value={company} onChange={(e) => setCompany(e.target.value)}>
          {companies.map((c) => <option key={c.company} value={c.company}>{c.name}</option>)}</select></label>
          : <label>Company<input id="dj-company" value={companies[0].name} readOnly /></label>}
        <label>Client<select id="dj-customer" value={customer} onChange={(e) => setCustomer(e.target.value)}>
          <option value="">Choose…</option>{customers.data?.map((c) => <option key={c.publicId} value={c.publicId}>{c.name}{c.company ? ' (group company)' : ''}</option>)}</select></label>
        <JobFields f={f} set={(p) => setF({ ...f, ...p })} />
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Receive job'}</button></div>
    </form>
  </Modal>;
}

function EditJob({ job, onClose, onSaved }: { job: DesignJobDetail; onClose: () => void; onSaved: (j: DesignJobDetail) => void }) {
  const [f, setF] = useState<JobForm>({ reference: job.clientProjectReference ?? '', site: job.site ?? '', scope: job.scope, requirements: job.requirements ?? '',
    dueDate: job.dueDate ?? '', fromName: job.receivedFrom.name, fromContact: job.receivedFrom.contact ?? '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = UpdateDesignJobRequest.safeParse({ clientProjectReference: f.reference, site: f.site, scope: f.scope, requirements: f.requirements,
      dueDate: f.dueDate, receivedFrom: { name: f.fromName, contact: f.fromContact } });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setSaving(true); setError('');
    try { onSaved(await api<DesignJobDetail>(`/design/jobs/${job.publicId}`, { method: 'PATCH', json: parsed.data })); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title={`Edit ${job.number}`} subtitle={`Client: ${job.customer.name} (the client never changes)`} onClose={onClose} wide>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid"><JobFields f={f} set={(p) => setF({ ...f, ...p })} /></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
    </form>
  </Modal>;
}

// ---------------- one job ----------------

type Dialog = 'edit' | 'hold' | 'cancel' | 'attach' | 'ticket' | 'drawing' | 'transmittal' | null;

export function JobPage({ id, access }: { id: string; access: DesignAccessInfo }) {
  const q = useApi<DesignJobDetail>(`/design/jobs/${id}`);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const j = q.data;

  async function setStatus(status: string, reason?: string) {
    setBusy(true); setError(''); setNote('');
    try {
      q.setData(await api<DesignJobDetail>(`/design/jobs/${id}/status`, { method: 'POST', json: { status, ...(reason && { reason }) } }));
      void refreshDesign();
      setDialog(null); setNote(`The job is ${JOB_STATUS_LABEL[status].toLowerCase()}.`);
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  const back = <button className="outline-btn" onClick={() => goDesign('jobs')}><ArrowLeft size={14} /> Jobs</button>;
  if (!j) return <Panel title="Design job" action={back}><div className="panel-body">{q.error ? <Notice>{q.error}</Notice> : <Loading />}</div></Panel>;
  const open = isOpen(j.status);
  const manages = j.actions.manage && open;
  const next = NEXT[j.status];
  const billsTo = access.companies.find((c) => c.company === j.customer.code && c.company !== j.company);
  const issuable = j.drawings.filter((d) => d.current?.status === 'qc_approved');
  const saved = (d: DesignJobDetail, done: string) => { q.setData(d); void refreshDesign(); setDialog(null); setNote(done); };

  return <>
    <Panel title={`${j.number} · ${j.customer.name}`} note={j.clientProjectReference ?? 'No client project reference'}
      action={<div className="row-actions">{back}
        {manages && <button className="outline-btn" onClick={() => setDialog('edit')}><Pencil size={13} /> Edit</button>}
        {manages && next && j.status !== 'on_hold' && <button className="primary-btn" disabled={busy} onClick={() => void setStatus(next[0])}>{next[1]}</button>}
        {j.actions.manage && j.status === 'on_hold' && j.resumeStatus &&
          <button className="primary-btn" disabled={busy} onClick={() => void setStatus(j.resumeStatus!)}>Resume ({JOB_STATUS_LABEL[j.resumeStatus].toLowerCase()})</button>}
        {manages && j.status !== 'on_hold' && <button className="outline-btn" onClick={() => setDialog('hold')}>Hold</button>}
        {manages && <button className="danger-btn" onClick={() => setDialog('cancel')}>Cancel job</button>}
      </div>}>
      <div className="panel-body">
        {error && <Notice onClose={() => setError('')}>{error}</Notice>}
        {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
        <div className="chip-row">
          <span className="ic-chip"><b>Status</b> <Badge tone={JOB_TONE[j.status]}>{JOB_STATUS_LABEL[j.status]}</Badge></span>
          <span className="ic-chip"><b>Hours</b> {hm(j.minutes)} <small>ticket time so far</small></span>
          <span className="ic-chip"><b>Drawings</b> {j.drawings.length}</span>
          {billsTo && <span className="ic-chip"><b>Billing</b> tickets billable to {billsTo.company}</span>}
        </div>
        <div className="kv-grid">
          {j.holdReason && <><span>On hold because</span><b>{j.holdReason}</b></>}
          {j.cancelReason && <><span>Cancelled because</span><b>{j.cancelReason}</b></>}
          <span>Scope</span><b className="dz-pre">{j.scope}</b>
          {j.requirements && <><span>Requirements</span><b className="dz-pre">{j.requirements}</b></>}
          <span>Site</span><b>{j.site ?? '—'}</b>
          <span>Due</span><b>{j.dueDate ? dayLabel(j.dueDate) : '—'}</b>
          <span>Received from</span><b>{j.receivedFrom.name}{j.receivedFrom.contact && ` · ${j.receivedFrom.contact}`}</b>
          <span>Received</span><b>{stampIst(j.createdAt)} by {j.createdBy.displayName}</b>
        </div>
      </div>
    </Panel>

    <Attachments job={j} manages={manages} onError={setError} onAttach={() => setDialog('attach')} />

    <Panel title="Tickets" note={billsTo ? `The work and its time. Linked tickets are billable to ${billsTo.company} (Intercompany).` : 'The work and its time.'}
      action={manages ? <button className="outline-btn" onClick={() => setDialog('ticket')}><Link2 size={13} /> Link ticket</button> : undefined}>
      <div className="panel-body">{!j.tickets.length ? <Empty title="No tickets yet" text="Link the design tickets that do this job; their time is the job's time." /> :
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>TICKET</th><th>STATUS</th><th>HOURS</th><th>BILLING</th><th>LINKED</th></tr></thead>
          <tbody>{j.tickets.map((t) => <tr key={t.publicId} className="link-row" onClick={() => openTicket(t.publicId)}>
            <td><b>{t.number}</b><small className="sub">{t.title}</small></td>
            <td>{t.status.replace(/_/g, ' ')}</td>
            <td>{hm(t.minutes)}</td>
            <td>{t.billableTo ? <Badge tone="green">Billable to {t.billableTo}</Badge> : billsTo ? <Badge tone="gray">Not billable</Badge> : '—'}</td>
            <td>{t.linkedBy.displayName}<small className="sub">{stampIst(t.linkedAt)}</small></td>
          </tr>)}</tbody></table></div>}
      </div>
    </Panel>

    <JobDrawings drawings={j.drawings} canDraw={j.actions.draw && open} onNew={() => setDialog('drawing')} />

    <Panel title="Transmittals" note="QC-approved revisions issued to the client."
      action={manages ? <button className="primary-btn" disabled={!issuable.length} title={issuable.length ? undefined : 'No QC-approved revision to issue'}
        onClick={() => setDialog('transmittal')}><Send size={13} /> Issue transmittal</button> : undefined}>
      <div className="panel-body">{!j.transmittals.length ? <Empty title="Nothing issued yet" text="Transmittals of this job appear here." /> :
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>TRANSMITTAL</th><th>PURPOSE</th><th>REVISIONS</th><th>ISSUED</th></tr></thead>
          <tbody>{j.transmittals.map((t) => <tr key={t.publicId} className="link-row" onClick={() => goDesign('transmittals', t.publicId)}>
            <td><b>{t.number}</b></td><td>{PURPOSE_LABEL[t.purpose]}</td><td>{t.revisions}</td>
            <td>{stampIst(t.issuedAt)}<small className="sub">{t.issuedBy.displayName}</small></td>
          </tr>)}</tbody></table></div>}
      </div>
    </Panel>

    {dialog === 'edit' && <EditJob job={j} onClose={() => setDialog(null)} onSaved={(d) => saved(d, 'Saved.')} />}
    {(dialog === 'hold' || dialog === 'cancel') && <ReasonDialog kind={dialog} job={j} busy={busy} onClose={() => setDialog(null)}
      onSubmit={(reason) => void setStatus(dialog === 'hold' ? 'on_hold' : 'cancelled', reason)} />}
    {dialog === 'attach' && <AttachFile job={j} onClose={() => setDialog(null)} onSaved={(d) => saved(d, 'Attachment added.')} />}
    {dialog === 'ticket' && <LinkTicket job={j} billsTo={billsTo?.company} onClose={() => setDialog(null)} onSaved={(d) => saved(d, 'Ticket linked.')} />}
    {dialog === 'drawing' && <NewDrawing job={j} onClose={() => setDialog(null)} />}
    {dialog === 'transmittal' && <IssueTransmittal job={j} candidates={issuable} onClose={() => setDialog(null)} onIssued={(tid) => goDesign('transmittals', tid)} />}
  </>;
}

function Attachments({ job, manages, onError, onAttach }: { job: DesignJobDetail; manages: boolean; onError: (m: string) => void; onAttach: () => void }) {
  return <Panel title="Attachments" note="What the client sent: brief, survey, reference drawings."
    action={manages ? <button className="outline-btn" onClick={onAttach}><Plus size={13} /> Add</button> : undefined}>
    <div className="panel-body">{!job.attachments.length ? <Empty title="No attachments" /> :
      <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>FILE</th><th>SIZE</th><th>ADDED</th><th /></tr></thead>
        <tbody>{job.attachments.map((a) => <tr key={a.publicId}>
          <td><b>{a.name}</b>{a.description && <small className="sub">{a.description}</small>}</td>
          <td>{fileSize(a.sizeBytes)}</td>
          <td>{a.uploadedBy.displayName}<small className="sub">{stampIst(a.uploadedAt)}</small></td>
          <td><DownloadButton path={`/design/job-attachments/${a.publicId}/file`} name={a.name} label="Download" onError={onError} /></td>
        </tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}

/** The job's drawings by discipline, each with its current revision. */
function JobDrawings({ drawings, canDraw, onNew }: { drawings: DrawingSummary[]; canDraw: boolean; onNew: () => void }) {
  const disciplines = [...new Set(drawings.map((d) => d.discipline))];
  return <Panel title="Drawings" note="By discipline; open one for its revisions."
    action={canDraw ? <button className="primary-btn" onClick={onNew}><Plus size={16} /> New drawing</button> : undefined}>
    <div className="panel-body">{!drawings.length ? <Empty title="No drawings yet" text={canDraw ? 'Add the first with New drawing.' : undefined} /> :
      disciplines.map((disc) => <div key={disc}>
        <div className="mini-h">{disc} · {disciplineName(disc)}</div>
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>DRAWING</th><th>TITLE</th><th>REVISION</th><th>STATUS</th></tr></thead>
          <tbody>{drawings.filter((d) => d.discipline === disc).map((d) => <tr key={d.publicId} className="link-row" onClick={() => goDesign('drawings', d.publicId)}>
            <td><b>{d.number}</b></td><td>{d.title}</td><td>{d.current ? `Rev ${d.current.code}` : '—'}</td>
            <td><Badge tone={REV_TONE[d.current?.status ?? 'no_revision']}>{REV_LABEL[d.current?.status ?? 'no_revision']}</Badge></td>
          </tr>)}</tbody></table></div>
      </div>)}
    </div>
  </Panel>;
}

function ReasonDialog({ kind, job, busy, onClose, onSubmit }: { kind: 'hold' | 'cancel'; job: DesignJobDetail; busy: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const [check, setCheck] = useState('');
  return <Modal title={kind === 'hold' ? `Put ${job.number} on hold?` : `Cancel ${job.number}?`}
    subtitle={kind === 'hold' ? `It goes back to "${JOB_STATUS_LABEL[job.status].toLowerCase()}" when resumed.` : 'A cancelled job no longer changes.'} onClose={onClose}>
    <form onSubmit={(e) => { e.preventDefault(); if (reason.trim().length < 3) { setCheck('Give a reason (at least 3 characters)'); return; } onSubmit(reason.trim()); }}>
      {check && <Notice>{check}</Notice>}
      <div className="form-grid"><label className="span-two">Reason<input id="dj-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Keep it</button>
        <button className={kind === 'hold' ? 'primary-btn' : 'danger-btn'} disabled={busy}>{kind === 'hold' ? 'Hold' : 'Cancel job'}</button></div>
    </form>
  </Modal>;
}

function AttachFile({ job, onClose, onSaved }: { job: DesignJobDetail; onClose: () => void; onSaved: (d: DesignJobDetail) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [publicId] = useState(uuidv7);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) { setError('Choose the file'); return; }
    const body = new FormData();
    body.append('publicId', publicId);
    if (description.trim()) body.append('description', description.trim());
    body.append('file', file);
    setSaving(true); setError('');
    try { onSaved(await api<DesignJobDetail>(`/design/jobs/${job.publicId}/attachments`, { method: 'POST', body })); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Add an attachment" subtitle="PDF, pictures, documents or CAD files the client sent." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label className="span-two">File<input id="dj-file" type="file" accept={ACCEPT.attachment} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <label className="span-two">What it is<span className="optional">optional</span><input id="dj-file-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} placeholder="e.g. Site survey" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Uploading…' : 'Add'}</button></div>
    </form>
  </Modal>;
}

function LinkTicket({ job, billsTo, onClose, onSaved }: { job: DesignJobDetail; billsTo?: string; onClose: () => void; onSaved: (d: DesignJobDetail) => void }) {
  const tickets = useApi<TicketSummary[]>(`/tickets?company=${job.company}&limit=200`);
  const linked = new Set(job.tickets.map((t) => t.publicId));
  const [filter, setFilter] = useState('');
  const [pick, setPick] = useState('');
  const [serviceType, setServiceType] = useState('design');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const needle = filter.trim().toLowerCase();
  const options = (tickets.data ?? []).filter((t) => t.status !== 'cancelled' && !linked.has(t.publicId)
    && (!needle || `${t.number} ${t.title} ${t.type.name}`.toLowerCase().includes(needle))).slice(0, 50);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = LinkJobTicketRequest.safeParse({ ticketPublicId: pick, serviceType });
    if (!parsed.success) { setError('Choose a ticket'); return; }
    setSaving(true); setError('');
    try { onSaved(await api<DesignJobDetail>(`/design/jobs/${job.publicId}/tickets`, { method: 'POST', json: parsed.data })); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Link a ticket" subtitle={`A ${job.company} ticket that works on ${job.number}; once linked it stays with this job.${billsTo ? ` Its time becomes billable to ${billsTo}.` : ''}`} onClose={onClose} wide>
    <form onSubmit={submit}>
      {(error || tickets.error) && <Notice>{error || tickets.error}</Notice>}
      <div className="form-grid">
        <label className="span-two">Find<input id="dj-ticket-find" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Ticket number, title or type" autoFocus /></label>
        {billsTo && <label className="span-two">Billed to {billsTo} as<select id="dj-service" value={serviceType} onChange={(e) => setServiceType(e.target.value)}>
          {Object.entries(SERVICE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
      </div>
      {tickets.loading && !tickets.data ? <Loading /> : !options.length ? <Empty title="No tickets to link" text="Tickets of this company you can see, not cancelled and not linked yet." /> :
        <div className="dz-pick">{options.map((t) => <label key={t.publicId} className={`dz-pick-row ${pick === t.publicId ? 'on' : ''}`}>
          <input type="radio" name="dj-ticket" checked={pick === t.publicId} onChange={() => setPick(t.publicId)} />
          <span><b>{t.number}</b> {t.title}<small className="sub">{t.type.name} · {t.status.replace(/_/g, ' ')} · {t.department.name}</small></span>
        </label>)}</div>}
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving || !pick}>{saving ? 'Linking…' : 'Link ticket'}</button></div>
    </form>
  </Modal>;
}

function NewDrawing({ job, onClose }: { job: DesignJobDetail; onClose: () => void }) {
  const [discipline, setDiscipline] = useState(DISCIPLINES[0].code);
  const [title, setTitle] = useState('');
  const [publicId] = useState(uuidv7);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = CreateDrawingRequest.safeParse({ publicId, discipline, title });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setSaving(true); setError('');
    try {
      const created = await api<{ publicId: string }>(`/design/jobs/${job.publicId}/drawings`, { method: 'POST', json: parsed.data });
      void refreshDesign();
      goDesign('drawings', created.publicId);
    }
    catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title="New drawing" subtitle={`Numbered ${job.number}-<discipline>-<seq>, e.g. ${job.number}-${discipline}-001. Its first revision comes next.`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Discipline<select id="dd-discipline" value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
          {DISCIPLINES.map((d) => <option key={d.code} value={d.code}>{d.code} · {d.name}</option>)}</select></label>
        <label>Title<input id="dd-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Base frame" autoFocus /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Add drawing'}</button></div>
    </form>
  </Modal>;
}
