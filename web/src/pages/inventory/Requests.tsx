import { useEffect, useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import {
  ApprovePartRequest, CancelPartRequest, CreateGrantRequest, CreatePartRequest, PartRequestStatus, RejectPartRequest,
  type Grant, type PartRequest, type PartRequestList, type RequestItem,
} from '@ageless/shared';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { addDays, dayLabel, todayIst, useLoad, uuidv7 } from '../../hooks';
import { PersonPicker } from '../../JobPicker';
import { INVENTORY, TICKETS } from '../../permissions';
import { Badge, CompanyFilter, Empty, FieldError, Loading, Modal, Notice, PageHead, Panel, Tabs } from '../../ui';
import { openDocument } from './Documents';
import { IssueRequestForm } from './DocumentForms';
import { CompanySelect, LocationSelect, money, Pager, qty, REQUEST_TONE, TicketSelect, USABLE, useHomeCompany, useLocations, useSend } from './common';

const PAGE_SIZE = 50;
type TicketRef = { publicId: string; number: string; title: string };

/**
 * Part requests: a ticket's people ask the store for parts; the store in-charge approves (and the ticket's department
 * head too above the company's limit); approval reserves the stock until it is issued. Requesters see their own, the store
 * its companies', a department head their departments' tickets with the cost. Store in-charges also give people of the
 * other company access to request for one ticket.
 */
export default function Requests() {
  const { can } = useAuth();
  const grants = can(INVENTORY.requestsApprove);
  const [tab, setTab] = useState<'requests' | 'grants'>('requests');
  return <>
    <PageHead eyebrow="INVENTORY • PART REQUESTS" title="Part requests" subtitle="Parts asked for on tickets: approval, reserved stock and what has been issued." />
    {grants && <Tabs tabs={[{ key: 'requests', label: 'Requests' }, { key: 'grants', label: 'Cross-company access' }]} value={tab} onChange={setTab} />}
    {tab === 'grants' && grants ? <Grants /> : <><MyAccess /><RequestList /></>}
  </>;
}

/** Your cross-company access: tickets of another company you may request parts for, with "Request parts". */
function MyAccess() {
  const q = useLoad(() => api<Grant[]>('/inventory/grants/mine'));
  const [asking, setAsking] = useState<TicketRef | null>(null);
  const [done, setDone] = useState('');
  const active = (q.data ?? []).filter((g) => g.active);
  if (!active.length) return null;
  return <Panel title="Your access to other companies' tickets" note="You may request parts for these tickets until the date shown. You do not see values.">
    <div className="panel-body">
      {done && <Notice tone="ok" onClose={() => setDone('')}>{done}</Notice>}
      <ul className="plain-list">{active.map((g) => <li key={g.publicId}><span><b>{g.ticket.number}</b> · {g.ticket.title}<small className="sub">{g.company} · until {dayLabel(g.validUntil)}</small></span>
        <button className="outline-btn" onClick={() => setAsking(g.ticket)}><Plus size={13} /> Request parts</button></li>)}</ul>
    </div>
    {asking && <NewRequestForm ticket={asking} onClose={() => setAsking(null)} onSaved={(r) => { setAsking(null); setDone(`${r.number} sent to the store.`); }} />}
  </Panel>;
}

const approvalsText = (r: PartRequest) => [
  r.storeApprovedBy ? `Store: ${r.storeApprovedBy.displayName}` : 'Store: waiting',
  ...(r.needsHeadApproval ? [r.headApprovedBy ? `Head: ${r.headApprovedBy.displayName}` : 'Head: waiting'] : []),
];

function RequestList() {
  const { can } = useAuth();
  const decides = can(INVENTORY.requestsApprove) || can(INVENTORY.departmentView);
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState(decides ? 'pending' : '');
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<PartRequest | null>(null);
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), ...(company && { company }), ...(status && { status }), ...(mine && { mine: 'true' }) });
  const q = useLoad(() => api<PartRequestList>(`/inventory/requests?${params}`), [params.toString()]);
  const filter = (set: (v: string) => void) => (v: string) => { set(v); setPage(1); };
  const changed = (r: PartRequest) => { setOpen(r); q.reload(); };

  return <Panel title="Requests" note={decides ? 'Pending requests wait for you; a department head sees the tickets of departments they head, with the cost.' : 'The parts you asked for.'}>
    <div className="panel-body">
      <div className="filters">
        <CompanyFilter id="rq-company" value={company} onChange={filter(setCompany)} />
        <label className="inline-field">Status<select id="rq-status" className="input" value={status} onChange={(e) => filter(setStatus)(e.target.value)}>
          <option value="">All</option>{PartRequestStatus.options.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
        {decides && <label className="inline-field check-row"><input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); setPage(1); }} /> Only mine</label>}
      </div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.items.length ? <Empty title="No part requests" text={status === 'pending' ? 'Nothing is waiting.' : undefined} /> : <>
        <div className="table-wrap"><table><thead><tr><th>NUMBER</th><th>TICKET</th><th>ASKED BY</th><th>PARTS</th><th>STATUS</th><th>APPROVALS</th><th className="num">ESTIMATE</th></tr></thead>
          <tbody>{q.data.items.map((r) => <tr key={r.publicId} className="link-row" onClick={() => setOpen(r)}>
            <td><b>{r.number}</b><small className="sub">{r.company} · {dayLabel(r.createdAt.slice(0, 10))}</small></td>
            <td>{r.ticket.number}<small className="sub">{r.ticket.title}</small></td>
            <td>{r.requestedBy.displayName}{r.crossCompany && <small className="sub">other company</small>}</td>
            <td>{r.lines.slice(0, 2).map((l) => `${l.item.code} × ${qty(l.quantity)}`).join(', ')}{r.lines.length > 2 && ` +${r.lines.length - 2}`}</td>
            <td><Badge tone={REQUEST_TONE[r.status]}>{r.status}</Badge>{r.reserveUntil && r.status === 'approved' && <small className="sub">reserved until {dayLabel(r.reserveUntil)}</small>}</td>
            <td>{approvalsText(r).map((t) => <small key={t} className="sub">{t}</small>)}</td>
            <td className="num">{money(r.estimatedValueMinor)}</td></tr>)}</tbody></table></div>
        <Pager page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} /></>}
    </div>
    {open && <RequestDetail request={open} onClose={() => setOpen(null)} onChanged={changed} />}
  </Panel>;
}

