import { useState, type FormEvent } from 'react';
import { Check, Download, Plus } from 'lucide-react';
import { AddCertificateRequest, AddPersonSkillRequest, CreateSkillRequest, type ExpiringCertificates, type Skill, type SkillsMatrix } from '@ageless/shared';
import { api, downloadFile, errText } from '../api';
import { useAuth } from '../auth';
import { dayLabel, useLoad } from '../hooks';
import { SKILLS } from '../permissions';
import { Badge, Empty, Loading, Modal, Notice, PageHead, Panel, Tabs, type Tone } from '../ui';

type TabKey = 'matrix' | 'expiring';
const COMPANIES = [{ code: 'AE', name: 'Ageless Entertainments' }, { code: 'ATPL', name: 'Ageless Technologies' }];
const CERT_TONE: Record<string, Tone> = { verified: 'green', review: 'amber', expired: 'red' };

export default function Skills() {
  const { can } = useAuth();
  const tabs: { key: TabKey; label: string }[] = [
    ...(can(SKILLS.view) ? [{ key: 'matrix' as const, label: 'Skills matrix' }] : []),
    ...(can(SKILLS.manage) ? [{ key: 'expiring' as const, label: 'Expiring certificates' }] : []),
  ];
  const [tab, setTab] = useState<TabKey>(tabs[0]?.key ?? 'matrix');
  const [adding, setAdding] = useState(false);
  return <>
    <PageHead eyebrow="HRMS • SKILLS" title="Skills and certificates" subtitle="Who can do what, and which certificates are running out."
      action={can(SKILLS.manage) ? <button className="primary-btn" onClick={() => setAdding(true)}><Plus size={16} /> New skill</button> : undefined} />
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'matrix' && <Matrix />}
    {tab === 'expiring' && <Expiring />}
    {adding && <NewSkill onClose={() => setAdding(false)} />}
  </>;
}

function Matrix() {
  const { can } = useAuth();
  const [company, setCompany] = useState('');
  const q = useLoad(() => api<SkillsMatrix>(`/hrms/skills/matrix${company ? `?company=${company}` : ''}`), [company]);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'skill' | 'certificate'; row: SkillsMatrix['rows'][number] } | null>(null);
  async function verify(path: string) {
    setError('');
    try { await api(path, { method: 'POST', json: {} }); q.reload(); } catch (e) { setError(errText(e)); }
  }
  async function openFile(id: string) {
    setError('');
    try { await downloadFile(`/hrms/certificates/${id}/file`, 'certificate'); } catch (e) { setError(errText(e)); }
  }
  return <Panel>
    <div className="panel-body">
      <div className="filters"><label className="inline-field">Company
        <select id="skill-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
          <option value="">All</option>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label></div>
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.rows.length ? <Empty title="No skills recorded" text="Skills and certificates added to people appear here." /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>SKILLS</th><th>CERTIFICATES</th>{can(SKILLS.add) && <th />}</tr></thead>
          <tbody>{q.data.rows.map((r) => <tr key={r.employment.publicId}>
            <td>{r.person.displayName}<small className="sub">{r.employment.employeeCode}{r.employment.department ? ` · ${r.employment.department.name}` : ''}</small></td>
            <td>{r.skills.length === 0 ? '—' : r.skills.map((s) => <div key={s.publicId}>
              {s.skill.name} <Badge tone="blue">{s.level}</Badge>{' '}
              {s.verifiedAt ? <Badge tone="green">verified</Badge> : can(SKILLS.verify)
                ? <button className="text-btn" onClick={() => verify(`/hrms/person-skills/${s.publicId}/verify`)}><Check size={12} /> Verify</button> : <Badge tone="amber">unverified</Badge>}</div>)}</td>
            <td>{r.certificates.length === 0 ? '—' : r.certificates.map((c) => <div key={c.publicId}>
              {c.name} <Badge tone={CERT_TONE[c.status] ?? 'gray'}>{c.status}</Badge>
              {c.expiresOn && <small className="sub">Expires {dayLabel(c.expiresOn)}</small>}
              {c.hasFile && <button className="text-btn" onClick={() => openFile(c.publicId)}><Download size={12} /> File</button>}
              {c.status === 'review' && can(SKILLS.verify) && <button className="text-btn" onClick={() => verify(`/hrms/certificates/${c.publicId}/verify`)}><Check size={12} /> Verify</button>}</div>)}</td>
            {can(SKILLS.add) && <td><span className="chip-row">
              <button className="text-btn" onClick={() => setDialog({ kind: 'skill', row: r })}><Plus size={12} /> Skill</button>
              <button className="text-btn" onClick={() => setDialog({ kind: 'certificate', row: r })}><Plus size={12} /> Certificate</button></span></td>}
          </tr>)}</tbody></table></div>}
      {dialog?.kind === 'skill' && <AddSkill row={dialog.row} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); q.reload(); }} />}
      {dialog?.kind === 'certificate' && <AddCertificate row={dialog.row} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); q.reload(); }} />}
    </div>
  </Panel>;
}

