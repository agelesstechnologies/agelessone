import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, X } from 'lucide-react';
import {
  ITEM_CSV_COLUMNS, LOCATION_CSV_COLUMNS,
  type ImportProblem, type ImportResult, type Item, type ItemList, type Location, type LocationType, type PartRequestStatus,
  type StockBatch, type StockDocumentStatus, type StockDocumentType, type TicketSummary,
} from '@ageless/shared';
import { api, ApiFailure, errText, formError } from '../../api';
import { dayLabel, rupees, useLoad, useMyEmployments } from '../../hooks';
import { Badge, COMPANIES, fieldErrors, Modal, Notice, type FieldErrors, type Tone } from '../../ui';

type Issues = { issues: { path: (string | number)[]; message: string }[] };

/**
 * A form's sending state: invalid() shows what the form's own check found (a sentence, or a failed Zod parse whose
 * messages also go next to their fields), send() runs the request and shows a refusal the same way. send answers the
 * result, or undefined when refused.
 */
export function useSend() {
  const [error, setError] = useState('');
  const [fields, setFields] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const invalid = (e: string | Issues) => {
    if (typeof e === 'string') { setError(e); setFields({}); } else { setError(formError(e)); setFields(fieldErrors(e)); }
  };
  async function send<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true); setError(''); setFields({});
    try { return await fn(); } catch (e) { setError(errText(e)); setFields(fieldErrors(e)); return undefined; } finally { setBusy(false); }
  }
  return { error, fields, busy, invalid, send, clear: () => { setError(''); setFields({}); } };
}

const LIVE_TICKET = ['open', 'assigned', 'in_progress', 'on_hold'];
/** A company's tickets that still take parts (open, assigned, in progress, on hold). Needs a permission to list tickets. */
export function TicketSelect({ id, company, value, onChange, className }: { id: string; company: string; value: string; onChange: (publicId: string) => void; className?: string }) {
  const q = useLoad(() => api<TicketSummary[]>(`/tickets?company=${company}&limit=200`), [company]);
  const live = (q.data ?? []).filter((t) => LIVE_TICKET.includes(t.status));
  return <label className={className}>Ticket<select id={id} value={value} required onChange={(e) => onChange(e.target.value)}>
    <option value="">{q.loading ? 'Loading…' : live.length ? 'Choose' : 'No open tickets'}</option>
    {live.map((t) => <option key={t.publicId} value={t.publicId}>{t.number} · {t.title}</option>)}</select>
    {q.error && <small className="field-error">{q.error.startsWith('You do not have') ? 'You cannot list tickets: issue against a part request instead.' : q.error}</small>}</label>;
}

/** The batches of an item with stock (in one location when given), earliest expiry first; '' = earliest expiry first. */
export function BatchSelect({ id, itemPublicId, locationPublicId, value, onChange }: {
  id: string; itemPublicId: string; locationPublicId: string; value: string; onChange: (batchNo: string) => void;
}) {
  const q = useLoad(() => (itemPublicId ? api<StockBatch[]>(`/inventory/stock/batches?item=${itemPublicId}${locationPublicId ? `&location=${locationPublicId}` : ''}`)
    : Promise.resolve([] as StockBatch[])), [itemPublicId, locationPublicId]);
  return <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="">Earliest expiry first</option>
    {q.data?.map((b) => <option key={`${b.batchNo}-${b.location.publicId}`} value={b.batchNo} disabled={b.available <= 0}>
      {b.batchNo}{b.expiryDate ? ` · expires ${dayLabel(b.expiryDate)}` : ''} · {qty(b.available)} free{locationPublicId ? '' : ` in ${b.location.code}`}</option>)}</select>;
}

/** A quantity as people read it: up to 4 decimals, Indian digit grouping ("1,250.5"). */
export const qty = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 4 });
/** Money in minor units (paise) as rupees; null (values this person does not see) as a dash. */
export const money = (minor: number | null | undefined) => (minor == null ? '—' : rupees(Math.round(minor)));
/** Rupees typed in a form ("150.50") as paise, or NaN. */
export const toPaise = (text: string) => (text.trim() === '' ? NaN : Math.round(Number(text) * 100));

