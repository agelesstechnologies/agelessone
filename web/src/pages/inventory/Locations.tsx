import { useState } from 'react';
import { Plus, Upload } from 'lucide-react';
import { CreateLocationRequest, LocationType, UpdateLocationRequest, type Location } from '@ageless/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { useLoad, uuidv7 } from '../../hooks';
import { PersonPicker } from '../../JobPicker';
import { INVENTORY } from '../../permissions';
import { CompanyFilter, Empty, FieldError, FormModal, Loading, Notice, PageHead, Panel } from '../../ui';
import { CompanySelect, ImportCsv, LOCATION_TYPE_LABEL, locationLabel, StatusBadge, useHomeCompany, useLocations } from './common';

/** Which types a rack or bin may sit in; every other type stands on its own. */
const PARENT_TYPES: Partial<Record<LocationType, LocationType[]>> = { rack: ['store'], bin: ['store', 'rack'] };

/** The locations as a tree: each one followed by the racks and bins inside it. A parent the person cannot see makes a root. */
function tree(list: Location[]): { l: Location; depth: number }[] {
  const ids = new Set(list.map((l) => l.publicId));
  const kids = new Map<string, Location[]>();
  for (const l of list) {
    const p = l.parent && ids.has(l.parent.publicId) ? l.parent.publicId : '';
    kids.set(p, [...(kids.get(p) ?? []), l]);
  }
  const out: { l: Location; depth: number }[] = [];
  const walk = (parent: string, depth: number) => {
    for (const l of (kids.get(parent) ?? []).sort((a, b) => a.code.localeCompare(b.code))) { out.push({ l, depth }); walk(l.publicId, depth + 1); }
  };
  walk('', 0);
  return out;
}

/**
 * Store locations of each company as a tree (stores with their racks and bins, work areas, testing, transit, quarantine,
 * scrap) and who looks after each. A storekeeper (scope own) sees only the locations they look after.
 */
export default function Locations() {
  const { can, scopeOf } = useAuth();
  const manage = can(INVENTORY.locations);
  const adds = manage && scopeOf(INVENTORY.locations) !== 'own';
  const [company, setCompany] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('active');
  const [dialog, setDialog] = useState<Location | 'new' | 'import' | null>(null);
  const q = useLoad(() => api<Location[]>(`/inventory/locations?${new URLSearchParams({ ...(company && { company }), ...(type && { type }), ...(status && { status }) })}`),
    [company, type, status]);
  const done = () => { setDialog(null); q.reload(); };
  const rows = tree(q.data ?? []);

  return <>
    <PageHead eyebrow="INVENTORY • LOCATIONS" title="Store locations" subtitle="Where stock sits, and who looks after it. Racks and bins fall back to their store's custodian."
      action={adds ? <div className="chip-row">
        <button className="outline-btn" onClick={() => setDialog('import')}><Upload size={14} /> Import CSV</button>
        <button className="primary-btn" onClick={() => setDialog('new')}><Plus size={16} /> Add location</button></div> : undefined} />
    <Panel>
      <div className="panel-body">
        <div className="filters">
          <CompanyFilter id="loc-company" value={company} onChange={setCompany} />
          <label className="inline-field">Type<select id="loc-type" className="input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>{LocationType.options.map((t) => <option key={t} value={t}>{LOCATION_TYPE_LABEL[t]}</option>)}</select></label>
          <label className="inline-field">Status<select id="loc-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        </div>
        {scopeOf(INVENTORY.view) === 'own' && <p className="muted-text">You see the locations you look after.</p>}
        {q.error && <Notice>{q.error}</Notice>}
        {q.loading && !q.data ? <Loading /> : !rows.length ? <Empty title="No locations" text={adds ? 'Add the stores, racks and bins, or import a CSV.' : undefined} /> :
          <div className="table-wrap"><table><thead><tr><th>LOCATION</th><th>TYPE</th><th>COMPANY</th><th>LOOKED AFTER BY</th><th>STATUS</th>{manage && <th />}</tr></thead>
            <tbody>{rows.map(({ l, depth }) => <tr key={l.publicId}>
              <td><span className={`loc-name loc-depth-${Math.min(depth, 3)}`}>{depth > 0 && <span className="muted-text">└</span>}<b>{l.code}</b> {l.name}</span></td>
              <td>{LOCATION_TYPE_LABEL[l.type]}</td><td>{l.company}</td>
              <td>{l.responsible ? <>{l.responsible.person.displayName}<small className="sub">{l.custodian ? l.responsible.employeeCode : `from ${l.parent?.code ?? 'parent'}`}</small></> : '—'}</td>
              <td><StatusBadge status={l.status} /></td>
              {manage && <td><button className="text-btn" onClick={() => setDialog(l)}>Edit</button></td>}</tr>)}</tbody></table></div>}
      </div>
    </Panel>
    {dialog === 'new' && <NewLocation onClose={() => setDialog(null)} onSaved={done} />}
    {dialog === 'import' && <ImportCsv kind="locations" onClose={() => setDialog(null)} onImported={q.reload} />}
    {dialog && typeof dialog === 'object' && <EditLocation location={dialog} onClose={() => setDialog(null)} onSaved={done} />}
  </>;
}