function Expiring() {
  const [days, setDays] = useState(30);
  const q = useLoad(() => api<ExpiringCertificates>(`/hrms/certificates/expiring?days=${days}`), [days]);
  return <Panel title="Expiring certificates" note={q.data ? `Valid today, ending by ${dayLabel(q.data.until)}` : undefined}>
    <div className="panel-body">
      <div className="filters"><label className="inline-field">Within
        <select id="exp-days" className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[30, 60, 90, 180].map((d) => <option key={d} value={d}>{d} days</option>)}</select></label></div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.certificates.length ? <Empty title="Nothing expiring" text="No certificate ends in this period." /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>CERTIFICATE</th><th>EXPIRES</th><th>DAYS LEFT</th></tr></thead>
          <tbody>{q.data.certificates.map((c) => <tr key={c.publicId}>
            <td>{c.person.displayName}</td><td>{c.name}{c.issuer && <small className="sub">{c.issuer}</small>}</td>
            <td>{c.expiresOn ? dayLabel(c.expiresOn) : '—'}</td>
            <td><Badge tone={c.daysLeft <= 14 ? 'red' : c.daysLeft <= 30 ? 'amber' : 'gray'}>{c.daysLeft}</Badge></td></tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}

function NewSkill({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const dept = String(f.get('department') ?? '').trim().toUpperCase();
    const parsed = CreateSkillRequest.safeParse({
      company: String(f.get('company')), code: String(f.get('code')), name: String(f.get('name')), ...(dept ? { departmentCode: dept } : {}),
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setSaving(true); setError(''); setDone('');
    try { await api('/hrms/skills', { method: 'POST', json: parsed.data }); setDone(`Added ${parsed.data.name}.`); form.reset(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="New skill" subtitle="Added to the company's skills list." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      <div className="form-grid">
        <label className="span-two">Company<select id="skill-new-company" name="company">{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <label>Name<input id="skill-new-name" name="name" required minLength={2} placeholder="Welding" /></label>
        <label>Code<input id="skill-new-code" name="code" required placeholder="welding" /></label>
        <label className="span-two">Department prefix <span className="optional">optional</span><input id="skill-new-dept" name="department" placeholder="ATS" maxLength={6} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Add skill'}</button></div>
    </form>
  </Modal>;
}

type Row = SkillsMatrix['rows'][number];

/** Give a person a skill from their company's list, or change its level (a new level needs verifying again). */
function AddSkill({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const skills = useLoad(() => api<Skill[]>(`/hrms/skills?company=${row.employment.company}`), [row.employment.company]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = AddPersonSkillRequest.safeParse({ skillPublicId: String(f.get('skill')), level: String(f.get('level')) });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setSaving(true); setError('');
    try { await api(`/hrms/people/${row.person.publicId}/skills`, { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Add a skill" subtitle={`${row.person.displayName} · ${row.employment.employeeCode}. Choosing a skill they already have changes its level.`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      {skills.error && <Notice>{skills.error}</Notice>}
      <div className="form-grid">
        <label className="span-two">Skill<select id="ps-skill" name="skill" required defaultValue="">
          <option value="" disabled>{skills.loading ? 'Loading…' : 'Choose a skill'}</option>
          {skills.data?.map((k) => <option key={k.publicId} value={k.publicId}>{k.name}{k.department ? ` · ${k.department.name}` : ''}</option>)}</select></label>
        <label className="span-two">Level<select id="ps-level" name="level" defaultValue="skilled">
          <option value="trainee">Trainee</option><option value="skilled">Skilled</option><option value="expert">Expert</option></select></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Add skill'}</button></div>
    </form>
  </Modal>;
}

/** A certificate with an optional file (PDF, JPEG or PNG): sent as a form upload. */
function AddCertificate({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const parsed = AddCertificateRequest.safeParse({ name: text('name'), issuer: text('issuer'), number: text('number'), issuedOn: text('issuedOn'), expiresOn: text('expiresOn') });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    const body = new FormData();
    for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) body.append(k, String(v));
    const file = f.get('file');
    if (file instanceof File && file.size > 0) body.append('file', file);
    setSaving(true); setError('');
    try { await api(`/hrms/people/${row.person.publicId}/certificates`, { method: 'POST', body }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Add a certificate" subtitle={`${row.person.displayName} · ${row.employment.employeeCode}`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label className="span-two">Name<input id="cert-name" name="name" required minLength={2} maxLength={120} placeholder="e.g. Working at height" /></label>
        <label>Issuer <span className="optional">optional</span><input id="cert-issuer" name="issuer" maxLength={120} /></label>
        <label>Number <span className="optional">optional</span><input id="cert-number" name="number" maxLength={60} /></label>
        <label>Issued on <span className="optional">optional</span><input id="cert-issued" name="issuedOn" type="date" /></label>
        <label>Expires on <span className="optional">optional</span><input id="cert-expires" name="expiresOn" type="date" /></label>
        <label className="span-two">File <span className="optional">optional · PDF, JPEG or PNG</span><input id="cert-file" name="file" type="file" accept="application/pdf,image/jpeg,image/png" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Add certificate'}</button></div>
    </form>
  </Modal>;
}
