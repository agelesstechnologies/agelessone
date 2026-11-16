import { useState } from 'react';
import { Plus } from 'lucide-react';
import { CreateCategoryRequest, CreateUnitRequest, UpdateCategoryRequest, UpdateUnitRequest, type Category, type Unit } from '@ageless/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { useLoad, uuidv7 } from '../../hooks';
import { INVENTORY } from '../../permissions';
import { CompanyFilter, Empty, FieldError, FormModal, Loading, Notice, PageHead, Panel, Tabs } from '../../ui';
import { CompanySelect, StatusBadge, useHomeCompany } from './common';

type TabKey = 'units' | 'categories';

/** Inventory set-up: each company's units (pcs, m, kg) and item categories (whose code prefix starts the item codes). */
export default function InventorySetup() {
  const [tab, setTab] = useState<TabKey>('categories');
  return <>
    <PageHead eyebrow="INVENTORY • SETUP" title="Units and categories" subtitle="What items are counted in, and how they are grouped. Each company keeps its own." />
    <Tabs tabs={[{ key: 'categories', label: 'Categories' }, { key: 'units', label: 'Units' }]} value={tab} onChange={setTab} />
    {tab === 'units' ? <Units /> : <Categories />}
  </>;
}

function StatusFilter({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return <label className="inline-field">Status<select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
    <option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>;
}

function Units() {
  const manage = useAuth().can(INVENTORY.items);
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState('active');
  const [dialog, setDialog] = useState<Unit | 'new' | null>(null);
  const q = useLoad(() => api<Unit[]>(`/inventory/units?${new URLSearchParams({ ...(company && { company }), ...(status && { status }) })}`), [company, status]);
  const done = () => { setDialog(null); q.reload(); };
  return <Panel title="Units" note="Decimals: 0 for pieces, 2 for metres, 3 for kilograms. A unit's code never changes."
    action={manage ? <button className="primary-btn" onClick={() => setDialog('new')}><Plus size={16} /> Add unit</button> : undefined}>
    <div className="panel-body">
      <div className="filters"><CompanyFilter id="un-company" value={company} onChange={setCompany} /><StatusFilter id="un-status" value={status} onChange={setStatus} /></div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No units" text={manage ? 'Add the units items are counted in, such as pcs, m or kg.' : undefined} /> :
        <div className="table-wrap"><table><thead><tr><th>CODE</th><th>NAME</th><th>COMPANY</th><th>DECIMALS</th><th>STATUS</th>{manage && <th />}</tr></thead>
          <tbody>{q.data.map((u) => <tr key={u.publicId}><td><b>{u.code}</b></td><td>{u.name}</td><td>{u.company}</td><td>{u.decimals}</td><td><StatusBadge status={u.status} /></td>
            {manage && <td><button className="text-btn" onClick={() => setDialog(u)}>Edit</button></td>}</tr>)}</tbody></table></div>}
    </div>
    {dialog === 'new' && <NewUnit onClose={() => setDialog(null)} onSaved={done} />}
    {dialog && dialog !== 'new' && <EditUnit unit={dialog} onClose={() => setDialog(null)} onSaved={done} />}
  </Panel>;
}