/** One request: lines with reserved and issued quantities, where each is reserved, approvals, and what you may do now. */
export function RequestDetail({ request, onClose, onChanged }: { request: PartRequest; onClose: () => void; onChanged: (r: PartRequest) => void }) {
  const { can } = useAuth();
  const [r, setR] = useState(request);
  const [step, setStep] = useState<'view' | 'approve' | 'reject' | 'cancel' | 'issue'>('view');
  const [note, setNote] = useState('');
  const issues = can(INVENTORY.stockPost) && r.status === 'approved' && r.lines.some((l) => l.quantity > l.issued);
  const seesTickets = can(TICKETS.view) || can(TICKETS.work) || can(TICKETS.manage);
  const changed = (next: PartRequest, done: string) => { setR(next); setStep('view'); setNote(done); onChanged(next); };

  if (step === 'approve') return <ApproveForm r={r} onClose={() => setStep('view')} onSaved={(n) => changed(n, n.status === 'approved' ? 'Approved: the stock is reserved.' : 'Approved. Waiting for the other approval.')} />;
  if (step === 'reject' || step === 'cancel') return <ReasonForm r={r} kind={step} onClose={() => setStep('view')} onSaved={(n) => changed(n, step === 'reject' ? 'Rejected.' : 'Cancelled: any reserved stock is free again.')} />;
  if (step === 'issue') return <IssueRequestForm request={r} onClose={() => setStep('view')} onSaved={(d) => { onClose(); openDocument(d.publicId); }} />;

  return <Modal title={`${r.number} · ${r.status}`} subtitle={`${r.ticket.number} · ${r.ticket.title} · asked by ${r.requestedBy.displayName}${r.crossCompany ? ' (other company)' : ''}`} onClose={onClose} wide>
    {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
    {r.note && <p className="muted-text">“{r.note}”</p>}
    <div className="table-wrap"><table><thead><tr><th>#</th><th>ITEM</th><th className="num">ASKED</th><th className="num">RESERVED</th><th className="num">ISSUED</th><th>RESERVED IN</th><th className="num">ESTIMATE</th></tr></thead>
      <tbody>{r.lines.map((l) => <tr key={l.lineNo}><td>{l.lineNo}</td><td><b>{l.item.code}</b> {l.item.name}</td>
        <td className="num qty">{qty(l.quantity)} {l.unit.code}</td><td className="num qty">{l.reserved ? qty(l.reserved) : '—'}</td><td className="num qty">{l.issued ? qty(l.issued) : '—'}</td>
        <td>{l.reservations.length ? l.reservations.map((x, i) => <small key={i} className="sub">{qty(x.quantity)} in {x.location.code}{x.batchNo ? ` · batch ${x.batchNo}` : ''}</small>)
          : l.location ? <small className="sub">{l.location.code}</small> : '—'}</td>
        <td className="num">{money(l.estimatedValueMinor)}</td></tr>)}</tbody></table></div>
    <div className="detail-section">
      {approvalsText(r).map((t) => <div key={t} className="detail-row"><span>{t.split(':')[0]}</span><b>{t.split(': ')[1]}</b></div>)}
      {r.reserveUntil && <div className="detail-row"><span>Reserved until</span><b>{dayLabel(r.reserveUntil)}</b></div>}
      {r.decidedBy && <div className="detail-row"><span>{r.status === 'rejected' ? 'Rejected by' : 'Cancelled by'}</span><b>{r.decidedBy.displayName}{r.decisionReason ? `: ${r.decisionReason}` : ''}</b></div>}
      {r.estimatedValueMinor != null && <div className="detail-row"><span>Estimate (at the average cost when asked)</span><b>{money(r.estimatedValueMinor)}</b></div>}
    </div>
    <div className="modal-foot">
      {seesTickets && <a className="outline-btn" href={`#tickets/${r.ticket.publicId}`} onClick={onClose}>Open ticket</a>}
      {r.canCancel && <button className="outline-btn" onClick={() => setStep('cancel')}>Cancel request</button>}
      {r.canApprove && r.status === 'pending' && <button className="outline-btn" onClick={() => setStep('reject')}>Reject</button>}
      {r.canApprove && <button className="primary-btn" onClick={() => setStep('approve')}>Approve</button>}
      {issues && <button className="primary-btn" onClick={() => setStep('issue')}>Issue parts</button>}
    </div>
  </Modal>;
}

/**
 * Approve: as the store in-charge (optionally choosing where each line is reserved from) and/or the ticket's department
 * head. Once every approval is in, the stock is reserved until the date (default: the company's reserve days).
 */
function ApproveForm({ r, onClose, onSaved }: { r: PartRequest; onClose: () => void; onSaved: (r: PartRequest) => void }) {
  const asStore = useAuth().can(INVENTORY.requestsApprove) && !r.storeApprovedBy;
  const locations = useLocations(asStore ? r.company : '');
  const [where, setWhere] = useState<Record<number, string>>({});
  const [until, setUntil] = useState('');
  const s = useSend();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const chosen = Object.entries(where).filter(([, v]) => v).map(([lineNo, locationPublicId]) => ({ lineNo: Number(lineNo), locationPublicId }));
    const parsed = ApprovePartRequest.safeParse({ ...(chosen.length && { locations: chosen }), ...(until && { reserveUntil: until }) });
    if (!parsed.success) { s.invalid(parsed.error); return; }
    const next = await s.send(() => api<PartRequest>(`/inventory/requests/${r.publicId}/approve`, { method: 'POST', json: parsed.data }));
    if (next) onSaved(next);
  }
  return <Modal title={`Approve ${r.number}`} subtitle={asStore ? 'Choose where to reserve each line from, or leave it: the item’s default location, then the one with the most free stock.'
    : 'As the department head of the ticket.'} onClose={onClose}>
    <form onSubmit={submit}>
      {s.error && <Notice>{s.error}</Notice>}
      <div className="form-grid">
        {asStore && r.lines.map((l) => <label key={l.lineNo} className="span-two">{l.item.code} · {qty(l.quantity)} {l.unit.code}
          <LocationSelect id={`ap-loc-${l.lineNo}`} locations={locations.data ?? []} types={USABLE} value={where[l.lineNo] ?? ''}
            onChange={(v) => setWhere({ ...where, [l.lineNo]: v })} empty="Default" /></label>)}
        <label className="span-two">Reserve until <span className="optional">optional</span><input id="ap-until" type="date" min={todayIst()} value={until}
          onChange={(e) => setUntil(e.target.value)} /><FieldError name="reserveUntil" errors={s.fields} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Back</button>
        <button className="primary-btn" disabled={s.busy}>{s.busy ? 'Approving…' : 'Approve'}</button></div>
    </form>
  </Modal>;
}

