import { useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import type { PersonAccess, RoleOption } from '@ageless/shared';
import { api, errText } from '../api';
import { useLoad } from '../hooks';
import { Badge, Notice } from '../ui';

/**
 * What each role reaches: Employee their own records; Manager and CEO their team; Supervisor (on site only) team, for
 * the tickets they supervise; everyone else the whole tenant.
 */
const SCOPE: Record<string, 'own' | 'team' | 'all'> = { employee: 'own', manager: 'team', supervisor: 'team', ceo: 'team' };
const REACH = { own: 'own records', team: 'their team', all: 'everyone' };

/**
 * System admin, on a person's profile: their login and roles. Give a role (e.g. Manager for someone who will lead a
 * team in Ageless Technologies, Supervisor for someone who runs site work) or end one. Nobody gives a role to themselves.
 */
export default function PersonRoles({ personPublicId }: { personPublicId: string }) {
  const access = useLoad(() => api<PersonAccess>(`/core/people/${personPublicId}/access`), [personPublicId]);
  const roles = useLoad(() => api<RoleOption[]>('/core/roles'));
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const held = new Set(access.data?.roles.map((r) => r.code));

  async function give() {
    if (!role) return;
    setBusy('give'); setError('');
    try { await api('/core/role-assignments', { method: 'POST', json: { personPublicId, roleCode: role, scope: SCOPE[role] ?? 'all' } }); setRole(''); access.reload(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(''); }
  }
  async function end(assignment: string) {
    setBusy(assignment); setError('');
    try { await api(`/core/role-assignments/${assignment}/end`, { method: 'POST' }); access.reload(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(''); }
  }

  const login = access.data?.login;
  return <div className="detail-section">
    <h3><ShieldCheck size={16} />Login and roles</h3>
    {(error || access.error) && <Notice onClose={() => setError('')}>{error || access.error}</Notice>}
    <p className="muted-text">{access.loading && !access.data ? 'Loading…' : login
      ? `Signs in with ${[login.loginEmail, login.loginPhone].filter(Boolean).join(' or ')}${login.isActive ? '' : ' (login switched off)'}`
      : 'No login yet — use Create login below.'}</p>
    <div className="role-chips">{access.data?.roles.map((r) => <span key={r.publicId} className="role-chip">
      <Badge tone={r.code === 'supervisor' ? 'amber' : 'blue'}>{r.name}</Badge><small>{REACH[r.scope]}</small>
      <button type="button" disabled={busy === r.publicId} onClick={() => void end(r.publicId)} title={`End ${r.name}`} aria-label={`End ${r.name}`}><X size={13} /></button>
    </span>)}</div>
    <div className="role-give">
      <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role to give">
        <option value="">Give a role…</option>
        {roles.data?.filter((r) => !held.has(r.code)).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select>
      <button type="button" className="outline-btn" disabled={!role || busy === 'give'} onClick={() => void give()}>Give</button>
    </div>
  </div>;
}
