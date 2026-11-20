import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Plus, Upload } from 'lucide-react';
import {
  CopyItemRequest, CreateItemRequest, UpdateItemRequest,
  type Category, type Item, type ItemList, type ItemTracking, type Unit,
} from '@ageless/shared';
import { api, errText, formError } from '../../api';
import { useAuth } from '../../auth';
import { useLoad, uuidv7 } from '../../hooks';
import { INVENTORY } from '../../permissions';
import { COMPANIES, CompanyFilter, Empty, FieldError, fieldErrors, Loading, Modal, Notice, PageHead, Panel, type FieldErrors } from '../../ui';
import { CompanySelect, ImportCsv, ItemSearch, LocationSelect, Pager, qty, StatusBadge, USABLE, useHomeCompany, useLocations } from './common';

const PAGE_SIZE = 50;
const TRACKING_LABEL: Record<ItemTracking, string> = { none: 'Quantity only', batch: 'By batch', serial: 'By serial number' };

/** Each company's items: code, category, units and conversions, tracking, reorder level and default location. */
export default function Items() {
  const manage = useAuth().can(INVENTORY.items);
  const [company, setCompany] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('active');
  const [tracking, setTracking] = useState('');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Item | 'new' | 'copy' | 'import' | null>(null);
  useEffect(() => { const t = setTimeout(() => { setSearch(typed.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [typed]);
  const categories = useLoad(() => (company ? api<Category[]>(`/inventory/categories?company=${company}`) : Promise.resolve([] as Category[])), [company]);
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), ...(company && { company }), ...(category && { category }),
    ...(status && { status }), ...(tracking && { tracking }), ...(search && { search }) });
  const q = useLoad(() => api<ItemList>(`/inventory/items?${params}`), [params.toString()]);
  const filter = (set: (v: string) => void) => (v: string) => { set(v); setPage(1); };
  const done = () => { setDialog(null); q.reload(); };

  return <>
    <PageHead eyebrow="INVENTORY • ITEMS" title="Items" subtitle="Parts and materials of each company: units, tracking and when to reorder."
      action={manage ? <div className="chip-row">
        <button className="outline-btn" onClick={() => setDialog('import')}><Upload size={14} /> Import CSV</button>
        <button className="outline-btn" onClick={() => setDialog('copy')}><Copy size={14} /> Copy from other company</button>
        <button className="primary-btn" onClick={() => setDialog('new')}><Plus size={16} /> Add item</button></div> : undefined} />
    <Panel>
      <div className="panel-body">
        <div className="filters">
          <CompanyFilter id="it-company" value={company} onChange={(v) => { setCompany(v); setCategory(''); setPage(1); }} />
          {company && <label className="inline-field">Category<select id="it-category" className="input" value={category} onChange={(e) => filter(setCategory)(e.target.value)}>
            <option value="">All</option>{categories.data?.map((c) => <option key={c.publicId} value={c.publicId}>{c.name}</option>)}</select></label>}
          <label className="inline-field">Status<select id="it-status" className="input" value={status} onChange={(e) => filter(setStatus)(e.target.value)}>
            <option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
          <label className="inline-field">Tracking<select id="it-tracking" className="input" value={tracking} onChange={(e) => filter(setTracking)(e.target.value)}>
            <option value="">All</option>{Object.entries(TRACKING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="inline-field">Search<input id="it-search" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Code or name" /></label>
        </div>
        {q.error && <Notice>{q.error}</Notice>}
        {q.loading && !q.data ? <Loading /> : !q.data?.items.length ? <Empty title="No items" text={manage ? 'Add items one by one, or import a CSV.' : undefined} /> : <>
          <div className="table-wrap"><table><thead><tr><th>CODE</th><th>NAME</th><th>CATEGORY</th><th>UNIT</th><th>TRACKING</th><th>REORDER</th><th>DEFAULT LOCATION</th><th>STATUS</th>{manage && <th />}</tr></thead>
            <tbody>{q.data.items.map((i) => <tr key={i.publicId}>
              <td><b>{i.code}</b><small className="sub">{i.company}</small></td>
              <td>{i.name}{i.description && <small className="sub">{i.description}</small>}{!i.isStocked && <small className="sub">not kept in stock</small>}</td>
              <td>{i.category.name}</td>
              <td>{i.baseUnit.code}{i.conversions.map((c) => <small key={c.unit.publicId} className="sub">1 {c.unit.code} = {qty(c.factor)} {i.baseUnit.code}</small>)}</td>
              <td>{TRACKING_LABEL[i.tracking]}</td>
              <td>{i.reorderLevel != null ? <>below {qty(i.reorderLevel)}{i.reorderQty != null && <small className="sub">order {qty(i.reorderQty)}</small>}</> : '—'}</td>
              <td>{i.defaultLocation?.code ?? '—'}</td>
              <td><StatusBadge status={i.status} /></td>
              {manage && <td><button className="text-btn" onClick={() => setDialog(i)}>Edit</button></td>}</tr>)}</tbody></table></div>
          <Pager page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} /></>}
      </div>
    </Panel>
    {dialog === 'new' && <ItemForm onClose={() => setDialog(null)} onSaved={done} />}
    {dialog === 'copy' && <CopyItem onClose={() => setDialog(null)} onSaved={done} />}
    {dialog === 'import' && <ImportCsv kind="items" onClose={() => setDialog(null)} onImported={q.reload} />}
    {dialog && typeof dialog === 'object' && <ItemForm item={dialog} onClose={() => setDialog(null)} onSaved={done} />}
  </>;
}

type ConversionRow = { unitPublicId: string; factor: string };
const numberOrUndefined = (s: string) => (s.trim() === '' ? undefined : Number(s));

/**
 * Add an item, or change one (send only what changed). A non-stocked item (bought for use, never kept in a store) has
 * no tracking, reorder level or default location. Once an item has stock moves its base unit, tracking and stocked
 * setting no longer change (the API says so).
 */
function ItemForm({ item, onClose, onSaved }: { item?: Item; onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const home = useHomeCompany();
  const [picked, setCompany] = useState('');
  const company = item?.company ?? (picked || home);
  const [f, setF] = useState({
    code: '', name: item?.name ?? '', description: item?.description ?? '', category: item?.category.publicId ?? '', baseUnit: item?.baseUnit.publicId ?? '',
    tracking: item?.tracking ?? 'none' as ItemTracking, isStocked: item?.isStocked ?? true, hsn: item?.hsnCode ?? '',
    reorderLevel: item?.reorderLevel != null ? String(item.reorderLevel) : '', reorderQty: item?.reorderQty != null ? String(item.reorderQty) : '',
    defaultLocation: item?.defaultLocation?.publicId ?? '', status: item?.status ?? 'active',
  });
  const [conversions, setConversions] = useState<ConversionRow[]>(item?.conversions.map((c) => ({ unitPublicId: c.unit.publicId, factor: String(c.factor) })) ?? []);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const categories = useLoad(() => api<Category[]>(`/inventory/categories?company=${company}`), [company]);
  const units = useLoad(() => api<Unit[]>(`/inventory/units?company=${company}`), [company]);
  const locations = useLocations(company);
  const set = (patch: Partial<typeof f>) => setF((v) => ({ ...v, ...patch }));
  // inactive categories and units stay listed only when the item already uses them
  const activeCategories = (categories.data ?? []).filter((c) => c.status === 'active' || c.publicId === f.category);
  const activeUnits = (units.data ?? []).filter((u) => u.status === 'active' || u.publicId === f.baseUnit || conversions.some((c) => c.unitPublicId === u.publicId));
  const convs = conversions.filter((c) => c.unitPublicId).map((c) => ({ unitPublicId: c.unitPublicId, factor: Number(c.factor) }));

  function body(): { ok: true; data: unknown } | { ok: false; error: { issues: { path: (string | number)[]; message: string }[] } | string } {
    const stocked = f.isStocked;
    if (!item) {
      const parsed = CreateItemRequest.safeParse({
        publicId: id, company, code: f.code.trim() || undefined, name: f.name, description: f.description.trim() || undefined, categoryPublicId: f.category,
        baseUnitPublicId: f.baseUnit, tracking: stocked ? f.tracking : 'none', hsnCode: f.hsn.trim() || undefined, isStocked: stocked,
        reorderLevel: stocked ? numberOrUndefined(f.reorderLevel) : undefined, reorderQty: stocked ? numberOrUndefined(f.reorderQty) : undefined,
        defaultLocationPublicId: stocked ? f.defaultLocation || undefined : undefined, conversions: convs,
      });
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: parsed.error };
    }
    const change: Record<string, unknown> = {};
    const nullable = (s: string) => (s.trim() === '' ? null : s.trim());
    if (f.name.trim() !== item.name) change.name = f.name.trim();
    if ((f.description.trim() || null) !== item.description) change.description = nullable(f.description);
    if (f.category !== item.category.publicId) change.categoryPublicId = f.category;
    if (f.baseUnit !== item.baseUnit.publicId) change.baseUnitPublicId = f.baseUnit;
    if (stocked !== item.isStocked) change.isStocked = stocked;
    const tracking = stocked ? f.tracking : 'none';
    if (tracking !== item.tracking) change.tracking = tracking;
    if ((f.hsn.trim() || null) !== item.hsnCode) change.hsnCode = nullable(f.hsn);
    const level = stocked && f.reorderLevel.trim() !== '' ? Number(f.reorderLevel) : null;
    if (level !== item.reorderLevel) change.reorderLevel = level;
    const reorderQty = stocked && f.reorderQty.trim() !== '' ? Number(f.reorderQty) : null;
    if (reorderQty !== item.reorderQty) change.reorderQty = reorderQty;
    const loc = stocked && f.defaultLocation ? f.defaultLocation : null;
    if (loc !== (item.defaultLocation?.publicId ?? null)) change.defaultLocationPublicId = loc;
    const before = item.conversions.map((c) => `${c.unit.publicId}=${c.factor}`).sort().join();
    if (change.baseUnitPublicId || convs.map((c) => `${c.unitPublicId}=${c.factor}`).sort().join() !== before) change.conversions = convs;
    if (f.status !== item.status) change.status = f.status;
    if (!Object.keys(change).length) return { ok: false, error: 'Change something first' };
    const parsed = UpdateItemRequest.safeParse(change);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: parsed.error };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const b = body();
    if (!b.ok) {
      if (typeof b.error === 'string') { setError(b.error); setFields({}); } else { setError(formError(b.error)); setFields(fieldErrors(b.error)); }
      return;
    }
    setBusy(true); setError(''); setFields({});
    try {
      await api(item ? `/inventory/items/${item.publicId}` : '/inventory/items', { method: item ? 'PATCH' : 'POST', json: b.data });
      onSaved();
    } catch (err) { setError(errText(err)); setFields(fieldErrors(err)); } finally { setBusy(false); }
  }

  return <Modal title={item ? 'Edit item' : 'Add an item'} subtitle={item ? `${item.company} · ${item.code}` : 'Leave the code empty to get the next code of the category.'} onClose={onClose} wide>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        {!item && <CompanySelect id="itf-company" value={company} onChange={(c) => { setCompany(c); set({ category: '', baseUnit: '', defaultLocation: '' }); setConversions([]); }} />}
        {!item && <label>Code <span className="optional">optional</span><input id="itf-code" value={f.code} maxLength={30} onChange={(e) => set({ code: e.target.value })} /><FieldError name="code" errors={fields} /></label>}
        <label className="span-two">Name<input id="itf-name" value={f.name} required maxLength={120} onChange={(e) => set({ name: e.target.value })} /><FieldError name="name" errors={fields} /></label>
        <label className="span-two">Description <span className="optional">optional</span><input id="itf-desc" value={f.description} maxLength={1000} onChange={(e) => set({ description: e.target.value })} /><FieldError name="description" errors={fields} /></label>
        <label>Category<select id="itf-category" value={f.category} required onChange={(e) => set({ category: e.target.value })}>
          <option value="">{categories.loading ? 'Loading…' : 'Choose'}</option>{activeCategories.map((c) => <option key={c.publicId} value={c.publicId}>{c.name} ({c.codePrefix})</option>)}</select>
          <FieldError name="categoryPublicId" errors={fields} /></label>
        <label>Base unit<select id="itf-unit" value={f.baseUnit} required onChange={(e) => set({ baseUnit: e.target.value })}>
          <option value="">{units.loading ? 'Loading…' : 'Choose'}</option>{activeUnits.map((u) => <option key={u.publicId} value={u.publicId}>{u.code} · {u.name}</option>)}</select>
          <FieldError name="baseUnitPublicId" errors={fields} /></label>
        <label>HSN / SAC code <span className="optional">optional</span><input id="itf-hsn" value={f.hsn} maxLength={8} inputMode="numeric" onChange={(e) => set({ hsn: e.target.value })} /><FieldError name="hsnCode" errors={fields} /></label>
        <label className="check-row"><input type="checkbox" checked={f.isStocked} onChange={(e) => set({ isStocked: e.target.checked })} /> Kept in stock</label>
        {f.isStocked && <>
          <label>Tracking<select id="itf-tracking" value={f.tracking} onChange={(e) => set({ tracking: e.target.value as ItemTracking })}>
            {Object.entries(TRACKING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><FieldError name="tracking" errors={fields} /></label>
          <label>Default location <span className="optional">optional</span>
            <LocationSelect id="itf-location" locations={locations.data ?? []} types={USABLE} value={f.defaultLocation} onChange={(v) => set({ defaultLocation: v })} empty="None" />
            <FieldError name="defaultLocationPublicId" errors={fields} /></label>
          <label>Reorder below <span className="optional">optional</span><input id="itf-level" type="number" min={0} step="any" value={f.reorderLevel} onChange={(e) => set({ reorderLevel: e.target.value })} />
            <FieldError name="reorderLevel" errors={fields} /></label>
          <label>Reorder quantity <span className="optional">optional</span><input id="itf-rqty" type="number" min={0} step="any" value={f.reorderQty} onChange={(e) => set({ reorderQty: e.target.value })} />
            <FieldError name="reorderQty" errors={fields} /></label>
        </>}
        <div className="span-two">
          <b className="mini-h">Other units</b> <span className="muted-text">A box of 100 pieces: box = 100. A foot in metres: 0.3048.</span>
          {conversions.map((c, i) => <div className="chip-row" key={i}>
            <select id={`itf-conv-unit-${i}`} aria-label="Unit" value={c.unitPublicId} onChange={(e) => setConversions(conversions.map((x, j) => (j === i ? { ...x, unitPublicId: e.target.value } : x)))}>
              <option value="">Unit</option>{activeUnits.filter((u) => u.publicId !== f.baseUnit).map((u) => <option key={u.publicId} value={u.publicId}>{u.code}</option>)}</select>
            <input id={`itf-conv-factor-${i}`} aria-label="Base units in one" type="number" min={0} step="any" placeholder="Base units in one" value={c.factor}
              onChange={(e) => setConversions(conversions.map((x, j) => (j === i ? { ...x, factor: e.target.value } : x)))} />
            <button type="button" className="outline-btn" onClick={() => setConversions(conversions.filter((_, j) => j !== i))}>Remove</button></div>)}
          <FieldError name="conversions" errors={fields} />
          {conversions.length < 10 && <button type="button" className="text-btn" onClick={() => setConversions([...conversions, { unitPublicId: '', factor: '' }])}><Plus size={12} /> Add a unit</button>}
        </div>
        {item && <label className="span-two">Status<select id="itf-status" value={f.status} onChange={(e) => set({ status: e.target.value as typeof f.status })}>
          <option value="active">Active</option><option value="inactive">Inactive (kept, but takes no new use)</option></select></label>}
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={busy}>{busy ? 'Saving…' : item ? 'Save' : 'Add item'}</button></div>
    </form>
  </Modal>;
}

/** A new, separate item in one company made from another company's item: only its description travels. */
function CopyItem({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const home = useHomeCompany();
  const [picked, setCompany] = useState('');
  const company = picked || home;
  const from = COMPANIES.find((c) => c.code !== company)?.code ?? '';
  const [source, setSource] = useState<Item | null>(null);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const categories = useLoad(() => api<Category[]>(`/inventory/categories?company=${company}&status=active`), [company]);
  const units = useLoad(() => api<Unit[]>(`/inventory/units?company=${company}&status=active`), [company]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const parsed = CopyItemRequest.safeParse({ publicId: id, sourceItemPublicId: source?.publicId, company, categoryPublicId: String(fd.get('category')),
      baseUnitPublicId: String(fd.get('unit')) || undefined, code: String(fd.get('code')).trim() || undefined });
    if (!parsed.success) { setError(source ? formError(parsed.error) : 'Choose the item to copy'); setFields(fieldErrors(parsed.error)); return; }
    setBusy(true); setError(''); setFields({});
    try { await api('/inventory/items/copy', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); setFields(fieldErrors(err)); } finally { setBusy(false); }
  }
  return <Modal title="Copy an item from another company" subtitle="Name, description, HSN code, tracking and stocked travel; category, unit and code are this company's own. The two stay unlinked." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <CompanySelect id="cp-company" value={company} onChange={(c) => { setCompany(c); setSource(null); }} />
        <p className="muted-text">Copy from {from}</p>
        <ItemSearch key={from} id="cp-source" company={from} label={`Item of ${from}`} stockedOnly={false} onPick={setSource} />
        <label>Category in {company}<select id="cp-category" name="category" required defaultValue="" key={`c${company}`}>
          <option value="">{categories.loading ? 'Loading…' : 'Choose'}</option>{categories.data?.map((c) => <option key={c.publicId} value={c.publicId}>{c.name}</option>)}</select>
          <FieldError name="categoryPublicId" errors={fields} /></label>
        <label>Base unit <span className="optional">optional</span><select id="cp-unit" name="unit" defaultValue="" key={`u${company}`}>
          <option value="">{source ? `Same code (${source.baseUnit.code})` : 'Same code'}</option>{units.data?.map((u) => <option key={u.publicId} value={u.publicId}>{u.code}</option>)}</select></label>
        <label className="span-two">Code <span className="optional">optional: the next code of the category</span><input id="cp-code" name="code" maxLength={30} /><FieldError name="code" errors={fields} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button><button className="primary-btn" disabled={busy}>{busy ? 'Copying…' : 'Copy item'}</button></div>
    </form>
  </Modal>;
}
