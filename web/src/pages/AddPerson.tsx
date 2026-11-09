import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';
import { CreatePersonRequest, type Department, type NextEmployeeCode } from '@ageless/shared';
import { api, errText, formError } from '../api';
import { todayIst, useLoad, useMyEmployments } from '../hooks';
import { useAuth } from '../auth';
import { PEOPLE, USERS } from '../permissions';
import { PersonPicker } from '../JobPicker';

const COMPANIES = [{ code: 'AE', name: 'Ageless Entertainments' }, { code: 'ATPL', name: 'Ageless Technologies' }];

/**
 * Add a person with their first job. Choosing a department shows the next employee ID for its prefix (ATS004 …);
 * left as shown, the code is assigned when saving (so two people saved at once never get the same one). HR can type
 * another code instead, e.g. when bringing over existing staff.
 */
export default function AddPerson({ onClose, onCreated }: { onClose: () => void; onCreated: (publicId: string) => void }) {
  // HR: any company. A supervisor or department head: the companies they work in
  const { scopeOf, can } = useAuth();
  const mine = useMyEmployments();
  const myCodes = new Set(mine.jobs.map((j) => j.company.code));
  const companies = scopeOf(PEOPLE.create) === 'all' || !myCodes.size ? COMPANIES : COMPANIES.filter((c) => myCodes.has(c.code));
  const [picked, setPicked] = useState('');
  const company = companies.some((c) => c.code === picked) ? picked : (companies.find((c) => c.code === 'ATPL') ?? companies[0])!.code;
  const setCompany = setPicked;
  const [department, setDepartment] = useState('');
  const [code, setCode] = useState('');
  const [suggested, setSuggested] = useState('');
  const [manager, setManager] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // a login is created with the person when the caller may create logins (HR / System admin, or a supervisor for their team)
  const canLogin = can(USERS.manage) || can(USERS.team);
  const [giveLogin, setGiveLogin] = useState(canLogin);
  const [loginEmail, setLoginEmail] = useState('');
  const [done, setDone] = useState<{ personId: string; name: string; loginNote: string } | null>(null);
  const depts = useLoad(() => api<Department[]>(`/hrms/departments?company=${company}`), [company]);
  const dept = depts.data?.find((d) => d.publicId === department);

  // the next code for the chosen department, filled in for HR (kept if HR has typed their own)
  useEffect(() => {
    if (!department) { setSuggested(''); return; }
    let live = true;
    api<NextEmployeeCode>(`/hrms/departments/${department}/next-employee-code`)
      .then((n) => { if (!live) return; setCode((c) => (c === '' || c === suggested ? n.code : c)); setSuggested(n.code); })
      .catch((e) => { if (live) setError(errText(e)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const typed = code.trim();
    const raw = {
      displayName: text('displayName'),
      contacts: text('value') ? [{ kind: text('kind'), value: text('value'), isPrimary: true }] : [],
      employment: {
        legalEntityCode: company,
        // the suggested code is generated again on save; only a code HR typed is sent
        employeeCode: typed && typed !== suggested ? typed : undefined,
        departmentCode: dept?.codePrefix,
        engagementType: text('engagementType'), joinedOn: text('joinedOn'), designation: text('designation') || undefined,
        managerPublicId: manager || undefined, isPrimary: true,
      },
    };
    if (!raw.employment.employeeCode && !raw.employment.departmentCode) { setError('Choose a department, or type an employee ID'); return; }
    const parsed = CreatePersonRequest.safeParse(raw);
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form fields')); return; }
    const email = giveLogin ? loginEmail.trim() : '';
    if (giveLogin && !/^\S+@\S+\.\S+$/.test(email)) { setError('Enter the email the person will sign in with, or untick "Give them a login"'); return; }
    setSaving(true); setError('');
    let personId: string;
    try { personId = (await api<{ publicId: string }>('/hrms/people', { method: 'POST', json: parsed.data })).publicId; }
    catch (err) { setError(errText(err)); setSaving(false); return; }
    // the login: no password; the welcome email tells them to set one with a code
    let loginNote = '';
    if (giveLogin) {
      try { await api('/core/users', { method: 'POST', json: { personPublicId: personId, loginEmail: email } }); loginNote = `sent:${email}`; }
      catch (err) { loginNote = `failed:${errText(err)}`; }
    }
    setDone({ personId, name: raw.displayName, loginNote });
    setSaving(false);
  }

  if (done) return <div className="overlay">
    <section className="modal">
      <div className="modal-head"><div><div className="eyebrow">DIRECTORY</div><h2>{done.name} is added</h2><p>{companies.find((c) => c.code === company)?.name}</p></div></div>
      {done.loginNote.startsWith('sent:') ? <>
        <div className="notice-ok error-banner"><span>Login created. A welcome email went to <b>{done.loginNote.slice(5)}</b>.</span></div>
        <div className="detail-section"><h3>How {done.name} signs in</h3>
          <ol className="steps"><li>Open the Ageless app and choose <b>First time or forgot your password?</b></li>
            <li>Enter <b>{done.loginNote.slice(5)}</b>; a 6-digit code arrives by email.</li>
            <li>Enter the code and choose their own password. Nobody else ever knows it.</li></ol></div>
      </> : done.loginNote.startsWith('failed:')
        ? <div className="error-banner"><span>The person is added, but the login was not created: {done.loginNote.slice(7)} — try again from their profile (Create login).</span></div>
        : <p className="muted-text">No login yet. Create one later from their profile (Create login).</p>}
      <div className="modal-foot"><button className="primary-btn" onClick={() => onCreated(done.personId)} autoFocus>Done</button></div>
    </section>
  </div>;

  return <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <form className="modal" onSubmit={submit}>
      <div className="modal-head"><div><div className="eyebrow">DIRECTORY</div><h2>Add a person</h2><p>Create a person and their first employment.</p></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-grid">
        <label className="span-two">Full name<input name="displayName" required minLength={2} maxLength={100} placeholder="e.g. Asha Kumar" autoFocus /></label>
        <label>Company<select value={company} onChange={(e) => { setCompany(e.target.value); setDepartment(''); setCode(''); setSuggested(''); }}>
          {companies.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}</select></label>
        <label>Department<select value={department} onChange={(e) => setDepartment(e.target.value)} key={`${company}${depts.data?.length ?? 0}`}>
          <option value="">{depts.loading ? 'Loading…' : depts.data?.length ? 'Choose' : 'No departments yet'}</option>
          {depts.data?.map((d) => <option key={d.publicId} value={d.publicId}>{d.name} ({d.codePrefix})</option>)}</select></label>
        <label>Employee ID {code && code === suggested && <span className="optional">next number, assigned on save</span>}
          <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={20} placeholder={department ? 'Loading…' : 'Choose a department first'} /></label>
        <label>Designation<input name="designation" maxLength={80} placeholder="e.g. Software Engineer" /></label>
        <label>Engagement type<select name="engagementType" defaultValue="permanent"><option value="permanent">Permanent</option><option value="probation">Probation</option>
          <option value="contract">Contract</option><option value="intern">Intern</option><option value="external">External</option></select></label>
        <label>Joining date<input name="joinedOn" type="date" required defaultValue={todayIst()} /></label>
        <PersonPicker idPrefix="ap-mgr" label="Manager" hint={scopeOf(PEOPLE.create) !== 'all' ? 'optional — you, if left empty (they join your team)' : 'optional'} onChange={setManager} />
        <p className="form-section">Contact <span className="optional">optional</span></p>
        <label>Contact type<select name="kind"><option value="phone">Phone</option><option value="email">Email</option></select></label>
        <label>Contact value<input name="value" placeholder="Phone number or email" /></label>
        {canLogin && <>
          <p className="form-section">Login</p>
          <label className="span-two check-label"><input type="checkbox" checked={giveLogin} onChange={(e) => setGiveLogin(e.target.checked)} />
            Give them a login — we email them how to set their own password</label>
          {giveLogin && <label className="span-two">Email they sign in with
            <input type="email" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} maxLength={100} placeholder="name@agelessind.com" /></label>}
        </>}
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Create person</button></div>
    </form>
  </div>;
}
