import { useState, type FormEvent } from 'react';
import { UpdatePrivateRequest, type PersonDetail, type PrivateDetails } from '@ageless/shared';
import { api, errText, formError } from '../api';
import { useAuth } from '../auth';
import { PRIVATE } from '../permissions';
import { Modal, Notice } from '../ui';

/**
 * Aadhaar, PAN and bank accounts of one person. They arrive masked for HR and Management.
 * HR can set or clear Aadhaar and PAN; Management can reveal them in full (each reveal is audited by the backend).
 * Revealed values live only in this component's state and disappear when it closes or the profile changes.
 */
export default function PersonPrivate({ person, onChange }: { person: PersonDetail; onChange: (p: PersonDetail) => void }) {
  const { can } = useAuth();
  const [revealed, setRevealed] = useState<PrivateDetails | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = revealed ?? person.private;
  if (!shown && !can(PRIVATE.manage)) return null;

  async function reveal() {
    setBusy(true); setError('');
    try { setRevealed(await api<PrivateDetails>(`/hrms/people/${person.publicId}/private/reveal`, { method: 'POST', json: {} })); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  return <div className="detail-section">
    <h3>Private details</h3>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    <div className="detail-row"><span>Aadhaar</span><b>{shown?.aadhaar ?? 'Not set'}</b></div>
    <div className="detail-row"><span>PAN</span><b>{shown?.pan ?? 'Not set'}</b></div>
    {shown?.bankAccounts.map((b) => <div className="detail-row" key={b.publicId}>
      <span>Bank · {b.company} {b.employeeCode}</span><b>{b.accountHolder} · {b.accountNumber} · {b.ifsc}</b></div>)}
    <div className="chip-row">
      {can(PRIVATE.manage) && <button className="outline-btn" onClick={() => setEditing(true)}>Set Aadhaar / PAN</button>}
      {can(PRIVATE.reveal) && (revealed
        ? <button className="outline-btn" onClick={() => setRevealed(null)}>Hide</button>
        : <button className="outline-btn" disabled={busy} onClick={() => void reveal()}>{busy ? 'Revealing…' : 'Show in full'}</button>)}
    </div>
    {revealed && <p className="muted-text">Shown in full. This view was written to the audit log.</p>}
    {editing && <EditPrivate person={person} onClose={() => setEditing(false)}
      onSaved={async () => { setEditing(false); setRevealed(null); onChange(await api<PersonDetail>(`/hrms/people/${person.publicId}`)); }} />}
  </div>;
}

function EditPrivate({ person, onClose, onSaved }: { person: PersonDetail; onClose: () => void; onSaved: () => Promise<void> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    // An empty box leaves the value alone; ticking "clear" removes it.
    const field = (name: string, clear: string) => (f.get(clear) === 'on' ? null : String(f.get(name)).trim() || undefined);
    const body = { aadhaar: field('aadhaar', 'clearAadhaar'), pan: field('pan', 'clearPan') };
    const parsed = UpdatePrivateRequest.safeParse(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setBusy(true); setError('');
    try { await api(`/hrms/people/${person.publicId}/private`, { method: 'PUT', json: parsed.data }); await onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  return <Modal title="Set Aadhaar / PAN" subtitle={`${person.displayName}. A box left empty stays as it is.`} onClose={onClose}>
    <form onSubmit={submit} autoComplete="off">
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Aadhaar<input id="pv-aadhaar" name="aadhaar" inputMode="numeric" placeholder="12 digits" autoComplete="off" /></label>
        <label>PAN<input id="pv-pan" name="pan" placeholder="ABCDE1234F" autoComplete="off" /></label>
        <label className="check-row"><input name="clearAadhaar" type="checkbox" /> Clear Aadhaar</label>
        <label className="check-row"><input name="clearPan" type="checkbox" /> Clear PAN</label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  </Modal>;
}
