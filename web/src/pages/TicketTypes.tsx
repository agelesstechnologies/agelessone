import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import {
  CreateTicketTypeRequest, UpdateTicketTypeRequest,
  type CompletionRules, type Department, type TicketField, type TicketType, type TicketTypeDetail,
} from '@ageless/shared';
import { api, errText, formError } from '../api';
import { useAuth } from '../auth';
import { useLoad, uuidv7 } from '../hooks';
import { TICKET_TYPES } from '../permissions';
import { Badge, Empty, Loading, Modal, Notice, Panel } from '../ui';

const COMPANIES = [{ code: 'AE', name: 'Ageless Entertainments' }, { code: 'ATPL', name: 'Ageless Technologies' }];
const FIELD_TYPES = ['text', 'number', 'date', 'money', 'file', 'person', 'customer'] as const;
const RULES: { key: keyof CompletionRules; label: string }[] = [
  { key: 'photo_required', label: 'A photo is required' }, { key: 'file_required', label: 'A file is required' },
  { key: 'checklist_required', label: 'Checklist must be answered' }, { key: 'customer_signoff_required', label: 'Customer sign-off is required' },
  { key: 'head_approval_required', label: 'Head approval is required' }, { key: 'daily_update_required', label: 'A daily update is required' },
];

export default function TicketTypes() {
  const { can } = useAuth();
  const manage = can(TICKET_TYPES.manage);
  const [company, setCompany] = useState('');
  const [active, setActive] = useState('true');
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'edit'; id: string } | null>(null);
  const [error, setError] = useState('');
  const q = useLoad(() => api<TicketType[]>(`/tickets/types?${new URLSearchParams({ ...(company && { company }), ...(active && { active }) })}`), [company, active]);

  async function toggle(t: TicketType) {
    setError('');
    try { await api(`/tickets/types/${t.publicId}/${t.active ? 'deactivate' : 'reactivate'}`, { method: 'POST', json: {} }); q.reload(); } catch (e) { setError(errText(e)); }
  }
  return <Panel title="Ticket types" note="What each kind of work asks for and what it needs to be completed. Editing a type makes a new version."
    action={manage ? <button className="primary-btn" onClick={() => setDialog({ kind: 'new' })}><Plus size={16} /> New type</button> : undefined}>
    <div className="panel-body">
      <div className="filters">
        <label className="inline-field">Company<select id="tt-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
          <option value="">All</option>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <label className="inline-field">Show<select id="tt-active" className="input" value={active} onChange={(e) => setActive(e.target.value)}>
          <option value="true">Active</option><option value="false">Inactive</option><option value="">All</option></select></label>
      </div>
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No ticket types" /> :
        <div className="table-wrap"><table><thead><tr><th>NAME</th><th>CODE</th><th>COMPANY</th><th>OWNER</th><th>VERSION</th><th>STATUS</th>{manage && <th />}</tr></thead>
          <tbody>{q.data.map((t) => <tr key={t.publicId}>
            <td><b>{t.name}</b>{t.isStandard && <small className="sub">standard</small>}</td><td>{t.code}</td><td>{t.company}</td>
            <td>{t.ownerDepartment?.name ?? 'Company-wide'}</td><td>v{t.version}</td><td><Badge tone={t.active ? 'green' : 'gray'}>{t.active ? 'active' : 'inactive'}</Badge></td>
            {manage && <td><span className="chip-row">
              <button className="text-btn" onClick={() => setDialog({ kind: 'edit', id: t.publicId })}>{t.isStandard ? 'View' : 'Edit'}</button>
              <button className="text-btn" onClick={() => void toggle(t)}>{t.active ? 'Deactivate' : 'Reactivate'}</button></span></td>}</tr>)}</tbody></table></div>}
    </div>
    {dialog?.kind === 'new' && <TypeForm onClose={() => setDialog(null)} onSaved={() => { setDialog(null); q.reload(); }} />}
    {dialog?.kind === 'edit' && <EditType id={dialog.id} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); q.reload(); }} />}
  </Panel>;
}