function NewLocation({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const home = useHomeCompany();
  const [picked, setCompany] = useState('');
  const company = picked || home;
  const [type, setType] = useState<LocationType>('store');
  const [custodian, setCustodian] = useState('');
  const locations = useLocations(company);
  const parentTypes = PARENT_TYPES[type];
  const parents = (locations.data ?? []).filter((l) => parentTypes?.includes(l.type)).sort((a, b) => a.code.localeCompare(b.code));
  return <FormModal title="Add a location" subtitle="Type and parent never change. Racks and bins may leave the custodian empty: their parent's answers for them."
    submitLabel="Add location" onClose={onClose} run={(f) => {
      const parsed = CreateLocationRequest.safeParse({ publicId: id, company, type, code: String(f.get('code')), name: String(f.get('name')),
        parentPublicId: parentTypes ? String(f.get('parent') ?? '') || undefined : undefined, custodianPersonPublicId: custodian || undefined });
      return parsed.success ? api('/inventory/locations', { method: 'POST', json: parsed.data }).then(onSaved) : parsed.error;
    }}>
    <CompanySelect id="nl-company" value={company} onChange={setCompany} />
    <label>Type<select id="nl-type" value={type} onChange={(e) => setType(e.target.value as LocationType)}>
      {LocationType.options.map((t) => <option key={t} value={t}>{LOCATION_TYPE_LABEL[t]}</option>)}</select></label>
    <label>Code<input id="nl-code" name="code" required maxLength={30} placeholder="STORE-A" /><FieldError name="code" /></label>
    <label>Name<input id="nl-name" name="name" required maxLength={80} placeholder="Main store" /><FieldError name="name" /></label>
    {parentTypes && <label className="span-two">Inside<select id="nl-parent" name="parent" required defaultValue="" key={`${company}-${type}`}>
      <option value="">{locations.loading ? 'Loading…' : `Choose a ${parentTypes.join(' or ')}`}</option>
      {parents.map((l) => <option key={l.publicId} value={l.publicId}>{locationLabel(l)} ({LOCATION_TYPE_LABEL[l.type]})</option>)}</select><FieldError name="parentPublicId" /></label>}
    <PersonPicker idPrefix="nl-custodian" label="Custodian" hint={parentTypes ? 'optional: falls back to the parent' : 'a person with a current job in the company'} onChange={setCustodian} />
    <FieldError name="custodianPersonPublicId" />
  </FormModal>;
}

function EditLocation({ location, onClose, onSaved }: { location: Location; onClose: () => void; onSaved: () => void }) {
  const [custodian, setCustodian] = useState<string | null | undefined>(undefined);   // undefined: unchanged; null: clear
  const fallsBack = location.type === 'rack' || location.type === 'bin';
  return <FormModal title="Edit location" subtitle={`${location.company} · ${location.code} · ${LOCATION_TYPE_LABEL[location.type]}${location.parent ? ` in ${location.parent.code}` : ''}`}
    submitLabel="Save" onClose={onClose} run={(f) => {
      const name = String(f.get('name')).trim();
      const status = String(f.get('status'));
      const parsed = UpdateLocationRequest.safeParse({ ...(name !== location.name && { name }), ...(custodian !== undefined && { custodianPersonPublicId: custodian }),
        ...(status !== location.status && { status }) });
      return parsed.success ? api(`/inventory/locations/${location.publicId}`, { method: 'PATCH', json: parsed.data }).then(onSaved) : 'Change something first';
    }}>
    <label className="span-two">Name<input id="el-name" name="name" required maxLength={80} defaultValue={location.name} /><FieldError name="name" /></label>
    <p className="span-two muted-text">Custodian: {location.custodian?.person.displayName ?? (location.responsible ? `none (falls back to ${location.responsible.person.displayName})` : 'none')}
      {custodian === null ? ' — will be cleared' : custodian ? ' — will change' : ''}</p>
    <PersonPicker idPrefix="el-custodian" label="New custodian" hint="optional" onChange={(p) => setCustodian(p || undefined)} />
    {fallsBack && location.custodian && <label className="span-two check-row"><input type="checkbox" checked={custodian === null}
      onChange={(e) => setCustodian(e.target.checked ? null : undefined)} /> Clear: the parent's custodian answers for it</label>}
    <label className="span-two">Status<select id="el-status" name="status" defaultValue={location.status}>
      <option value="active">Active</option><option value="inactive">Inactive (only when it holds no stock)</option></select></label>
  </FormModal>;
}
