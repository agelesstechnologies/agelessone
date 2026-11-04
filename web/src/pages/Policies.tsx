import { useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { CreatePolicyRequest, POLICIES as DEFINITIONS, type Policy, type PolicyKey } from '@ageless/shared';
import { api, errText } from '../api';
import { dayLabel, todayIst, useLoad, uuidv7 } from '../hooks';
import { Empty, Loading, Modal, Notice, PageHead, Panel } from '../ui';

const KEYS = Object.keys(DEFINITIONS) as PolicyKey[];
const isFlag = (k: PolicyKey) => typeof DEFINITIONS[k].default === 'boolean';
const show = (v: unknown) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

export default function Policies() {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const q = useLoad(() => api<Policy[]>(`/core/policies${key ? `?key=${key}` : ''}`), [key]);
  return <>
    <PageHead eyebrow="CORE • POLICIES" title="Policies" subtitle="Company settings that are not final. A new version applies from the date you choose."
      action={<button className="primary-btn" onClick={() => setAdding(true)}><Plus size={16} /> New version</button>} />
    <Panel title="Built-in defaults" note="Used when no version is stored.">
      <div className="panel-body"><div className="table-wrap"><table><thead><tr><th>POLICY</th><th>WHAT IT DOES</th><th>DEFAULT</th></tr></thead>
        <tbody>{KEYS.map((k) => <tr key={k}><td><span className="mono">{k}</span></td><td className="note-cell">{DEFINITIONS[k].description}</td><td>{show(DEFINITIONS[k].default)}</td></tr>)}</tbody></table></div></div>
    </Panel>
    <Panel title="Stored versions" note="Newest first.">
      <div className="panel-body">
        <div className="filters"><label className="inline-field">Policy
          <select id="pol-key" className="input" value={key} onChange={(e) => setKey(e.target.value)}>
            <option value="">All policies</option>{KEYS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label></div>
        {q.error && <Notice>{q.error}</Notice>}
        {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No stored versions" text="The built-in defaults apply." /> :
          <div className="table-wrap"><table><thead><tr><th>POLICY</th><th>VALUE</th><th>FOR</th><th>FROM</th><th>VERSION</th><th>APPROVED BY</th></tr></thead>
            <tbody>{q.data.map((p) => <tr key={p.publicId}><td><span className="mono">{p.key}</span></td><td>{show(p.value)}</td><td>{p.company ?? 'Whole group'}</td>
              <td>{dayLabel(p.effectiveFrom)}</td><td>{p.version}</td><td>{p.approvedBy.displayName}</td></tr>)}</tbody></table></div>}
      </div>
      {adding && <NewVersion onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.reload(); }} />}
    </Panel>
  </>;
}

function NewVersion({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const [key, setKey] = useState<PolicyKey>(KEYS[0]!);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const company = String(d.get('company') ?? '');
    const parsed = CreatePolicyRequest.safeParse({
      publicId: id, key, ...(company ? { company } : {}), effectiveFrom: d.get('from'),
      value: isFlag(key) ? d.get('value') === 'true' : Number(d.get('value')),
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setSaving(true); setError('');
    try { await api('/core/policies', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="New policy version" subtitle={DEFINITIONS[key].description} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label className="span-two">Policy<select id="newpol-key" value={key} onChange={(e) => setKey(e.target.value as PolicyKey)}>{KEYS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
        <label>Value{isFlag(key)
          ? <select id="newpol-value" name="value" key={key} defaultValue={String(DEFINITIONS[key].default)}><option value="true">Yes</option><option value="false">No</option></select>
          : <input id="newpol-value" name="value" key={key} type="number" required defaultValue={Number(DEFINITIONS[key].default)} />}</label>
        <label>Applies from<input id="newpol-from" name="from" type="date" required defaultValue={todayIst()} /></label>
        <label className="span-two">Company <span className="optional">optional</span>
          <select id="newpol-company" name="company" defaultValue=""><option value="">Whole group</option><option value="AE">Ageless Entertainments</option><option value="ATPL">Ageless Technologies</option></select></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn" disabled={saving}>Save version</button></div>
    </form>
  </Modal>;
}
