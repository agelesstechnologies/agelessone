import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowLeftRight, Download, PackageMinus, PackagePlus, Paperclip, Undo2 } from 'lucide-react';
import { StockDocumentStatus, StockDocumentType, type StockDocument, type StockDocumentList } from '@ageless/shared';
import { api, downloadFile, errText } from '../../api';
import { useAuth } from '../../auth';
import { dayLabel, useLoad } from '../../hooks';
import { INVENTORY } from '../../permissions';
import { Badge, CompanyFilter, Empty, Loading, Notice, PageHead, Panel } from '../../ui';
import { DOC_STATUS_TONE, DOC_TYPE_LABEL, money, Pager, qty } from './common';
import { IssueForm, ReceiptForm, ReturnForm, ReverseForm, TransferForm } from './DocumentForms';

const PAGE_SIZE = 50;
/** The document in the address (#inv-documents/<id>), if one is open. */
const docInHash = () => /^#inv-documents\/([0-9a-f-]{36})/i.exec(window.location.hash)?.[1] ?? null;
export const openDocument = (publicId: string) => { window.location.hash = `inv-documents/${publicId}`; };
const stamp = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Stock documents: receipts, issues, returns, transfers and reversals, newest first. Every movement of stock is one; a
 * mistake is reversed, never edited. Opens a document as its own page (#inv-documents/<id>).
 */
export default function Documents() {
  const posts = useAuth().can(INVENTORY.stockPost);
  const [openId, setOpenId] = useState(docInHash);
  const [creating, setCreating] = useState<'receipt' | 'issue' | 'transfer' | null>(null);
  useEffect(() => {
    const onHash = () => setOpenId(docInHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (openId) return <DocumentPage key={openId} id={openId} onBack={() => { if (window.history.length > 1) window.history.back(); else window.location.hash = 'inv-documents'; }} />;
  const saved = (d: StockDocument) => { setCreating(null); openDocument(d.publicId); };
  return <>
    <PageHead eyebrow="INVENTORY • DOCUMENTS" title="Stock documents" subtitle="Every movement of stock: goods received, parts issued and returned, transfers, reversals."
      action={posts ? <div className="chip-row">
        <button className="outline-btn" onClick={() => setCreating('transfer')}><ArrowLeftRight size={14} /> Transfer</button>
        <button className="outline-btn" onClick={() => setCreating('issue')}><PackageMinus size={14} /> Issue to ticket</button>
        <button className="primary-btn" onClick={() => setCreating('receipt')}><PackagePlus size={16} /> Receive goods</button></div> : undefined} />
    <DocumentList />
    {creating === 'receipt' && <ReceiptForm onClose={() => setCreating(null)} onSaved={saved} />}
    {creating === 'issue' && <IssueForm onClose={() => setCreating(null)} onSaved={saved} />}
    {creating === 'transfer' && <TransferForm onClose={() => setCreating(null)} onSaved={saved} />}
  </>;
}

function DocumentList() {
  const [company, setCompany] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), ...(company && { company }), ...(type && { type }), ...(status && { status }),
    ...(from && { from }), ...(to && { to }) });
  const q = useLoad(() => api<StockDocumentList>(`/inventory/documents?${params}`), [params.toString()]);
  const filter = (set: (v: string) => void) => (v: string) => { set(v); setPage(1); };
  return <Panel>
    <div className="panel-body">
      <div className="filters">
        <CompanyFilter id="dl-company" value={company} onChange={filter(setCompany)} />
        <label className="inline-field">Type<select id="dl-type" className="input" value={type} onChange={(e) => filter(setType)(e.target.value)}>
          <option value="">All</option>{StockDocumentType.options.map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}</select></label>
        <label className="inline-field">Status<select id="dl-status" className="input" value={status} onChange={(e) => filter(setStatus)(e.target.value)}>
          <option value="">All</option>{StockDocumentStatus.options.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</select></label>
        <label className="inline-field">From<input id="dl-from" className="input" type="date" value={from} onChange={(e) => filter(setFrom)(e.target.value)} /></label>
        <label className="inline-field">To<input id="dl-to" className="input" type="date" value={to} onChange={(e) => filter(setTo)(e.target.value)} /></label>
      </div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.items.length ? <Empty title="No documents" /> : <>
        <div className="table-wrap"><table><thead><tr><th>NUMBER</th><th>TYPE</th><th>DATE</th><th>FOR</th><th>STATUS</th><th className="num">LINES</th><th className="num">VALUE</th><th>BY</th></tr></thead>
          <tbody>{q.data.items.map((d) => <tr key={d.publicId} className="link-row" onClick={() => openDocument(d.publicId)}>
            <td><b>{d.number}</b><small className="sub">{d.company}</small></td>
            <td>{DOC_TYPE_LABEL[d.type]}</td><td>{dayLabel(d.documentDate)}</td>
            <td>{d.supplierName ?? (d.ticket ? <>{d.ticket.number}<small className="sub">{d.ticket.title}</small></> : d.original ? `undoes ${d.original.number}` : '—')}
              {d.request && <small className="sub">{d.request.number}</small>}</td>
            <td><Badge tone={DOC_STATUS_TONE[d.status]}>{d.status.replace('_', ' ')}</Badge>{d.reversal && <small className="sub">by {d.reversal.number}</small>}</td>
            <td className="num">{d.lineCount}</td><td className="num">{money(d.totalValueMinor)}</td><td>{d.createdBy.displayName}</td></tr>)}</tbody></table></div>
        <Pager page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} /></>}
    </div>
  </Panel>;
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return <div className="detail-row"><span>{label}</span><b>{children}</b></div>;
}

