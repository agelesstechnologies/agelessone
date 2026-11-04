import { useState, type FormEvent } from 'react';
import {
  AssignRoleRequest, ChangePasswordRequest, CreateUserRequest, type PersonList, type RoleScope,
} from '@ageless/shared';
import { api, errText, setToken } from '../api';
import { useAuth } from '../auth';
import { useLoad } from '../hooks';
import { PERMISSION_LABELS, SCOPE_LABELS, USERS } from '../permissions';
import { Badge, Notice, PageHead, Panel } from '../ui';

const ROLE_OPTIONS = [
  ['employee', 'Employee'], ['supervisor', 'Supervisor'], ['hr', 'HR'], ['admin_user', 'Admin user'], ['system_admin', 'System admin'],
] as const;

export default function Access() {
  const { me, can } = useAuth();
  if (!me) return null;
  const codes = Object.keys(me.permissions).sort();
  return <>
    <PageHead eyebrow="CORE • ACCESS" title="Roles & access" subtitle="What you can see and do. Menus and buttons follow these permissions." />
    <div className="two-col">
      <Panel title="Your roles" note={me.person.displayName}>
        <div className="panel-body">
          {me.roles.length === 0 ? <p className="muted-text">No role is assigned to you yet.</p> :
            <ul className="plain-list">{me.roles.map((r) => <li key={r.publicId}><b>{r.name}</b><Badge tone="blue">{SCOPE_LABELS[r.scope]}</Badge></li>)}</ul>}
          <h3 className="mini-h">Permissions</h3>
          {codes.length === 0 ? <p className="muted-text">No permissions.</p> :
            <ul className="plain-list">{codes.map((c) => <li key={c}><span>{PERMISSION_LABELS[c] ?? c}</span><Badge tone="gray">{SCOPE_LABELS[me.permissions[c]!]}</Badge></li>)}</ul>}
        </div>
      </Panel>
      <Password />
    </div>
    {can(USERS.manage) && <div className="two-col"><CreateLogin /><AssignRole /></div>}
  </>;
}

function Password() {
  const { refresh } = useAuth();
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const parsed = ChangePasswordRequest.safeParse({ currentPassword: data.get('currentPassword'), newPassword: data.get('newPassword') });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setBusy(true); setError(''); setOk('');
    try {
      const r = await api<{ token: string }>('/auth/password', { method: 'POST', json: parsed.data });
      setToken(r.token); await refresh(); form.reset(); setOk('Password changed.');
    } catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  return <Panel title="Change password" note="Other devices will be signed out.">
    <form className="panel-body" onSubmit={submit}>
      {error && <Notice onClose={() => setError('')}>{error}</Notice>}{ok && <Notice tone="ok" onClose={() => setOk('')}>{ok}</Notice>}
      <div className="form-grid one">
        <label>Current password<input id="pw-current" name="currentPassword" type="password" autoComplete="current-password" required /></label>
        <label>New password<input id="pw-new" name="newPassword" type="password" autoComplete="new-password" minLength={8} maxLength={72} required /></label>
      </div>
      <div className="form-foot"><button className="primary-btn" disabled={busy}>Change password</button></div>
    </form>
  </Panel>;
}

function PersonSelect({ id }: { id: string }) {
  const people = useLoad(() => api<PersonList>('/hrms/people?pageSize=100'));
  return <select id={id} name="personPublicId" required defaultValue="">
    <option value="" disabled>{people.loading ? 'Loading people…' : 'Choose a person'}</option>
    {people.data?.items.map((p) => <option key={p.publicId} value={p.publicId}>{p.displayName}{p.primaryEmployment ? ` · ${p.primaryEmployment.employeeCode}` : ''}</option>)}
  </select>;
}

function CreateLogin() {
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    const text = (k: string) => String(d.get(k) ?? '').trim() || undefined;
    const parsed = CreateUserRequest.safeParse({ personPublicId: d.get('personPublicId'), loginPhone: text('loginPhone'), loginEmail: text('loginEmail'), password: d.get('password') });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setBusy(true); setError(''); setOk('');
    try { await api('/core/users', { method: 'POST', json: parsed.data }); form.reset(); setOk('Login created. Share the password with the person directly.'); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  return <Panel title="Create a login" note="For a person who is already in the directory.">
    <form className="panel-body" onSubmit={submit}>
      {error && <Notice onClose={() => setError('')}>{error}</Notice>}{ok && <Notice tone="ok" onClose={() => setOk('')}>{ok}</Notice>}
      <div className="form-grid one">
        <label>Person<PersonSelect id="login-person" /></label>
        <label>Login phone <span className="optional">optional</span><input id="login-phone" name="loginPhone" inputMode="tel" /></label>
        <label>Login email <span className="optional">optional</span><input id="login-email" name="loginEmail" type="email" /></label>
        <label>First password<input id="login-password" name="password" type="password" autoComplete="new-password" minLength={8} maxLength={72} required /></label>
      </div>
      <div className="form-foot"><button className="primary-btn" disabled={busy}>Create login</button></div>
    </form>
  </Panel>;
}

function AssignRole() {
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    const text = (k: string) => String(d.get(k) ?? '').trim() || undefined;
    const parsed = AssignRoleRequest.safeParse({
      personPublicId: d.get('personPublicId'), roleCode: d.get('roleCode'), scope: d.get('scope') as RoleScope, validFrom: text('validFrom'), validTo: text('validTo'),
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setBusy(true); setError(''); setOk('');
    try { await api('/core/role-assignments', { method: 'POST', json: parsed.data }); form.reset(); setOk('Role assigned. It applies the next time that person signs in or reloads.'); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  return <Panel title="Give a role" note="You cannot give a role to yourself.">
    <form className="panel-body" onSubmit={submit}>
      {error && <Notice onClose={() => setError('')}>{error}</Notice>}{ok && <Notice tone="ok" onClose={() => setOk('')}>{ok}</Notice>}
      <div className="form-grid one">
        <label>Person<PersonSelect id="role-person" /></label>
        <label>Role<select id="role-code" name="roleCode" defaultValue="employee">{ROLE_OPTIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label>Reach<select id="role-scope" name="scope" defaultValue="own">{(Object.keys(SCOPE_LABELS) as RoleScope[]).map((s) => <option key={s} value={s}>{SCOPE_LABELS[s]}</option>)}</select></label>
        <label>Valid from <span className="optional">optional</span><input id="role-from" name="validFrom" type="date" /></label>
        <label>Valid to <span className="optional">optional</span><input id="role-to" name="validTo" type="date" /></label>
      </div>
      <div className="form-foot"><button className="primary-btn" disabled={busy}>Give role</button></div>
    </form>
  </Panel>;
}