export const REQUEST_TONE: Record<PartRequestStatus, Tone> = { pending: 'amber', approved: 'blue', fulfilled: 'green', rejected: 'red', cancelled: 'gray', expired: 'gray', closed: 'gray' };
export const DOC_STATUS_TONE: Record<StockDocumentStatus, Tone> = { posted: 'green', in_transit: 'amber', reversed: 'gray' };
export const DOC_TYPE_LABEL: Record<StockDocumentType, string> = { receipt: 'Receipt', issue: 'Issue', return: 'Return', transfer: 'Transfer', reversal: 'Reversal' };
export const LOCATION_TYPE_LABEL: Record<LocationType, string> = {
  store: 'Store', rack: 'Rack', bin: 'Bin', work_area: 'Work area', testing: 'Testing', transit: 'Transit', quarantine: 'Quarantine', scrap: 'Scrap',
};
/** Where usable stock sits: received, issued from, returned in good condition. */
export const USABLE: LocationType[] = ['store', 'rack', 'bin', 'work_area', 'testing'];

export const StatusBadge = ({ status }: { status: string }) => <Badge tone={status === 'active' ? 'green' : 'gray'}>{status}</Badge>;

/** The company forms start in: the person's main job's company (until it loads, or without a job: ATPL). */
export function useHomeCompany(): string {
  const { primary } = useMyEmployments();
  return primary?.company.code ?? 'ATPL';
}

