import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import {
  CreateDepartmentRequest, CreatePositionRequest, FillPositionRequest, UpdateDepartmentRequest,
  type Department, type Designation, type PersonList, type Position,
} from '@ageless/shared';
import { api, errText } from '../api';
import { useAuth } from '../auth';
import { dayLabel, useLoad, uuidv7 } from '../hooks';
import JobPicker from '../JobPicker';
import { PEOPLE } from '../permissions';
import { Badge, Empty, Loading, Modal, Notice, PageHead, Panel, Tabs, type Tone } from '../ui';

type TabKey = 'departments' | 'designations' | 'positions';
const COMPANIES = [{ code: 'AE', name: 'Ageless Entertainments' }, { code: 'ATPL', name: 'Ageless Technologies' }];
const POSITION_TONE: Record<string, Tone> = { planned: 'gray', open: 'amber', filled: 'green' };

const CompanyFilter = ({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) =>
  <label className="inline-field">Company
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All</option>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>;

export default function Organisation() {
  const { can } = useAuth();
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'departments', label: 'Departments' },
    { key: 'designations', label: 'Designations' },
    ...(can(PEOPLE.managePositions) || can('hrms.management') ? [{ key: 'positions' as const, label: 'Positions' }] : []),
  ];
  const [tab, setTab] = useState<TabKey>('departments');
  return <>
    <PageHead eyebrow="HRMS • ORGANISATION" title="Organisation" subtitle="Departments, designations and the positions each company plans to fill." />
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'departments' && <Departments />}
    {tab === 'designations' && <Designations />}
    {tab === 'positions' && <Positions />}
  </>;
}

function Departments() {
  const { can } = useAuth();
  const manage = can(PEOPLE.manageEmployments);
  const [company, setCompany] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'edit'; dept: Department } | null>(null);
  const q = useLoad(() => api<Department[]>(`/hrms/departments${company ? `?company=${company}` : ''}`), [company]);
  return <Panel title="Departments" note="The code prefix starts every employee ID in the department."
    action={manage ? <button className="primary-btn" onClick={() => setDialog({ kind: 'new' })}><Plus size={16} /> Add department</button> : undefined}>
    <div className="panel-body">
      <div className="filters"><CompanyFilter id="dept-company" value={company} onChange={setCompany} /></div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No departments" /> :
        <div className="table-wrap"><table><thead><tr><th>NAME</th><th>COMPANY</th><th>PREFIX</th><th>HEAD</th>{manage && <th />}</tr></thead>
          <tbody>{q.data.map((d) => <tr key={d.publicId}>
            <td><b>{d.name}</b></td><td>{d.company}</td><td>{d.codePrefix}</td><td>{d.head?.displayName ?? '—'}</td>
            {manage && <td><button className="text-btn" onClick={() => setDialog({ kind: 'edit', dept: d })}>Edit</button></td>}</tr>)}</tbody></table></div>}
    </div>
    {dialog?.kind === 'new' && <NewDepartment onClose={() => setDialog(null)} onSaved={() => { setDialog(null); q.reload(); }} />}
    {dialog?.kind === 'edit' && <EditDepartment dept={dialog.dept} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); q.reload(); }} />}
  </Panel>;
}

/** Shared form shell: validate, send, report. */
function FormModal({ title, subtitle, submitLabel, onClose, run, children }: {
  title: string; subtitle?: string; submitLabel: string; onClose: () => void; run: (f: FormData) => Promise<void> | string; children: React.ReactNode;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const result = run(new FormData(e.currentTarget));
    if (typeof result === 'string') { setError(result); return; }
    setBusy(true); setError('');
    try { await result; } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }
  return <Modal title={title} subtitle={subtitle} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">{children}</div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button><button className="primary-btn" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button></div>
    </form>
  </Modal>;
}