function ReasonForm({ r, kind, onClose, onSaved }: { r: PartRequest; kind: 'reject' | 'cancel'; onClose: () => void; onSaved: (r: PartRequest) => void }) {
  const [reason, setReason] = useState('');
  const s = useSend();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = kind === 'reject' ? RejectPartRequest.safeParse({ reason }) : CancelPartRequest.safeParse({ reason: reason.trim() || undefined });
    if (!parsed.success) { s.invalid(parsed.error); return; }
    const next = await s.send(() => api<PartRequest>(`/inventory/requests/${r.publicId}/${kind}`, { method: 'POST', json: parsed.data }));
    if (next) onSaved(next);
  }
  return <Modal title={`${kind === 'reject' ? 'Reject' : 'Cancel'} ${r.number}`} subtitle={kind === 'cancel' ? 'Reserved stock is released.' : undefined} onClose={onClose}>
    <form onSubmit={submit}>
      {s.error && <Notice>{s.error}</Notice>}
      <div className="form-grid"><label className="span-two">Reason{kind === 'cancel' && <span className="optional">optional</span>}
        <input id="rr-reason" value={reason} required={kind === 'reject'} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} /><FieldError name="reason" errors={s.fields} /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Back</button>
        <button className="primary-btn" disabled={s.busy}>{kind === 'reject' ? 'Reject' : 'Cancel request'}</button></div>
    </form>
  </Modal>;
}

