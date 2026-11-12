import { useState, type FormEvent } from 'react';
import {
  AddContactRequest, AddEmploymentRequest, ExitEmploymentRequest, UpdateEmploymentRequest, UpdatePersonRequest,
  type PersonDetail, type SharedContacts,
} from '@ageless/shared';
import { api, downloadFile, errText, formError } from '../api';
import { useAuth } from '../auth';
import { todayIst, useLoad } from '../hooks';
import { PEOPLE, PRIVATE } from '../permissions';
import PersonPrivate from './PersonPrivate';
import { Loading, Modal, Notice } from '../ui';

type Job = PersonDetail['employments'][number];
type Contact = PersonDetail['contacts'][number];
type Dialog = { kind: 'person' } | { kind: 'contact' } | { kind: 'job' } | { kind: 'edit'; job: Job } | { kind: 'exit'; job: Job } | { kind: 'shared'; contact: Contact };

const text = (d: FormData, k: string) => String(d.get(k) ?? '').trim();
const orUndef = (v: string) => v || undefined;

/**
 * Edit actions for the person profile. Each button shows only when the permission allows it; the backend still checks.
 * Every answer from the API is the updated person, which goes back to the profile through `onChange`.
 */
export default function PersonManage({ person, onChange }: { person: PersonDetail; onChange: (p: PersonDetail) => void }) {
  const { can } = useAuth();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState('');
  const done = (p: PersonDetail) => { onChange(p); setDialog(null); };
  const live = person.contacts.filter((c) => !c.endedAt);
  const jobs = person.employments.filter((j) => j.status !== 'exited');

  async function endContact(c: Contact) {
    setError('');
    try { await api(`/hrms/contacts/${c.publicId}/end`, { method: 'POST', json: {} }); onChange(await api<PersonDetail>(`/hrms/people/${person.publicId}`)); }
    catch (e) { setError(errText(e)); }
  }

  async function activate(j: Job) {
    setError('');
    try { onChange(await api<PersonDetail>(`/hrms/employments/${j.publicId}/activate`, { method: 'POST', json: {} })); }
    catch (e) { setError(errText(e)); }
  }
  async function uploadOffer(j: Job, file: File | undefined) {
    if (!file) return;
    setError('');
    const body = new FormData(); body.append('file', file);
    try { onChange(await api<PersonDetail>(`/hrms/employments/${j.publicId}/offer-letter`, { method: 'POST', body })); }
    catch (e) { setError(errText(e)); }
  }
  async function openOffer(j: Job) {
    setError('');
    try { await downloadFile(`/hrms/employments/${j.publicId}/offer-letter`, `offer-letter-${j.employeeCode}`); } catch (e) { setError(errText(e)); }
  }

  const anything = can(PEOPLE.update) || can(PEOPLE.manageContacts) || can(PEOPLE.manageEmployments) || can(PEOPLE.updateEmployments) || can(PEOPLE.reviewContacts);
  if (!anything && !person.private && !can(PRIVATE.manage)) return null;
  return <>
  {anything && <div className="detail-section">
    <h3>Manage</h3>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    <div className="chip-row">
      {can(PEOPLE.update) && <button className="outline-btn" onClick={() => setDialog({ kind: 'person' })}>Edit person</button>}
      {can(PEOPLE.manageContacts) && <button className="outline-btn" onClick={() => setDialog({ kind: 'contact' })}>Add contact</button>}
      {can(PEOPLE.manageEmployments) && <button className="outline-btn" onClick={() => setDialog({ kind: 'job' })}>Add employment</button>}
    </div>
    {(can(PEOPLE.manageContacts) || can(PEOPLE.reviewContacts)) && !!live.length && <ul className="plain-list">{live.map((c) => <li key={c.publicId}>
      <span>{c.kind}{c.isPrimary ? ' · primary' : ''}</span>
      <span className="chip-row">
        {can(PEOPLE.reviewContacts) && <button className="text-btn" onClick={() => setDialog({ kind: 'shared', contact: c })}>Who else uses this</button>}
        {can(PEOPLE.manageContacts) && <button className="text-btn" onClick={() => void endContact(c)}>End</button>}</span></li>)}</ul>}
    {(can(PEOPLE.updateEmployments) || can(PEOPLE.manageEmployments)) && !!jobs.length && <ul className="plain-list">{jobs.map((j) => <li key={j.publicId}>
      <span>{j.company.code} · {j.employeeCode}</span>
      <span className="chip-row">
        {can(PEOPLE.updateEmployments) && <button className="text-btn" onClick={() => setDialog({ kind: 'edit', job: j })}>Edit</button>}
        {can(PEOPLE.manageEmployments) && j.status === 'joining' && <button className="text-btn" onClick={() => void activate(j)}>Mark as started</button>}
        {j.hasOfferLetter && <button className="text-btn" onClick={() => void openOffer(j)}>Offer letter</button>}
        {can(PEOPLE.manageEmployments) && <label className="text-btn" style={{ cursor: 'pointer' }}>{j.hasOfferLetter ? 'Replace offer letter' : 'Upload offer letter'}
          <input type="file" accept="application/pdf,image/jpeg,image/png" hidden
            onChange={(e) => { const input = e.currentTarget; void uploadOffer(j, input.files?.[0]).then(() => { input.value = ''; }); }} /></label>}
        {can(PEOPLE.manageEmployments) && <button className="text-btn" onClick={() => setDialog({ kind: 'exit', job: j })}>Record exit</button>}</span></li>)}</ul>}

    {dialog?.kind === 'person' && <EditPerson person={person} onClose={() => setDialog(null)} onDone={done} />}
    {dialog?.kind === 'contact' && <AddContact person={person} onClose={() => setDialog(null)} onDone={done} />}
    {dialog?.kind === 'job' && <AddJob person={person} onClose={() => setDialog(null)} onDone={done} />}
    {dialog?.kind === 'edit' && <EditJob job={dialog.job} onClose={() => setDialog(null)} onDone={done} />}
    {dialog?.kind === 'exit' && <ExitJob job={dialog.job} onClose={() => setDialog(null)} onDone={done} />}
    {dialog?.kind === 'shared' && <Shared contact={dialog.contact} onClose={() => setDialog(null)} />}
  </div>}
  <PersonPrivate key={person.publicId} person={person} onChange={onChange} />
  </>;
}