function NewDepartment({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  return <FormModal title="Add a department" submitLabel="Add department" onClose={onClose} run={(f) => {
    const parsed = CreateDepartmentRequest.safeParse({ company: String(f.get('company')), name: String(f.get('name')), codePrefix: String(f.get('prefix')).trim().toUpperCase() });
    return parsed.success ? api('/hrms/departments', { method: 'POST', json: parsed.data }).then(onSaved) : parsed.error.issues[0]?.message ?? 'Check the form';
  }}>
    <label className="span-two">Company<select id="nd-company" name="company">{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
    <label>Name<input id="nd-name" name="name" required minLength={2} maxLength={80} /></label>
    <label>Code prefix<input id="nd-prefix" name="prefix" required maxLength={6} placeholder="ATS" /></label>
  </FormModal>;
}

function EditDepartment({ dept, onClose, onSaved }: { dept: Department; onClose: () => void; onSaved: () => void }) {
  const [head, setHead] = useState<string | null | undefined>(undefined); // undefined: not changed; null: clear the head
  return <FormModal title="Edit department" subtitle={`${dept.company} · ${dept.codePrefix}`} submitLabel="Save" onClose={onClose} run={(f) => {
    const name = String(f.get('name')).trim();
    const body: Record<string, unknown> = {};
    if (name !== dept.name) body.name = name;
    if (head !== undefined) body.headPublicId = head;
    const parsed = UpdateDepartmentRequest.safeParse(body);
    return parsed.success ? api(`/hrms/departments/${dept.publicId}`, { method: 'PATCH', json: parsed.data }).then(onSaved) : 'Change the name or the head';
  }}>
    <label className="span-two">Name<input id="ed-name" name="name" required minLength={2} maxLength={80} defaultValue={dept.name} /></label>
    <p className="span-two muted-text">Head: {dept.head?.displayName ?? 'none'}{head === null ? ' (will be cleared)' : head ? ' (will change)' : ''}</p>
    <PersonPicker idPrefix="ed-head" label="New head" onChange={(id) => setHead(id || undefined)} />
    {dept.head && <label className="span-two check-row"><input type="checkbox" checked={head === null} onChange={(e) => setHead(e.target.checked ? null : undefined)} /> Remove the current head</label>}
  </FormModal>;
}

/** Search for a person and choose one; `onChange` gets the person's public ID, or '' while none is chosen. */
function PersonPicker({ idPrefix, label, onChange }: { idPrefix: string; label: string; onChange: (publicId: string) => void }) {
  const [search, setSearch] = useState('');
  const [people, setPeople] = useState<PersonList['items']>([]);
  const [error, setError] = useState('');
  async function find() {
    setError(''); onChange('');
    try { setPeople((await api<PersonList>(`/hrms/people?search=${encodeURIComponent(search)}&pageSize=20`)).items); } catch (e) { setError(errText(e)); }
  }
  return <>
    <label className="span-two">{label} <span className="optional">search</span>
      <span className="chip-row"><input id={`${idPrefix}-search`} className="input" value={search} placeholder="Name or employee code"
        onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void find(); } }} />
        <button type="button" className="outline-btn" onClick={() => void find()}>Search</button></span></label>
    {error && <span className="span-two muted-text">{error}</span>}
    {!!people.length && <label className="span-two">Person<select id={`${idPrefix}-person`} defaultValue="" onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose…</option>{people.map((p) => <option key={p.publicId} value={p.publicId}>{p.displayName}{p.primaryEmployment ? ` · ${p.primaryEmployment.employeeCode}` : ''}</option>)}</select></label>}
  </>;
}