/** Search what may be asked for on a ticket (code or name, 2+ letters); picking one adds it and clears the box. */
function RequestItemSearch({ ticketPublicId, onAdd }: { ticketPublicId: string; onAdd: (i: RequestItem) => void }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<RequestItem[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (text.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => {
      api<RequestItem[]>(`/inventory/requests/items?ticket=${ticketPublicId}&search=${encodeURIComponent(text.trim())}&limit=10`)
        .then((r) => { setFound(r); setError(''); }).catch((e) => setError(errText(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [text, ticketPublicId]);
  return <label className="span-two person-search">Add a part
    <span className="person-search-box"><input id="nr-search" className="input" value={text} placeholder="Type a part code or name" autoComplete="off" onChange={(e) => setText(e.target.value)} /></span>
    {text.trim().length >= 2 && <ul className="person-results" role="listbox">
      {found.length ? found.map((i) => <li key={i.publicId} role="option" aria-selected="false" onMouseDown={(e) => { e.preventDefault(); onAdd(i); setText(''); }}>
        <b>{i.code} · {i.name}</b><small>{i.unit.code} · {i.inStock ? 'in stock' : 'not in stock now'}</small></li>) : <li className="none">No part found</li>}
    </ul>}
    {error && <small className="field-error">{error}</small>}
  </label>;
}

/** Ask the store for parts for a ticket. The store in-charge approves; you see no values. */
export function NewRequestForm({ ticket, onClose, onSaved }: { ticket: TicketRef; onClose: () => void; onSaved: (r: PartRequest) => void }) {
  const [id] = useState(uuidv7);
  const [lines, setLines] = useState<{ item: RequestItem; quantity: string }[]>([]);
  const [note, setNote] = useState('');
  const s = useSend();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = CreatePartRequest.safeParse({ publicId: id, ticketPublicId: ticket.publicId, note: note.trim() || undefined,
      lines: lines.map((l) => ({ itemPublicId: l.item.publicId, quantity: l.quantity.trim() === '' ? NaN : Number(l.quantity) })) });
    if (!parsed.success) { s.invalid(parsed.error); return; }
    const r = await s.send(() => api<PartRequest>('/inventory/requests', { method: 'POST', json: parsed.data }));
    if (r) onSaved(r);
  }
  return <Modal title="Request parts" subtitle={`${ticket.number} · ${ticket.title}. The store approves and keeps the parts for you until they are handed out.`} onClose={onClose}>
    <form onSubmit={submit}>
      {s.error && <Notice>{s.error}</Notice>}
      <div className="form-grid">
        <RequestItemSearch ticketPublicId={ticket.publicId} onAdd={(item) => { if (!lines.some((l) => l.item.publicId === item.publicId)) setLines([...lines, { item, quantity: '1' }]); }} />
        {lines.map((l, i) => <div key={l.item.publicId} className="span-two chip-row">
          <span style={{ flex: 1 }}><b>{l.item.code}</b> {l.item.name}{!l.item.inStock && <small className="sub">not in stock now: the store may need to buy it</small>}</span>
          <input id={`nr-qty-${i}`} aria-label={`Quantity of ${l.item.code}`} type="number" min={0} step="any" style={{ maxWidth: 110 }} value={l.quantity}
            onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
          <span className="muted-text">{l.item.unit.code}</span>
          <button type="button" className="icon-button" aria-label={`Remove ${l.item.code}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><X size={15} /></button>
          <FieldError name={`lines.${i}.quantity`} errors={s.fields} /></div>)}
        <FieldError name="lines" errors={s.fields} />
        <label className="span-two">Note for the store <span className="optional">optional</span><input id="nr-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={s.busy || !lines.length}>{s.busy ? 'Sending…' : 'Send request'}</button></div>
    </form>
  </Modal>;
}

/** Cross-company access: a person of another company may request parts for one ticket of yours until a date. */
function Grants() {
  const [company, setCompany] = useState('');
  const [active, setActive] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const q = useLoad(() => api<Grant[]>(`/inventory/grants?${new URLSearchParams({ ...(company && { company }), ...(active && { active: 'true' }) })}`), [company, active]);
  async function end(g: Grant) {
    setError('');
    try { await api(`/inventory/grants/${g.publicId}/end`, { method: 'POST' }); q.reload(); } catch (e) { setError(errText(e)); }
  }
  return <Panel title="Cross-company access" note="Someone from the other company may request parts for one of your tickets until the date: no values, no approvals. Every grant is audited."
    action={<button className="primary-btn" onClick={() => setAdding(true)}><Plus size={16} /> Give access</button>}>
    <div className="panel-body">
      <div className="filters"><CompanyFilter id="gr-company" value={company} onChange={setCompany} />
        <label className="inline-field check-row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active only</label></div>
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No access given" /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>TICKET</th><th>UNTIL</th><th>GIVEN BY</th><th>STATUS</th><th /></tr></thead>
          <tbody>{q.data.map((g) => <tr key={g.publicId}><td><b>{g.person.displayName}</b></td><td>{g.ticket.number}<small className="sub">{g.company} · {g.ticket.title}</small></td>
            <td>{dayLabel(g.validUntil)}</td><td>{g.grantedBy.displayName}</td>
            <td><Badge tone={g.active ? 'green' : 'gray'}>{g.active ? 'active' : 'ended'}</Badge>{g.endedBy && <small className="sub">ended by {g.endedBy.displayName}</small>}</td>
            <td>{g.active && <button className="text-btn" onClick={() => void end(g)}>End now</button>}</td></tr>)}</tbody></table></div>}
    </div>
    {adding && <NewGrant onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.reload(); }} />}
  </Panel>;
}

function NewGrant({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const home = useHomeCompany();
  const [picked, setCompany] = useState('');
  const company = picked || home;
  const [ticket, setTicket] = useState('');
  const [person, setPerson] = useState('');
  const [until, setUntil] = useState(addDays(todayIst(), 14));
  const s = useSend();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = CreateGrantRequest.safeParse({ publicId: id, company, personPublicId: person, ticketPublicId: ticket, validUntil: until });
    if (!parsed.success) { s.invalid(!person ? 'Choose the person' : !ticket ? 'Choose the ticket' : parsed.error); return; }
    if (await s.send(() => api<Grant>('/inventory/grants', { method: 'POST', json: parsed.data }))) onSaved();
  }
  return <Modal title="Give cross-company access" subtitle="For a person who works in the other company. Someone of your own company gets the Parts requester role instead." onClose={onClose}>
    <form onSubmit={submit}>
      {s.error && <Notice>{s.error}</Notice>}
      <div className="form-grid">
        <CompanySelect id="ng-company" value={company} onChange={(c) => { setCompany(c); setTicket(''); }} />
        <label>Until (inclusive)<input id="ng-until" type="date" min={todayIst()} value={until} required onChange={(e) => setUntil(e.target.value)} /><FieldError name="validUntil" errors={s.fields} /></label>
        <TicketSelect key={company} id="ng-ticket" company={company} value={ticket} onChange={setTicket} className="span-two" />
        <PersonPicker idPrefix="ng-person" label="Person" hint="from the other company" onChange={setPerson} />
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={s.busy}>{s.busy ? 'Saving…' : 'Give access'}</button></div>
    </form>
  </Modal>;
}