/** Shared shell for the small forms: validate, send, hand back the updated person. */
function Form({ title, subtitle, submitLabel, onClose, run, children }: {
  title: string; subtitle?: string; submitLabel: string; onClose: () => void;
  run: (d: FormData) => Promise<PersonDetail> | string; children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn" disabled={busy}>{submitLabel}</button></div>
    </form>
  </Modal>;
}

type Step = { onClose: () => void; onDone: (p: PersonDetail) => void };
const send = async <T,>(method: string, path: string, json: T, onDone: Step['onDone']) => { const p = await api<PersonDetail>(path, { method, json }); onDone(p); return p; };
const COMPANIES = <><option value="AE">AE · Ageless Entertainments</option><option value="ATPL">ATPL · Ageless Technologies</option></>;

function EditPerson({ person, onClose, onDone }: Step & { person: PersonDetail }) {
  return <Form title="Edit person" submitLabel="Save" onClose={onClose} run={(d) => {
    const parsed = UpdatePersonRequest.safeParse({ displayName: text(d, 'name'), status: text(d, 'status') });
    return parsed.success ? send('PATCH', `/hrms/people/${person.publicId}`, parsed.data, onDone) : formError(parsed.error, 'Check the form');
  }}>
    <label className="span-two">Full name<input id="ep-name" name="name" required minLength={2} maxLength={100} defaultValue={person.displayName} /></label>
    <label className="span-two">Status<select id="ep-status" name="status" defaultValue={person.status}><option value="active">Active</option><option value="inactive">Inactive</option><option value="exited">Exited</option></select></label>
  </Form>;
}

function AddContact({ person, onClose, onDone }: Step & { person: PersonDetail }) {
  return <Form title="Add a contact" subtitle="A new primary replaces the current primary of that kind." submitLabel="Add contact" onClose={onClose} run={(d) => {
    const parsed = AddContactRequest.safeParse({ kind: text(d, 'kind'), value: text(d, 'value'), label: orUndef(text(d, 'label')), isPrimary: d.get('primary') === 'on' });
    return parsed.success ? send('POST', `/hrms/people/${person.publicId}/contacts`, parsed.data, onDone) : formError(parsed.error, 'Check the form');
  }}>
    <label>Type<select id="ac-kind" name="kind"><option value="phone">Phone</option><option value="email">Email</option><option value="other">Other</option></select></label>
    <label>Label <span className="optional">optional</span><input id="ac-label" name="label" maxLength={40} placeholder="e.g. Home" /></label>
    <label className="span-two">Value<input id="ac-value" name="value" required minLength={3} maxLength={100} /></label>
    <label className="span-two check-row"><input name="primary" type="checkbox" /> Make this the primary</label>
  </Form>;
}

function AddJob({ person, onClose, onDone }: Step & { person: PersonDetail }) {
  return <Form title="Add an employment" subtitle="Another job for this person, for example in a second company." submitLabel="Add employment" onClose={onClose} run={(d) => {
    const parsed = AddEmploymentRequest.safeParse({
      legalEntityCode: text(d, 'company'), employeeCode: text(d, 'code'), engagementType: text(d, 'type'), joinedOn: text(d, 'joined'),
      departmentCode: orUndef(text(d, 'department')), designation: orUndef(text(d, 'designation')), managerPublicId: orUndef(text(d, 'manager')),
    });
    return parsed.success ? send('POST', `/hrms/people/${person.publicId}/employments`, parsed.data, onDone) : formError(parsed.error, 'Check the form');
  }}>
    <label>Company<select id="aj-company" name="company">{COMPANIES}</select></label>
    <label>Employee ID<input id="aj-code" name="code" required maxLength={20} /></label>
    <label>Designation <span className="optional">optional</span><input id="aj-designation" name="designation" maxLength={80} /></label>
    <label>Department code <span className="optional">optional</span><input id="aj-department" name="department" maxLength={6} /></label>
    <label>Engagement<select id="aj-type" name="type"><option value="permanent">Permanent</option><option value="probation">Probation</option><option value="contract">Contract</option><option value="intern">Intern</option><option value="external">External</option></select></label>
    <label>Joined<input id="aj-joined" name="joined" type="date" required defaultValue={todayIst()} /></label>
    <label className="span-two">Manager public ID <span className="optional">optional</span><input id="aj-manager" name="manager" placeholder="Manager UUID" /></label>
  </Form>;
}

function EditJob({ job, onClose, onDone }: Step & { job: Job }) {
  return <Form title="Edit employment" subtitle={`${job.company.code} · ${job.employeeCode}. Clear a box to remove the value.`} submitLabel="Save" onClose={onClose} run={(d) => {
    const body: Record<string, unknown> = {};
    const designation = text(d, 'designation'), department = text(d, 'department'), manager = text(d, 'manager');
    if (designation !== (job.designation ?? '')) body.designation = designation || null;
    if (department !== (job.department?.code ?? '')) body.departmentCode = department || null;
    if (manager !== (job.manager?.publicId ?? '')) body.managerPublicId = manager || null;
    if (d.get('primary') === 'on') body.isPrimary = true;
    const parsed = UpdateEmploymentRequest.safeParse(body);
    return parsed.success ? send('PATCH', `/hrms/employments/${job.publicId}`, parsed.data, onDone) : formError(parsed.error, 'Check the form');
  }}>
    <label>Designation<input id="ej-designation" name="designation" maxLength={80} defaultValue={job.designation ?? ''} /></label>
    <label>Department code<input id="ej-department" name="department" maxLength={6} defaultValue={job.department?.code ?? ''} /></label>
    <label className="span-two">Manager public ID<input id="ej-manager" name="manager" defaultValue={job.manager?.publicId ?? ''} placeholder="Manager UUID" /></label>
    {!job.isPrimary && <label className="span-two check-row"><input name="primary" type="checkbox" /> Make this the primary employment</label>}
  </Form>;
}

function ExitJob({ job, onClose, onDone }: Step & { job: Job }) {
  return <Form title="Record an exit" subtitle={`${job.company.code} · ${job.employeeCode}`} submitLabel="Record exit" onClose={onClose} run={(d) => {
    const parsed = ExitEmploymentRequest.safeParse({ exitOn: text(d, 'on'), exitReason: text(d, 'reason') });
    return parsed.success ? send('POST', `/hrms/employments/${job.publicId}/exit`, parsed.data, onDone) : formError(parsed.error, 'Check the form');
  }}>
    <label>Last day<input id="ex-on" name="on" type="date" required defaultValue={todayIst()} /></label>
    <label>Reason<input id="ex-reason" name="reason" required minLength={3} maxLength={200} placeholder="e.g. Resigned" /></label>
  </Form>;
}

function Shared({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const q = useLoad(() => api<SharedContacts>(`/hrms/contacts/shared?value=${encodeURIComponent(contact.value)}`));
  return <Modal title="Who else uses this contact" subtitle="For HR review. Records are never merged." onClose={onClose}>
    {q.error && <Notice>{q.error}</Notice>}
    {q.loading ? <Loading /> : <ul className="plain-list">{q.data?.people.map((p) => <li key={`${p.publicId}-${p.contact.publicId}`}><span>{p.displayName}</span><span>{p.status}</span></li>)}</ul>}
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button></div>
  </Modal>;
}