function Designations() {
  const [company, setCompany] = useState('');
  const q = useLoad(() => api<Designation[]>(`/hrms/designations${company ? `?company=${company}` : ''}`), [company]);
  return <Panel title="Designations" note="Job titles in use. Positions and employments pick from this list.">
    <div className="panel-body">
      <div className="filters"><CompanyFilter id="desg-company" value={company} onChange={setCompany} /></div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No designations" /> :
        <div className="table-wrap"><table><thead><tr><th>DESIGNATION</th><th>COMPANY</th></tr></thead>
          <tbody>{q.data.map((d) => <tr key={d.publicId}><td><b>{d.name}</b></td><td>{d.company}</td></tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}

function Positions() {
  const { can } = useAuth();
  const manage = can(PEOPLE.managePositions);
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'fill'; position: Position } | null>(null);
  const q = useLoad(() => api<Position[]>(`/hrms/positions?${new URLSearchParams({ ...(company && { company }), ...(status && { status }) })}`), [company, status]);

  async function move(p: Position, to: 'planned' | 'open') {
    setError('');
    try { await api(`/hrms/positions/${p.publicId}/status`, { method: 'POST', json: { status: to } }); q.reload(); } catch (e) { setError(errText(e)); }
  }
  return <Panel title="Positions" note="Planned and open roles. Filling one links the person hired."
    action={manage ? <button className="primary-btn" onClick={() => setDialog({ kind: 'new' })}><Plus size={16} /> Add position</button> : undefined}>
    <div className="panel-body">
      <div className="filters"><CompanyFilter id="pos-company" value={company} onChange={setCompany} />
        <label className="inline-field">Status<select id="pos-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option><option value="planned">Planned</option><option value="open">Open</option><option value="filled">Filled</option></select></label></div>
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No positions" text="Plan a position to track a role you want to hire for." /> :
        <div className="table-wrap"><table><thead><tr><th>DESIGNATION</th><th>DEPARTMENT</th><th>COMPANY</th><th>STATUS</th><th>FILLED BY</th>{manage && <th />}</tr></thead>
          <tbody>{q.data.map((p) => <tr key={p.publicId}>
            <td><b>{p.designation}</b>{p.notes && <small className="sub">{p.notes}</small>}</td><td>{p.department.name}</td><td>{p.company}</td>
            <td><Badge tone={POSITION_TONE[p.status] ?? 'gray'}>{p.status}</Badge></td>
            <td>{p.filledBy ? <>{p.filledBy.person.displayName}<small className="sub">{p.filledBy.employeeCode}{p.filledAt ? ` · ${dayLabel(p.filledAt.slice(0, 10))}` : ''}</small></> : '—'}</td>
            {manage && <td><span className="chip-row">
              {p.status === 'planned' && <button className="text-btn" onClick={() => void move(p, 'open')}>Open</button>}
              {p.status === 'open' && <button className="text-btn" onClick={() => void move(p, 'planned')}>Back to planned</button>}
              {p.status !== 'filled' && <button className="text-btn" onClick={() => setDialog({ kind: 'fill', position: p })}>Fill</button>}</span></td>}</tr>)}</tbody></table></div>}
    </div>
    {dialog?.kind === 'new' && <NewPosition onClose={() => setDialog(null)} onSaved={() => { setDialog(null); q.reload(); }} />}
    {dialog?.kind === 'fill' && <FillPosition position={dialog.position} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); q.reload(); }} />}
  </Panel>;
}

function NewPosition({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const [company, setCompany] = useState(COMPANIES[0]!.code);
  const depts = useLoad(() => api<Department[]>(`/hrms/departments?company=${company}`), [company]);
  const desgs = useLoad(() => api<Designation[]>(`/hrms/designations?company=${company}`), [company]);
  return <FormModal title="Add a position" submitLabel="Add position" onClose={onClose} run={(f) => {
    const notes = String(f.get('notes')).trim();
    const parsed = CreatePositionRequest.safeParse({
      publicId: id, company, departmentCode: String(f.get('department')), designation: String(f.get('designation')).trim(),
      status: String(f.get('status')), ...(notes ? { notes } : {}),
    });
    return parsed.success ? api('/hrms/positions', { method: 'POST', json: parsed.data }).then(onSaved) : parsed.error.issues[0]?.message ?? 'Check the form';
  }}>
    <label className="span-two">Company<select id="np-company" value={company} onChange={(e) => setCompany(e.target.value)}>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
    <label>Department<select id="np-department" name="department" required key={`d-${company}-${depts.data?.length ?? 0}`} defaultValue="">
      <option value="" disabled>{depts.loading ? 'Loading…' : 'Choose'}</option>{depts.data?.map((d) => <option key={d.publicId} value={d.codePrefix}>{d.name}</option>)}</select></label>
    <label>Designation<select id="np-designation" name="designation" required key={`g-${company}-${desgs.data?.length ?? 0}`} defaultValue="">
      <option value="" disabled>{desgs.loading ? 'Loading…' : 'Choose'}</option>{desgs.data?.map((d) => <option key={d.publicId} value={d.name}>{d.name}</option>)}</select></label>
    <label>Status<select id="np-status" name="status" defaultValue="planned"><option value="planned">Planned</option><option value="open">Open</option></select></label>
    <label>Notes <span className="optional">optional</span><input id="np-notes" name="notes" maxLength={500} /></label>
  </FormModal>;
}

function FillPosition({ position, onClose, onSaved }: { position: Position; onClose: () => void; onSaved: () => void }) {
  const [job, setJob] = useState('');
  return <FormModal title="Fill position" subtitle={`${position.designation} · ${position.department.name} · ${position.company}. Choose the person hired, in the same company.`}
    submitLabel="Fill position" onClose={onClose} run={() => {
      const parsed = FillPositionRequest.safeParse({ employmentPublicId: job });
      return parsed.success ? api(`/hrms/positions/${position.publicId}/fill`, { method: 'POST', json: parsed.data }).then(onSaved) : 'Choose a person and job';
    }}>
    <JobPicker idPrefix="fill" onChange={setJob} />
  </FormModal>;
}
