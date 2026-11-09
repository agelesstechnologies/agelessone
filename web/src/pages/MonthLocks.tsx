import { useState, type FormEvent } from 'react';
import { Lock, Unlock } from 'lucide-react';
import { LockMonthRequest, UnlockMonthRequest, type MonthLock } from '@ageless/shared';
import { api, errText, formError } from '../api';
import { useAuth } from '../auth';
import { useLoad } from '../hooks';
import { ATTENDANCE } from '../permissions';
import { Badge, Empty, Loading, Modal, Notice, PageHead, Panel } from '../ui';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COMPANIES = [{ code: 'AE', name: 'Ageless Entertainments' }, { code: 'ATPL', name: 'Ageless Technologies' }];

export default function MonthLocks() {
  const { can } = useAuth();
  const [year, setYear] = useState(new Date().getFullYear());
  const [locking, setLocking] = useState(false);
  const [unlocking, setUnlocking] = useState<MonthLock | null>(null);
  const q = useLoad(() => api<MonthLock[]>(`/hrms/month-locks?year=${year}`), [year]);
  return <>
    <PageHead eyebrow="HRMS • ATTENDANCE" title="Month locks" subtitle="Lock a finished month so attendance cannot change before payroll."
      action={can(ATTENDANCE.lockMonth) ? <button className="primary-btn" onClick={() => setLocking(true)}><Lock size={15} /> Lock a month</button> : undefined} />
    <Panel>
      <div className="panel-body">
        <div className="filters"><label className="inline-field">Year
          <input id="lock-year" className="input" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || year)} /></label></div>
        {q.error && <Notice>{q.error}</Notice>}
        {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No locks this year" /> :
          <div className="table-wrap"><table><thead><tr><th>MONTH</th><th>COMPANY</th><th>STATUS</th><th>LOCKED BY</th><th>NOTE</th><th /></tr></thead>
            <tbody>{q.data.map((l) => <tr key={l.publicId}>
              <td>{MONTHS[l.month - 1]} {l.year}</td><td>{l.company}</td>
              <td>{l.unlockedAt ? <Badge tone="amber">Unlocked</Badge> : <Badge tone="green">Locked</Badge>}</td>
              <td>{l.lockedBy.displayName}<small className="sub">{new Date(l.lockedAt).toLocaleDateString('en-IN')}</small></td>
              <td className="note-cell">{l.unlockedAt ? `Unlocked by ${l.unlockedBy?.displayName ?? ''}: ${l.unlockReason ?? ''}` : ''}</td>
              <td>{!l.unlockedAt && can(ATTENDANCE.unlockMonth) && <button className="outline-btn" onClick={() => setUnlocking(l)}><Unlock size={12} /> Unlock</button>}</td></tr>)}</tbody></table></div>}
      </div>
    </Panel>
    {locking && <LockForm onClose={() => setLocking(false)} onSaved={() => { setLocking(false); q.reload(); }} />}
    {unlocking && <UnlockForm lock={unlocking} onClose={() => setUnlocking(null)} onSaved={() => { setUnlocking(null); q.reload(); }} />}
  </>;
}

function LockForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const prev = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = LockMonthRequest.safeParse({ company: String(f.get('company')), year: Number(f.get('year')), month: Number(f.get('month')) });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { await api('/hrms/month-locks', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title="Lock a month" subtitle="Only a month that has ended can be locked." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label className="span-two">Company<select id="lock-company" name="company">{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <label>Month<select id="lock-month" name="month" defaultValue={prev.getMonth() + 1}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
        <label>Year<input id="lock-year-new" name="year" type="number" defaultValue={prev.getFullYear()} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Locking…' : 'Lock month'}</button></div>
    </form>
  </Modal>;
}

function UnlockForm({ lock, onClose, onSaved }: { lock: MonthLock; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = UnlockMonthRequest.safeParse({ reason: String(new FormData(e.currentTarget).get('reason') ?? '') });
    if (!parsed.success) { setError(formError(parsed.error, 'Give a reason')); return; }
    setSaving(true); setError('');
    try { await api(`/hrms/month-locks/${lock.publicId}/unlock`, { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title="Unlock month" subtitle={`${lock.company} · ${MONTHS[lock.month - 1]} ${lock.year}. The reason is kept on record.`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid one"><label>Reason<input id="unlock-reason" name="reason" required minLength={5} maxLength={500} autoFocus /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Unlocking…' : 'Unlock'}</button></div>
    </form>
  </Modal>;
}