function EditType({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const q = useLoad(() => api<TicketTypeDetail>(`/tickets/types/${id}`), [id]);
  if (!q.data) return <Modal title="Ticket type" onClose={onClose}>{q.error ? <Notice>{q.error}</Notice> : <Loading />}</Modal>;
  return <TypeForm existing={q.data} onClose={onClose} onSaved={onSaved} />;
}

/** Create a type, or save a new version of one. Fields are written one per line as `key | label | type | required`. */
function TypeForm({ existing, onClose, onSaved }: { existing?: TicketTypeDetail; onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const [company, setCompany] = useState(existing?.company ?? COMPANIES[0]!.code);
  const depts = useLoad(() => api<Department[]>(`/hrms/departments?company=${company}`), [company]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const locked = !!existing?.isStandard;
  const fieldsText = (existing?.fields ?? []).map((f) => `${f.key} | ${f.label} | ${f.type} | ${f.required ? 'required' : 'optional'}`).join('\n');

  function readFields(raw: string): TicketField[] | string {
    const out: TicketField[] = [];
    for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [key = '', label = '', type = 'text', req = 'optional'] = line.split('|').map((x) => x.trim());
      if (!(FIELD_TYPES as readonly string[]).includes(type)) return `Field "${key}": type must be one of ${FIELD_TYPES.join(', ')}`;
      out.push({ key, label, type: type as TicketField['type'], required: req === 'required' });
    }
    return out;
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked) return;
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const fields = readFields(text('fields'));
    if (typeof fields === 'string') { setError(fields); return; }
    const completionRules = Object.fromEntries(RULES.map((r) => [r.key, f.get(r.key) === 'on'])) as CompletionRules;
    const checklistItems = text('checklist').split('\n').map((l) => l.trim()).filter(Boolean);
    const owner = text('owner');
    const shared = { name: text('name'), sortOrder: Number(f.get('sort')) || 100, fields, completionRules, checklistItems };
    const parsed = existing
      ? UpdateTicketTypeRequest.safeParse({ ...shared, expectedVersion: existing.version, ownerDepartmentPublicId: owner || null })
      : CreateTicketTypeRequest.safeParse({ ...shared, publicId: id, company, code: text('code'), ...(owner ? { ownerDepartmentPublicId: owner } : {}) });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { await api(existing ? `/tickets/types/${existing.publicId}` : '/tickets/types', { method: existing ? 'PATCH' : 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }

  return <Modal title={existing ? `${existing.name} · v${existing.version}` : 'New ticket type'}
    subtitle={locked ? 'A standard type cannot be changed.' : existing ? 'Saving a change makes a new version. Open tickets keep the version they started with.' : undefined} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        {!existing && <label>Company<select id="ty-company" value={company} onChange={(e) => setCompany(e.target.value)}>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>}
        {!existing && <label>Code<input id="ty-code" name="code" required placeholder="site_visit" /></label>}
        <label>Name<input id="ty-name" name="name" required minLength={2} maxLength={80} defaultValue={existing?.name} disabled={locked} /></label>
        <label>Sort order<input id="ty-sort" name="sort" type="number" min={0} defaultValue={existing?.sortOrder ?? 100} disabled={locked} /></label>
        <label className="span-two">Owning department <span className="optional">empty = company-wide (admin and Management only)</span>
          <select id="ty-owner" name="owner" defaultValue={existing?.ownerDepartment?.publicId ?? ''} key={`o${company}${depts.data?.length ?? 0}`} disabled={locked}>
            <option value="">Company-wide</option>{depts.data?.map((d) => <option key={d.publicId} value={d.publicId}>{d.name}</option>)}</select></label>
        <label className="span-two">Fields <span className="optional">one per line: key | label | type | required</span>
          <textarea id="ty-fields" name="fields" rows={4} defaultValue={fieldsText} disabled={locked} placeholder={'customer_name | Customer | customer | required\nvisit_date | Visit date | date | optional'} /></label>
        <label className="span-two">Checklist <span className="optional">one item per line</span>
          <textarea id="ty-checklist" name="checklist" rows={3} defaultValue={existing?.checklistItems.join('\n')} disabled={locked} /></label>
        <fieldset className="span-two" disabled={locked}><legend>To complete a ticket of this type</legend>
          {RULES.map((r) => <label key={r.key} className="check-row"><input name={r.key} type="checkbox" defaultChecked={existing?.completionRules[r.key]} /> {r.label}</label>)}</fieldset>
      </div>
      {existing && <div className="detail-section"><h3>Versions</h3>{existing.versions.map((v) =>
        <div className="detail-row" key={v.version}><span>v{v.version}{v.isCurrent ? ' · current' : ''} · {v.createdBy.displayName}</span><b>{new Date(v.createdAt).toLocaleDateString('en-IN')}</b></div>)}</div>}
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        {!locked && <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : existing ? 'Save new version' : 'Create type'}</button>}</div>
    </form>
  </Modal>;
}