/** Choose one company (forms). */
export const CompanySelect = ({ id, value, onChange, disabled }: { id: string; value: string; onChange: (code: string) => void; disabled?: boolean }) =>
  <label>Company<select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
    {COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>;

/** The active locations of one company the person reaches (scope own: only those they look after). */
export function useLocations(company: string) {
  return useLoad(() => (company ? api<Location[]>(`/inventory/locations?company=${company}&status=active`) : Promise.resolve([] as Location[])), [company]);
}
export const locationLabel = (l: { code: string; name: string }) => `${l.code} · ${l.name}`;

/** A select of locations (only the given types, when listed). '' is "none chosen", shown as `empty`. */
export function LocationSelect({ id, locations, value, onChange, types, empty = 'Choose', required }: {
  id: string; locations: Location[]; value: string; onChange: (publicId: string) => void; types?: LocationType[]; empty?: string; required?: boolean;
}) {
  const shown = locations.filter((l) => !types || types.includes(l.type)).sort((a, b) => a.code.localeCompare(b.code));
  return <select id={id} className="input" value={value} required={required} onChange={(e) => onChange(e.target.value)}>
    <option value="">{empty}</option>
    {shown.map((l) => <option key={l.publicId} value={l.publicId}>{locationLabel(l)} ({LOCATION_TYPE_LABEL[l.type]})</option>)}</select>;
}

/**
 * Search a company's active items by code or name (2+ letters) and pick one; the chosen item shows in the box with × to
 * clear. stockedOnly: only items kept in stock (documents).
 */
export function ItemSearch({ id, company, label = 'Item', stockedOnly = true, initial, onPick, className = 'span-two' }: {
  id: string; company: string; label?: string; stockedOnly?: boolean; initial?: Item | null; onPick: (item: Item | null) => void; className?: string;
}) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Item | null>(initial ?? null);
  const [error, setError] = useState('');
  const box = useRef<HTMLLabelElement>(null);

  useEffect(() => {
    if (chosen || text.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => {
      const q = new URLSearchParams({ search: text.trim(), status: 'active', pageSize: '8', ...(company && { company }), ...(stockedOnly && { stocked: 'true' }) });
      api<ItemList>(`/inventory/items?${q}`).then((r) => { setFound(r.items); setOpen(true); setError(''); }).catch((e) => setError(errText(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [text, chosen, company, stockedOnly]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const pick = (i: Item | null) => { setChosen(i); setText(''); setOpen(false); onPick(i); };

  return <label className={`${className} person-search`} ref={box}>{label}
    <span className="person-search-box">
      <input id={id} className="input" value={chosen ? `${chosen.code} · ${chosen.name}` : text} readOnly={!!chosen} placeholder="Type an item code or name" autoComplete="off"
        onChange={(e) => setText(e.target.value)} onFocus={() => found.length && setOpen(true)} />
      {chosen && <button type="button" className="person-clear" onClick={() => pick(null)} aria-label="Clear"><X size={15} /></button>}
    </span>
    {open && !chosen && text.trim().length >= 2 && <ul className="person-results" role="listbox">
      {found.length ? found.map((i) => <li key={i.publicId} role="option" aria-selected="false" onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
        <b>{i.code} · {i.name}</b><small>{[i.company, i.baseUnit.code, i.tracking !== 'none' ? i.tracking : ''].filter(Boolean).join(' · ')}</small></li>)
        : <li className="none">No item found</li>}
    </ul>}
    {error && <small className="field-error">{error}</small>}
  </label>;
}

/** Previous / next page under a paged list. */
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  if (total <= pageSize) return null;
  const last = Math.ceil(total / pageSize);
  return <div className="pager"><span>Page {page} of {last} · {total} in all</span>
    <button type="button" className="outline-btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
    <button type="button" className="outline-btn" disabled={page >= last} onClick={() => onPage(page + 1)}>Next</button></div>;
}

/** Save a text file in the browser (a CSV template). */
function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Import items or locations from a CSV: check the file first (nothing saved: every row with what would happen), then
 * import. A file with any invalid row is refused whole and its problems listed by row; rows whose code is already used
 * are skipped, so sending the same file again is safe.
 */
export function ImportCsv({ kind, onClose, onImported }: { kind: 'items' | 'locations'; onClose: () => void; onImported: () => void }) {
  const home = useHomeCompany();
  const [picked, setCompany] = useState('');
  const company = picked || home;
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [problems, setProblems] = useState<ImportProblem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const columns = kind === 'items' ? ITEM_CSV_COLUMNS : LOCATION_CSV_COLUMNS;
  const required = kind === 'items' ? 'name, category, unit' : 'code, name, type';

  async function send(dryRun: boolean) {
    if (!file) { setError('Choose the CSV file'); return; }
    const body = new FormData();
    body.append('file', file); body.append('company', company); body.append('dryRun', String(dryRun));
    setBusy(true); setError(''); setProblems([]); setResult(null);
    try {
      const r = await api<ImportResult>(`/inventory/${kind}/import`, { method: 'POST', body });
      setResult(r);
      if (!dryRun) onImported();
    } catch (e) {
      setError(errText(e));
      if (e instanceof ApiFailure && e.api.code === 'INVENTORY_IMPORT_INVALID' && Array.isArray(e.api.details)) setProblems(e.api.details as ImportProblem[]);
    } finally { setBusy(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void send(false); };

  return <Modal title={`Import ${kind} from CSV`} subtitle={`Header row first; required columns: ${required}. Check the file before importing.`} onClose={onClose} wide>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      {result && <Notice tone="ok">{result.dryRun ? `Checked: ${result.created} would be added, ${result.skipped} skipped. Nothing was saved yet.`
        : `Imported: ${result.created} added, ${result.skipped} skipped.`}</Notice>}
      <div className="form-grid">
        <CompanySelect id="imp-company" value={company} onChange={(c) => { setCompany(c); setResult(null); }} />
        <label>CSV file<input id="imp-file" type="file" accept=".csv,text/csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setProblems([]); }} /></label>
        <p className="span-two muted-text">Columns: {columns.join(', ')}.{' '}
          <button type="button" className="text-btn" onClick={() => saveText(`${kind}-template.csv`, `${columns.join(',')}\n`)}><Download size={12} /> Template</button></p>
        {problems.length > 0 && <div className="import-result table-wrap"><table><thead><tr><th>ROW</th><th>COLUMN</th><th>PROBLEM</th></tr></thead>
          <tbody>{problems.map((p, i) => <tr key={i}><td>{p.row}</td><td>{p.field}</td><td>{p.message}</td></tr>)}</tbody></table></div>}
        {result && result.rows.length > 0 && <div className="import-result table-wrap"><table><thead><tr><th>ROW</th><th>CODE</th><th>NAME</th><th>RESULT</th></tr></thead>
          <tbody>{result.rows.map((r) => <tr key={r.row}><td>{r.row}</td><td>{r.code}</td><td>{r.name}</td>
            <td><Badge tone={r.result === 'created' ? 'green' : 'gray'}>{result.dryRun && r.result === 'created' ? 'will be added' : r.result}</Badge>
              {r.reason && <small className="sub">{r.reason}</small>}</td></tr>)}</tbody></table></div>}
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        <button type="button" className="outline-btn" disabled={busy || !file} onClick={() => void send(true)}>{busy ? 'Checking…' : 'Check file'}</button>
        <button className="primary-btn" disabled={busy || !file}>{busy ? 'Importing…' : 'Import'}</button></div>
    </form>
  </Modal>;
}
