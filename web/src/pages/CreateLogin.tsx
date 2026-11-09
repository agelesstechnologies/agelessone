import { useState, type FormEvent } from 'react';
import { CreateUserRequest } from '@ageless/shared';
import { api, errText, formError } from '../api';
import { Modal, Notice } from '../ui';

/**
 * Create a login for a person (System admin: anyone; a supervisor or department head: their own team, who get the
 * Employee role). No password: a welcome email tells the person to set their own with a code sent to that email.
 */
export default function CreateLogin({ personPublicId, personName, onClose }: { personPublicId: string; personName: string; onClose: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [sentTo, setSentTo] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const phone = String(f.get('loginPhone') ?? '').trim();
    const parsed = CreateUserRequest.safeParse({ personPublicId, loginEmail: String(f.get('loginEmail') ?? '').trim(), loginPhone: phone || undefined });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { await api('/core/users', { method: 'POST', json: parsed.data }); setSentTo(parsed.data.loginEmail); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }

  return <Modal title="Create login" subtitle={personName} onClose={onClose}>
    {sentTo ? <>
      <Notice tone="ok">Login created. A welcome email went to {sentTo}.</Notice>
      <ol className="steps"><li>{personName} opens the Ageless app and chooses <b>First time or forgot your password?</b></li>
        <li>They enter <b>{sentTo}</b>; a 6-digit code arrives by email.</li>
        <li>They enter the code and choose their own password. Nobody else ever knows it.</li></ol>
      <div className="modal-foot"><button className="primary-btn" onClick={onClose} autoFocus>Done</button></div>
    </> : <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <p className="muted-text">No password needed: we email {personName} how to set their own.</p>
      <div className="form-grid">
        <label className="span-two">Email <span className="optional">required — they sign in with it and get their codes there</span>
          <input name="loginEmail" type="email" required maxLength={100} placeholder="name@agelessind.com" autoFocus /></label>
        <label className="span-two">Phone <span className="optional">optional — they can also sign in with it</span>
          <input name="loginPhone" maxLength={20} placeholder="e.g. 98765 43210" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Creating…' : 'Create login and email them'}</button></div>
    </form>}
  </Modal>;
}