/** One document: its lines with cost and value, and what may be done with it now (reverse, receive, return, challan). */
function DocumentPage({ id, onBack }: { id: string; onBack: () => void }) {
  const posts = useAuth().can(INVENTORY.stockPost);
  const q = useLoad(() => api<StockDocument>(`/inventory/documents/${id}`), [id]);
  const [dialog, setDialog] = useState<'reverse' | 'return' | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const d = q.data;

  async function act(fn: () => Promise<StockDocument | void>, done: string) {
    setBusy(true); setError(''); setNote('');
    try { const r = await fn(); if (r) q.setData(r); setNote(done); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  const attach = (f: File) => {
    const body = new FormData(); body.append('file', f);
    return act(() => api<StockDocument>(`/inventory/documents/${id}/challan`, { method: 'POST', body }), 'Challan attached.');
  };
  const back = <button className="icon-button" aria-label="Back" onClick={onBack}><ArrowLeft size={20} /></button>;
  if (!d) return <>{back}{q.error ? <Notice>{q.error}</Notice> : <Loading />}</>;

  const live = d.status !== 'reversed' && d.type !== 'reversal';
  return <>
    <PageHead eyebrow={`INVENTORY • ${DOC_TYPE_LABEL[d.type].toUpperCase()}`} title={d.number} subtitle={`${d.company} · ${dayLabel(d.documentDate)} · by ${d.createdBy.displayName}`}
      action={<div className="chip-row">{back}
        {posts && d.type === 'transfer' && d.status === 'in_transit' &&
          <button className="primary-btn" disabled={busy} onClick={() => void act(() => api<StockDocument>(`/inventory/transfers/${id}/receive`, { method: 'POST' }), 'Transfer received.')}>Receive transfer</button>}
        {posts && d.type === 'issue' && d.status === 'posted' && <button className="outline-btn" onClick={() => setDialog('return')}><Undo2 size={14} /> Return parts</button>}
        {posts && live && <button className="outline-btn" onClick={() => setDialog('reverse')}>Reverse</button>}
        {d.hasChallan && <button className="outline-btn" disabled={busy} onClick={() => void act(() => downloadFile(`/inventory/documents/${id}/challan`, `${d.number}-challan`), 'Challan downloaded.')}>
          <Download size={14} /> Challan</button>}
        {posts && d.type === 'receipt' && !d.hasChallan && <label className="outline-btn" style={{ cursor: 'pointer' }}><Paperclip size={14} /> Attach challan
          <input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void attach(f); e.currentTarget.value = ''; }} /></label>}
      </div>} />
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
    <div className="two-col">
      <Panel title="Details">
        <div className="panel-body">
          <Info label="Status"><Badge tone={DOC_STATUS_TONE[d.status]}>{d.status.replace('_', ' ')}</Badge></Info>
          {d.supplierName && <Info label="Supplier">{d.supplierName}</Info>}
          {d.challanNo && <Info label="Challan no.">{d.challanNo}</Info>}
          {d.ticket && <Info label="Ticket">{d.ticket.number} · {d.ticket.title}</Info>}
          {d.request && <Info label="Part request">{d.request.number}</Info>}
          {d.reason && <Info label="Reason">{d.reason}</Info>}
          {d.note && <Info label="Note">{d.note}</Info>}
          {d.transitLocation && <Info label="Transit">{d.transitLocation.code} · {d.transitLocation.name}</Info>}
          {d.receivedBy && d.receivedAt && <Info label="Received">{d.receivedBy.displayName} · {stamp(d.receivedAt)}</Info>}
          {d.original && <Info label="Undoes"><button className="text-btn" onClick={() => openDocument(d.original!.publicId)}>{d.original.number}</button></Info>}
          {d.reversal && <Info label="Reversed by"><button className="text-btn" onClick={() => openDocument(d.reversal!.publicId)}>{d.reversal.number}</button></Info>}
          <Info label="Posted">{stamp(d.createdAt)}</Info>
          <Info label="Total value">{money(d.totalValueMinor)}</Info>
        </div>
      </Panel>
    </div>
    <Panel title="Lines">
      <div className="table-wrap"><table><thead><tr><th>#</th><th>ITEM</th><th className="num">QUANTITY</th><th>{d.type === 'transfer' ? 'FROM → TO' : 'LOCATION'}</th><th>BATCH / SERIAL</th>
        <th className="num">UNIT COST</th><th className="num">VALUE</th></tr></thead>
        <tbody>{d.lines.map((l) => <tr key={l.lineNo}>
          <td>{l.lineNo}</td>
          <td><b>{l.item.code}</b> {l.item.name}{l.condition && <small className="sub">{l.condition}{l.returnOfLineNo ? ` · returns line ${l.returnOfLineNo}` : ''}</small>}
            {l.requestLineNo && <small className="sub">request line {l.requestLineNo}</small>}</td>
          <td className="num qty">{qty(l.quantity)} {l.unit.code}{l.enteredQuantity != null && l.enteredUnit && <small className="sub">entered {qty(l.enteredQuantity)} {l.enteredUnit.code}</small>}</td>
          <td>{l.location.code}{l.toLocation && <> → {l.toLocation.code}</>}</td>
          <td>{l.batchNo ? <>{l.batchNo}{l.expiryDate && <small className="sub">expires {dayLabel(l.expiryDate)}</small>}</> : l.serialNo ?? '—'}</td>
          <td className="num">{money(l.unitCostMinor)}</td><td className="num">{money(l.valueMinor)}</td></tr>)}</tbody></table></div>
    </Panel>
    {dialog === 'reverse' && <ReverseForm doc={d} onClose={() => setDialog(null)} onSaved={(r) => { setDialog(null); openDocument(r.publicId); }} />}
    {dialog === 'return' && <ReturnForm issue={d} onClose={() => setDialog(null)} onSaved={(r) => { setDialog(null); openDocument(r.publicId); }} />}
  </>;
}
