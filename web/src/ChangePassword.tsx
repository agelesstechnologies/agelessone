import { useState, type FormEvent } from 'react';
import { ChangePasswordRequest, type LoginResponse } from '@ageless/shared';
import { api, errText } from './api';
import { useAuth } from './auth';
import { Modal, Notice } from './ui';

/** Change my own password (any signed-in person). Other devices are signed out; this one stays signed in. */
export default function ChangePassword({ onClose }: { onClose: () => void }) {
  const { adopt } = useAuth();
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('newPassword') !== f.get('again')) { setError('The two new passwords are not the same'); return; }
    const parsed = ChangePasswordRequest.safeParse({ currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setSaving(true); setError('');
    try { await adopt((await api<LoginResponse>('/auth/password', { method: 'POST', json: parsed.data })).token); setDone(true); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }

  return <Modal title="Change password" subtitle="Other devices will be signed out." onClose={onClose}>
    {done ? <>
      <Notice tone="ok">Your password is changed.</Notice>
      <div className="modal-foot"><button className="primary-btn" onClick={onClose} autoFocus>Done</button></div>
    </> : <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid one">
        <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required autoFocus /></label>
        <label>New password <span className="optional">at least 8 characters</span><input name="newPassword" type="password" autoComplete="new-password" required minLength={8} /></label>
        <label>Type it again<input name="again" type="password" autoComplete="new-password" required /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Change password'}</button></div>
    </form>}
  </Modal>;
}
