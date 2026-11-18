import { useState, type FormEvent, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import {
  CreateIssueRequest, CreateReceiptRequest, CreateReturnRequest, CreateTransferRequest, ReverseDocumentRequest,
  type Item, type PartRequest, type ReturnCondition, type StockDocument,
} from '@ageless/shared';
import { api } from '../../api';
import { todayIst, useLoad, uuidv7 } from '../../hooks';
import { FieldError, Modal, Notice, type FieldErrors } from '../../ui';
import { BatchSelect, CompanySelect, ItemSearch, LocationSelect, money, qty, TicketSelect, toPaise, USABLE, useHomeCompany, useLocations, useSend } from './common';

/** A new line's key, so React keeps each line's inputs apart when one is removed. */
let lineKey = 0;
const nextKey = () => ++lineKey;
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
const opt = (s: string) => s.trim() || undefined;

/** The shell of a document form: wide modal, banner, the fields, and the lines. */
function DocModal({ title, subtitle, error, busy, submitLabel, onClose, onSubmit, children }: {
  title: string; subtitle: string; error: string; busy: boolean; submitLabel: string; onClose: () => void; onSubmit: () => void; children: ReactNode;
}) {
  return <Modal title={title} subtitle={subtitle} onClose={onClose} wide>
    <form onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">{children}</div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={busy}>{busy ? 'Posting…' : submitLabel}</button></div>
    </form>
  </Modal>;
}

/** One line of a document form: a numbered card with Remove (when there is more than one line). */
function LineCard({ n, onRemove, children }: { n: number; onRemove?: () => void; children: ReactNode }) {
  return <div className="line-card"><div className="line-head">Line {n}{onRemove && <button type="button" className="text-btn" onClick={onRemove}>Remove</button>}</div>{children}</div>;
}

/** The fields every document has: date (today or earlier) and a note. */
function DateAndNote({ prefix, date, setDate, note, setNote, fields }: { prefix: string; date: string; setDate: (v: string) => void; note: string; setNote: (v: string) => void; fields: FieldErrors }) {
  return <>
    <label>Date<input id={`${prefix}-date`} type="date" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} /><FieldError name="documentDate" errors={fields} /></label>
    <label className="span-two">Note <span className="optional">optional</span><input id={`${prefix}-note`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /><FieldError name="note" errors={fields} /></label>
  </>;
}

type ReceiptLine = { key: number; item: Item | null; quantity: string; unit: string; cost: string; location: string; batchNo: string; expiry: string; serialNo: string };
const newReceiptLine = (): ReceiptLine => ({ key: nextKey(), item: null, quantity: '', unit: '', cost: '', location: '', batchNo: '', expiry: '', serialNo: '' });

/**
 * Receive goods from a supplier (until purchase orders exist, a direct purchase with a reason). Each line in the base unit
 * or one of the item's other units, with the cost per that unit; batch items name the batch, serial items are one unit per line.
 */
export function ReceiptForm({ onClose, onSaved }: { onClose: () => void; onSaved: (d: StockDocument) => void }) {
  const [id] = useState(uuidv7);
  const home = useHomeCompany();
  const [picked, setCompany] = useState('');
  const company = picked || home;
  const [head, setHead] = useState({ supplier: '', challan: '', reason: '', note: '', date: todayIst() });
  const [lines, setLines] = useState<ReceiptLine[]>([newReceiptLine()]);
  const s = useSend();
  const locations = useLocations(company);
  const setLine = (i: number, patch: Partial<ReceiptLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const factor = (l: ReceiptLine) => (l.item && l.unit ? l.item.conversions.find((c) => c.unit.publicId === l.unit)?.factor ?? 1 : 1);
  const total = lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (toPaise(l.cost) || 0), 0);

  async function submit() {
    const parsed = CreateReceiptRequest.safeParse({
      publicId: id, company, documentDate: head.date || undefined, supplierName: head.supplier, challanNo: opt(head.challan), reason: head.reason, note: opt(head.note),
      lines: lines.map((l) => ({ itemPublicId: l.item?.publicId, locationPublicId: l.location || undefined, quantity: num(l.quantity), unitPublicId: l.unit || undefined,
        unitCostMinor: toPaise(l.cost), batchNo: opt(l.batchNo), expiryDate: opt(l.expiry), serialNo: opt(l.serialNo) })),
    });
    if (!parsed.success) { s.invalid(parsed.error); return; }
    const d = await s.send(() => api<StockDocument>('/inventory/receipts', { method: 'POST', json: parsed.data }));
    if (d) onSaved(d);
  }
  return <DocModal title="Receive goods" subtitle="Goods arriving from a supplier. Stock and the average cost update when you post." error={s.error} busy={s.busy}
    submitLabel="Post receipt" onClose={onClose} onSubmit={() => void submit()}>
    <CompanySelect id="rc-company" value={company} onChange={(c) => { setCompany(c); setLines([newReceiptLine()]); }} />
    <label>Supplier<input id="rc-supplier" value={head.supplier} required maxLength={120} onChange={(e) => setHead({ ...head, supplier: e.target.value })} /><FieldError name="supplierName" errors={s.fields} /></label>
    <label>Challan no. <span className="optional">optional</span><input id="rc-challan" value={head.challan} maxLength={60} onChange={(e) => setHead({ ...head, challan: e.target.value })} /></label>
    <label className="span-two">Reason<input id="rc-reason" value={head.reason} required maxLength={300} placeholder="Direct purchase for the lab"
      onChange={(e) => setHead({ ...head, reason: e.target.value })} /><FieldError name="reason" errors={s.fields} /></label>
    <DateAndNote prefix="rc" date={head.date} setDate={(date) => setHead({ ...head, date })} note={head.note} setNote={(note) => setHead({ ...head, note })} fields={s.fields} />
    {lines.map((l, i) => {
      const e = (f: string) => <FieldError name={`lines.${i}.${f}`} errors={s.fields} />;
      const units = l.item ? [l.item.baseUnit, ...l.item.conversions.map((c) => c.unit)] : [];
      return <LineCard key={l.key} n={i + 1} onRemove={lines.length > 1 ? () => setLines(lines.filter((_, j) => j !== i)) : undefined}>
        <ItemSearch key={`${company}-${l.key}`} id={`rc-item-${i}`} company={company}
          onPick={(item) => setLine(i, { item, unit: '', location: item?.defaultLocation?.publicId ?? '', quantity: item?.tracking === 'serial' ? '1' : l.quantity })} />
        <label className="span-two">Location<LocationSelect id={`rc-loc-${i}`} locations={locations.data ?? []} types={USABLE} value={l.location}
          onChange={(location) => setLine(i, { location })} empty="The item's default location" />{e('locationPublicId')}</label>
        {e('itemPublicId')}
        <label>Quantity<input id={`rc-qty-${i}`} type="number" min={0} step="any" value={l.quantity} disabled={l.item?.tracking === 'serial'}
          onChange={(ev) => setLine(i, { quantity: ev.target.value })} />{e('quantity')}</label>
        <label>Unit<select id={`rc-unit-${i}`} value={l.unit} onChange={(ev) => setLine(i, { unit: ev.target.value })}>
          {units.length ? units.map((u, k) => <option key={u.publicId} value={k === 0 ? '' : u.publicId}>{u.code}</option>) : <option value="">—</option>}</select></label>
        <label>Cost per {units.find((u) => u.publicId === l.unit)?.code ?? l.item?.baseUnit.code ?? 'unit'} (₹)<input id={`rc-cost-${i}`} type="number" min={0} step="0.01" value={l.cost}
          onChange={(ev) => setLine(i, { cost: ev.target.value })} />{e('unitCostMinor')}</label>
        <label>Line value<input id={`rc-value-${i}`} readOnly value={l.quantity && l.cost ? money((Number(l.quantity) || 0) * (toPaise(l.cost) || 0)) : ''} />
          {factor(l) !== 1 && Number(l.quantity) > 0 && <small className="sub">= {qty(Number(l.quantity) * factor(l))} {l.item?.baseUnit.code}</small>}</label>
        {l.item?.tracking === 'batch' && <>
          <label>Batch no.<input id={`rc-batch-${i}`} value={l.batchNo} maxLength={60} onChange={(ev) => setLine(i, { batchNo: ev.target.value })} />{e('batchNo')}</label>
          <label>Expiry <span className="optional">optional</span><input id={`rc-expiry-${i}`} type="date" value={l.expiry} onChange={(ev) => setLine(i, { expiry: ev.target.value })} />{e('expiryDate')}</label></>}
        {l.item?.tracking === 'serial' && <label className="span-two">Serial no.<input id={`rc-serial-${i}`} value={l.serialNo} maxLength={80}
          onChange={(ev) => setLine(i, { serialNo: ev.target.value })} />{e('serialNo')}</label>}
      </LineCard>;
    })}
    <FieldError name="lines" errors={s.fields} />
    <div className="line-total"><button type="button" className="text-btn" onClick={() => setLines([...lines, newReceiptLine()])}><Plus size={12} /> Add line</button>
      {' '}· Total <b>{money(total)}</b></div>
  </DocModal>;
}

type MoveLine = { key: number; item: Item | null; from: string; to: string; quantity: string; batchNo: string; serialNo: string };
const newMoveLine = (): MoveLine => ({ key: nextKey(), item: null, from: '', to: '', quantity: '', batchNo: '', serialNo: '' });

/** The item, quantity, batch and serial fields shared by issue and transfer lines. */
function MoveFields({ prefix, i, l, set, fields }: { prefix: string; i: number; l: MoveLine; set: (patch: Partial<MoveLine>) => void; fields: FieldErrors }) {
  const e = (f: string) => <FieldError name={`lines.${i}.${f}`} errors={fields} />;
  return <>
    <label>Quantity{l.item && ` (${l.item.baseUnit.code})`}<input id={`${prefix}-qty-${i}`} type="number" min={0} step="any" value={l.quantity} disabled={l.item?.tracking === 'serial'}
      onChange={(ev) => set({ quantity: ev.target.value })} />{e('quantity')}</label>
    {l.item?.tracking === 'batch' && <label>Batch<BatchSelect id={`${prefix}-batch-${i}`} itemPublicId={l.item.publicId} locationPublicId={l.from} value={l.batchNo}
      onChange={(batchNo) => set({ batchNo })} />{e('batchNo')}</label>}
    {l.item?.tracking === 'serial' && <label>Serial no.<input id={`${prefix}-serial-${i}`} value={l.serialNo} maxLength={80} onChange={(ev) => set({ serialNo: ev.target.value })} />{e('serialNo')}</label>}
  </>;
}

/**
 * Issue parts to a ticket directly (without a part request): only stock no request has reserved, at the average cost now.
 * Batch items without a batch take the earliest expiry first.
 */
export function IssueForm({ onClose, onSaved }: { onClose: () => void; onSaved: (d: StockDocument) => void }) {
  const [id] = useState(uuidv7);
  const home = useHomeCompany();
  const [picked, setCompany] = useState('');
  const company = picked || home;
  const [ticket, setTicket] = useState('');
  const [date, setDate] = useState(todayIst());
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<MoveLine[]>([newMoveLine()]);
  const s = useSend();
  const locations = useLocations(company);
  const setLine = (i: number, patch: Partial<MoveLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit() {
    const parsed = CreateIssueRequest.safeParse({
      publicId: id, company, ticketPublicId: ticket || undefined, documentDate: date || undefined, note: opt(note),
      lines: lines.map((l) => ({ itemPublicId: l.item?.publicId, locationPublicId: l.from, quantity: num(l.quantity), batchNo: opt(l.batchNo), serialNo: opt(l.serialNo) })),
    });
    if (!parsed.success) { s.invalid(ticket ? parsed.error : 'Choose the ticket'); return; }
    const d = await s.send(() => api<StockDocument>('/inventory/issues', { method: 'POST', json: parsed.data }));
    if (d) onSaved(d);
  }
  return <DocModal title="Issue parts to a ticket" subtitle="Without a part request: only stock that no request has reserved. Approved requests are issued from Part requests."
    error={s.error} busy={s.busy} submitLabel="Post issue" onClose={onClose} onSubmit={() => void submit()}>
    <CompanySelect id="is-company" value={company} onChange={(c) => { setCompany(c); setTicket(''); setLines([newMoveLine()]); }} />
    <TicketSelect key={company} id="is-ticket" company={company} value={ticket} onChange={setTicket} />
    <DateAndNote prefix="is" date={date} setDate={setDate} note={note} setNote={setNote} fields={s.fields} />
    {lines.map((l, i) => <LineCard key={l.key} n={i + 1} onRemove={lines.length > 1 ? () => setLines(lines.filter((_, j) => j !== i)) : undefined}>
      <ItemSearch key={`${company}-${l.key}`} id={`is-item-${i}`} company={company}
        onPick={(item) => setLine(i, { item, batchNo: '', serialNo: '', from: item?.defaultLocation?.publicId ?? l.from, quantity: item?.tracking === 'serial' ? '1' : l.quantity })} />
      <label className="span-two">From<LocationSelect id={`is-from-${i}`} locations={locations.data ?? []} types={USABLE} value={l.from} required
        onChange={(from) => setLine(i, { from, batchNo: '' })} /><FieldError name={`lines.${i}.locationPublicId`} errors={s.fields} /></label>
      <FieldError name={`lines.${i}.itemPublicId`} errors={s.fields} />
      <MoveFields prefix="is" i={i} l={l} set={(p) => setLine(i, p)} fields={s.fields} />
    </LineCard>)}
    <div className="line-total"><button type="button" className="text-btn" onClick={() => setLines([...lines, newMoveLine()])}><Plus size={12} /> Add line</button></div>
  </DocModal>;
}

/** Send stock to another location of the company: it waits in transit until the receiving side receives it. */
export function TransferForm({ onClose, onSaved }: { onClose: () => void; onSaved: (d: StockDocument) => void }) {
  const [id] = useState(uuidv7);
  const home = useHomeCompany();
  const [picked, setCompany] = useState('');
  const company = picked || home;
  const [transit, setTransit] = useState('');
  const [date, setDate] = useState(todayIst());
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<MoveLine[]>([newMoveLine()]);
  const s = useSend();
  const locations = useLocations(company);
  const all = locations.data ?? [];
  const places = all.filter((l) => l.type !== 'transit');
  const setLine = (i: number, patch: Partial<MoveLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit() {
    const parsed = CreateTransferRequest.safeParse({
      publicId: id, company, transitLocationPublicId: transit || undefined, documentDate: date || undefined, note: opt(note),
      lines: lines.map((l) => ({ itemPublicId: l.item?.publicId, fromLocationPublicId: l.from, toLocationPublicId: l.to, quantity: num(l.quantity),
        batchNo: opt(l.batchNo), serialNo: opt(l.serialNo) })),
    });
    if (!parsed.success) { s.invalid(parsed.error); return; }
    const d = await s.send(() => api<StockDocument>('/inventory/transfers', { method: 'POST', json: parsed.data }));
    if (d) onSaved(d);
  }
  return <DocModal title="Transfer stock" subtitle="The stock leaves now and waits in transit until the receiving side receives it. The value never changes."
    error={s.error} busy={s.busy} submitLabel="Send transfer" onClose={onClose} onSubmit={() => void submit()}>
    <CompanySelect id="tr-company" value={company} onChange={(c) => { setCompany(c); setTransit(''); setLines([newMoveLine()]); }} />
    <label>Transit location<LocationSelect id="tr-transit" locations={all} types={['transit']} value={transit} onChange={setTransit} empty="The company's only one" />
      <FieldError name="transitLocationPublicId" errors={s.fields} /></label>
    <DateAndNote prefix="tr" date={date} setDate={setDate} note={note} setNote={setNote} fields={s.fields} />
    {lines.map((l, i) => <LineCard key={l.key} n={i + 1} onRemove={lines.length > 1 ? () => setLines(lines.filter((_, j) => j !== i)) : undefined}>
      <ItemSearch key={`${company}-${l.key}`} id={`tr-item-${i}`} company={company}
        onPick={(item) => setLine(i, { item, batchNo: '', serialNo: '', quantity: item?.tracking === 'serial' ? '1' : l.quantity })} />
      <label>From<LocationSelect id={`tr-from-${i}`} locations={places} value={l.from} required onChange={(from) => setLine(i, { from, batchNo: '' })} />
        <FieldError name={`lines.${i}.fromLocationPublicId`} errors={s.fields} /></label>
      <label>To<LocationSelect id={`tr-to-${i}`} locations={places.filter((p) => p.publicId !== l.from)} value={l.to} required onChange={(to) => setLine(i, { to })} />
        <FieldError name={`lines.${i}.toLocationPublicId`} errors={s.fields} /></label>
      <FieldError name={`lines.${i}.itemPublicId`} errors={s.fields} />
      <MoveFields prefix="tr" i={i} l={l} set={(p) => setLine(i, p)} fields={s.fields} />
    </LineCard>)}
    <div className="line-total"><button type="button" className="text-btn" onClick={() => setLines([...lines, newMoveLine()])}><Plus size={12} /> Add line</button></div>
  </DocModal>;
}

const CONDITION_LABEL: Record<ReturnCondition, string> = { usable: 'Usable (back to stock)', repair: 'Needs repair (quarantine)', scrap: 'Scrap' };

/**
 * Parts coming back from an issue, at the cost they were issued at. Usable parts go back where they came from (or a
 * chosen usable location); repair goes to quarantine and scrap to scrap (the company's only one, unless chosen).
 */
export function ReturnForm({ issue, onClose, onSaved }: { issue: StockDocument; onClose: () => void; onSaved: (d: StockDocument) => void }) {
  const [id] = useState(uuidv7);
  const [date, setDate] = useState(todayIst());
  const [note, setNote] = useState('');
  const [rows, setRows] = useState(issue.lines.map((l) => ({ lineNo: l.lineNo, quantity: '', condition: 'usable' as ReturnCondition, location: '' })));
  const s = useSend();
  const locations = useLocations(issue.company);
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const typesFor = (c: ReturnCondition) => (c === 'usable' ? USABLE : c === 'repair' ? ['quarantine' as const] : ['scrap' as const]);

  async function submit() {
    const chosen = rows.filter((r) => r.quantity.trim() !== '');
    if (!chosen.length) { s.invalid('Give the quantity coming back on at least one line'); return; }
    const parsed = CreateReturnRequest.safeParse({ publicId: id, issuePublicId: issue.publicId, documentDate: date || undefined, note: opt(note),
      lines: chosen.map((r) => ({ lineNo: r.lineNo, quantity: num(r.quantity), condition: r.condition, locationPublicId: r.location || undefined })) });
    if (!parsed.success) { s.invalid(parsed.error); return; }
    const d = await s.send(() => api<StockDocument>('/inventory/returns', { method: 'POST', json: parsed.data }));
    if (d) onSaved(d);
  }
  return <DocModal title={`Return parts from ${issue.number}`} subtitle={`${issue.ticket ? `${issue.ticket.number} · ` : ''}Fill in only the lines coming back.`}
    error={s.error} busy={s.busy} submitLabel="Post return" onClose={onClose} onSubmit={() => void submit()}>
    <DateAndNote prefix="rt" date={date} setDate={setDate} note={note} setNote={setNote} fields={s.fields} />
    {issue.lines.map((l, i) => <LineCard key={l.lineNo} n={l.lineNo}>
      <p className="span-all muted-text"><b>{l.item.code}</b> {l.item.name} · issued {qty(l.quantity)} {l.unit.code} from {l.location.code}
        {l.batchNo ? ` · batch ${l.batchNo}` : ''}{l.serialNo ? ` · serial ${l.serialNo}` : ''}</p>
      <label>Coming back<input id={`rt-qty-${i}`} type="number" min={0} max={l.quantity} step="any" value={rows[i]!.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></label>
      <label>Condition<select id={`rt-cond-${i}`} value={rows[i]!.condition} onChange={(e) => set(i, { condition: e.target.value as ReturnCondition, location: '' })}>
        {Object.entries(CONDITION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="span-two">Into<LocationSelect id={`rt-loc-${i}`} locations={locations.data ?? []} types={typesFor(rows[i]!.condition)} value={rows[i]!.location}
        onChange={(location) => set(i, { location })} empty={rows[i]!.condition === 'usable' ? `Where it came from (${l.location.code})` : 'The company’s only one'} /></label>
    </LineCard>)}
  </DocModal>;
}

/** Undo a posted document with a reversal document (every move of it, opposite). */
export function ReverseForm({ doc, onClose, onSaved }: { doc: StockDocument; onClose: () => void; onSaved: (d: StockDocument) => void }) {
  const [id] = useState(uuidv7);
  const [reason, setReason] = useState('');
  const s = useSend();
  async function submit() {
    const parsed = ReverseDocumentRequest.safeParse({ publicId: id, reason });
    if (!parsed.success) { s.invalid(parsed.error); return; }
    const d = await s.send(() => api<StockDocument>(`/inventory/documents/${doc.publicId}/reverse`, { method: 'POST', json: parsed.data }));
    if (d) onSaved(d);
  }
  return <Modal title={`Reverse ${doc.number}`} subtitle="A reversal document undoes every move of it; quantities and value come back. This cannot be undone." onClose={onClose}>
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {s.error && <Notice>{s.error}</Notice>}
      <div className="form-grid"><label className="span-two">Reason<input id="rv-reason" value={reason} required minLength={3} maxLength={300} autoFocus
        onChange={(e) => setReason(e.target.value)} /><FieldError name="reason" errors={s.fields} /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={s.busy}>{s.busy ? 'Reversing…' : 'Reverse document'}</button></div>
    </form>
  </Modal>;
}

/**
 * Issue an approved part request: each line takes its reserved stock (and free stock where it was reserved if that ran
 * short). Left at the full amount, a line issues everything still to issue. Serial items list the units handed out.
 */
export function IssueRequestForm({ request, onClose, onSaved }: { request: PartRequest; onClose: () => void; onSaved: (d: StockDocument) => void }) {
  const [id] = useState(uuidv7);
  const open = request.lines.filter((l) => l.quantity > l.issued);
  const items = useLoad(() => Promise.all(open.map((l) => api<Item>(`/inventory/items/${l.item.publicId}`))), [request.publicId]);
  const serial = (itemPublicId: string) => items.data?.find((i) => i.publicId === itemPublicId)?.tracking === 'serial';
  const [rows, setRows] = useState(open.map((l) => ({ lineNo: l.lineNo, quantity: String(l.quantity - l.issued), serials: '' })));
  const [note, setNote] = useState('');
  const s = useSend();
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function submit() {
    const chosen = rows.map((r, i) => ({ r, l: open[i]! })).filter(({ r }) => r.quantity.trim() !== '' && Number(r.quantity) > 0);
    if (!chosen.length) { s.invalid('Give the quantity handed out on at least one line'); return; }
    const parsed = CreateIssueRequest.safeParse({ publicId: id, company: request.company, requestPublicId: request.publicId, note: opt(note),
      requestLines: chosen.map(({ r, l }) => {
        const serialNos = r.serials.split(/[\s,]+/).filter(Boolean);
        if (serial(l.item.publicId)) return { lineNo: r.lineNo, quantity: serialNos.length || undefined, serialNos: serialNos.length ? serialNos : undefined };
        const q = num(r.quantity);
        return { lineNo: r.lineNo, quantity: q === l.quantity - l.issued ? undefined : q };
      }) });
    if (!parsed.success) { s.invalid(parsed.error); return; }
    const d = await s.send(() => api<StockDocument>('/inventory/issues', { method: 'POST', json: parsed.data }));
    if (d) onSaved(d);
  }
  return <DocModal title={`Issue ${request.number}`} subtitle={`${request.ticket.number} · ${request.ticket.title}. The reserved stock is handed out at the average cost now.`}
    error={s.error || items.error} busy={s.busy || items.loading} submitLabel="Post issue" onClose={onClose} onSubmit={() => void submit()}>
    <label className="span-two">Note <span className="optional">optional</span><input id="ir-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
    {open.map((l, i) => <LineCard key={l.lineNo} n={l.lineNo}>
      <p className="span-all muted-text"><b>{l.item.code}</b> {l.item.name} · asked {qty(l.quantity)} {l.unit.code}, issued {qty(l.issued)}, reserved {qty(l.reserved)}
        {l.reservations.length > 0 && ` (${l.reservations.map((r) => `${qty(r.quantity)} in ${r.location.code}${r.batchNo ? ` batch ${r.batchNo}` : ''}`).join(', ')})`}</p>
      {serial(l.item.publicId)
        ? <label className="span-all">Serial numbers handed out<input id={`ir-serials-${i}`} value={rows[i]!.serials} placeholder="SN-001, SN-002"
          onChange={(e) => set(i, { serials: e.target.value })} /><FieldError name={`requestLines.${i}.serialNos`} errors={s.fields} /></label>
        : <label>Quantity ({l.unit.code})<input id={`ir-qty-${i}`} type="number" min={0} max={l.quantity - l.issued} step="any" value={rows[i]!.quantity}
          onChange={(e) => set(i, { quantity: e.target.value })} /><FieldError name={`requestLines.${i}.quantity`} errors={s.fields} /></label>}
    </LineCard>)}
  </DocModal>;
}