function NewUnit({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const home = useHomeCompany();
  const [picked, setCompany] = useState('');
  const company = picked || home;
  return <FormModal title="Add a unit" submitLabel="Add unit" onClose={onClose} run={(f) => {
    const parsed = CreateUnitRequest.safeParse({ publicId: id, company, code: String(f.get('code')), name: String(f.get('name')), decimals: Number(f.get('decimals')) });
    return parsed.success ? api('/inventory/units', { method: 'POST', json: parsed.data }).then(onSaved) : parsed.error;
  }}>
    <CompanySelect id="nu-company" value={company} onChange={setCompany} />
    <label>Code<input id="nu-code" name="code" required maxLength={12} placeholder="pcs" /><FieldError name="code" /></label>
    <label>Name<input id="nu-name" name="name" required maxLength={40} placeholder="Pieces" /><FieldError name="name" /></label>
    <label>Decimals<select id="nu-decimals" name="decimals" defaultValue="0">{[0, 1, 2, 3, 4].map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
  </FormModal>;
}

function EditUnit({ unit, onClose, onSaved }: { unit: Unit; onClose: () => void; onSaved: () => void }) {
  return <FormModal title="Edit unit" subtitle={`${unit.company} · ${unit.code}`} submitLabel="Save" onClose={onClose} run={(f) => {
    const name = String(f.get('name')).trim();
    const decimals = Number(f.get('decimals'));
    const status = String(f.get('status'));
    const parsed = UpdateUnitRequest.safeParse({ ...(name !== unit.name && { name }), ...(decimals !== unit.decimals && { decimals }), ...(status !== unit.status && { status }) });
    return parsed.success ? api(`/inventory/units/${unit.publicId}`, { method: 'PATCH', json: parsed.data }).then(onSaved) : 'Change something first';
  }}>
    <label className="span-two">Name<input id="eu-name" name="name" required maxLength={40} defaultValue={unit.name} /><FieldError name="name" /></label>
    <label>Decimals<select id="eu-decimals" name="decimals" defaultValue={unit.decimals}>{[0, 1, 2, 3, 4].map((d) => <option key={d} value={d}>{d}</option>)}</select>
      <small className="sub">Only while no item uses the unit.</small></label>
    <label>Status<select id="eu-status" name="status" defaultValue={unit.status}><option value="active">Active</option><option value="inactive">Inactive (no new items)</option></select></label>
  </FormModal>;
}

function Categories() {
  const manage = useAuth().can(INVENTORY.items);
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState('active');
  const [dialog, setDialog] = useState<Category | 'new' | null>(null);
  const q = useLoad(() => api<Category[]>(`/inventory/categories?${new URLSearchParams({ ...(company && { company }), ...(status && { status }) })}`), [company, status]);
  const done = () => { setDialog(null); q.reload(); };
  return <Panel title="Item categories" note="The code prefix starts the codes of the category's items (EC → EC-0001) and never changes."
    action={manage ? <button className="primary-btn" onClick={() => setDialog('new')}><Plus size={16} /> Add category</button> : undefined}>
    <div className="panel-body">
      <div className="filters"><CompanyFilter id="cat-company" value={company} onChange={setCompany} /><StatusFilter id="cat-status" value={status} onChange={setStatus} /></div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No categories" /> :
        <div className="table-wrap"><table><thead><tr><th>NAME</th><th>PREFIX</th><th>COMPANY</th><th>ITEMS</th><th>STATUS</th>{manage && <th />}</tr></thead>
          <tbody>{q.data.map((c) => <tr key={c.publicId}><td><b>{c.name}</b></td><td>{c.codePrefix}</td><td>{c.company}</td><td>{c.itemCount}</td><td><StatusBadge status={c.status} /></td>
            {manage && <td><button className="text-btn" onClick={() => setDialog(c)}>Edit</button></td>}</tr>)}</tbody></table></div>}
    </div>
    {dialog === 'new' && <NewCategory onClose={() => setDialog(null)} onSaved={done} />}
    {dialog && dialog !== 'new' && <EditCategory category={dialog} onClose={() => setDialog(null)} onSaved={done} />}
  </Panel>;
}

function NewCategory({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const home = useHomeCompany();
  const [picked, setCompany] = useState('');
  const company = picked || home;
  return <FormModal title="Add a category" submitLabel="Add category" onClose={onClose} run={(f) => {
    const parsed = CreateCategoryRequest.safeParse({ publicId: id, company, name: String(f.get('name')), codePrefix: String(f.get('prefix')) });
    return parsed.success ? api('/inventory/categories', { method: 'POST', json: parsed.data }).then(onSaved) : parsed.error;
  }}>
    <CompanySelect id="nc-company" value={company} onChange={setCompany} />
    <label>Code prefix<input id="nc-prefix" name="prefix" required maxLength={6} placeholder="EC" /><FieldError name="codePrefix" /></label>
    <label className="span-two">Name<input id="nc-name" name="name" required maxLength={60} placeholder="Electrical components" /><FieldError name="name" /></label>
  </FormModal>;
}

function EditCategory({ category, onClose, onSaved }: { category: Category; onClose: () => void; onSaved: () => void }) {
  return <FormModal title="Edit category" subtitle={`${category.company} · ${category.codePrefix}`} submitLabel="Save" onClose={onClose} run={(f) => {
    const name = String(f.get('name')).trim();
    const status = String(f.get('status'));
    const parsed = UpdateCategoryRequest.safeParse({ ...(name !== category.name && { name }), ...(status !== category.status && { status }) });
    return parsed.success ? api(`/inventory/categories/${category.publicId}`, { method: 'PATCH', json: parsed.data }).then(onSaved) : 'Change something first';
  }}>
    <label className="span-two">Name<input id="ec-name" name="name" required maxLength={60} defaultValue={category.name} /><FieldError name="name" /></label>
    <label className="span-two">Status<select id="ec-status" name="status" defaultValue={category.status}>
      <option value="active">Active</option><option value="inactive">Inactive (no new items; its items keep it)</option></select></label>
  </FormModal>;
}
