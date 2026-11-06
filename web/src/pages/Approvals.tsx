import { useState, type FormEvent } from 'react';
import { Check, X } from 'lucide-react';
import type { ApprovalItem, ApprovalType, ApprovalsInbox } from '@ageless/shared';
import { api, errText } from '../api';
import { dayLabel, rupees, useLoad } from '../hooks';
import { Badge, Empty, Loading, Modal, Notice, PageHead, Panel, Tabs, type Tone } from '../ui';

/** Where each kind of request is approved or rejected (the backend checks permission and "not your own"). */
const BASE: Record<ApprovalType, string> = {
  leave: '/hrms/leave/requests', expense: '/hrms/expenses',
  correction: '/hrms/attendance/corrections', overtime: '/hrms/attendance/overtime',
};
const LABEL: Record<ApprovalType, string> = { leave: 'Leave', expense: 'Expense', correction: 'Correction', overtime: 'Overtime' };
const TONE: Record<ApprovalType, Tone> = { leave: 'blue', expense: 'amber', correction: 'gray', overtime: 'green' };
type Filter = 'all' | ApprovalType;

export default function Approvals() {
  const q = useLoad(() => api<ApprovalsInbox>('/hrms/approvals/mine'));
  const [filter, setFilter] = useState<Filter>('all');
  const [rejecting, setRejecting] = useState<ApprovalItem | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const counts = q.data?.counts;
  const tabs: { key: Filter; label: string }[] = [
    { key: 'all', label: `All (${counts?.total ?? 0})` },
    ...(['leave', 'expense', 'correction', 'overtime'] as const).map((t) => ({ key: t, label: `${LABEL[t]} (${counts?.[t] ?? 0})` })),
  ];
  const items = (q.data?.items ?? []).filter((i) => filter === 'all' || i.type === filter);

  async function approve(i: ApprovalItem) {
    setBusy(i.publicId); setError('');
    try { await api(`${BASE[i.type]}/${i.publicId}/approve`, { method: 'POST', json: {} }); q.reload(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(''); }
  }

  return <>
    <PageHead eyebrow="HRMS • APPROVALS" title="Approvals" subtitle="Leave, expenses, corrections and overtime waiting for your decision." />
    <Tabs tabs={tabs} value={filter} onChange={setFilter} />
    <Panel>
      <div className="panel-body">
        {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
        {q.loading && !q.data ? <Loading /> : !items.length ? <Empty title="Nothing waiting" text="You are all caught up." /> :
          <div className="table-wrap"><table><thead><tr><th>TYPE</th><th>PERSON</th><th>DETAILS</th><th>WHEN</th><th>WAITING</th><th /></tr></thead>
            <tbody>{items.map((i) => <tr key={`${i.type}-${i.publicId}`}>
              <td><Badge tone={TONE[i.type]}>{LABEL[i.type]}</Badge></td>
              <td>{i.person.displayName}<small className="sub">{i.company}</small></td>
              <td>{i.summary}{i.amountPaise !== null && <small className="sub">{rupees(i.amountPaise)}</small>}</td>
              <td>{i.fromDate ? dayLabel(i.fromDate) : '—'}{i.toDate && i.toDate !== i.fromDate ? ` – ${dayLabel(i.toDate)}` : ''}</td>
              <td>{i.ageDays === 0 ? 'Today' : `${i.ageDays}d`}</td>
              <td><div className="row-actions">
                <button className="primary-btn" disabled={busy === i.publicId} onClick={() => approve(i)}><Check size={13} /> Approve</button>
                <button className="danger-btn" disabled={busy === i.publicId} onClick={() => setRejecting(i)}><X size={13} /> Reject</button></div></td></tr>)}</tbody></table></div>}
      </div>
    </Panel>
    {rejecting && <Reject item={rejecting} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); q.reload(); }} />}
  </>;
}

function Reject({ item, onClose, onDone }: { item: ApprovalItem; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    if (reason.length < 3) { setError('Give a reason (at least 3 characters)'); return; }
    setSaving(true); setError('');
    try { await api(`${BASE[item.type]}/${item.publicId}/reject`, { method: 'POST', json: { reason } }); onDone(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title="Reject request" subtitle={`${item.person.displayName} · ${item.summary}`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid one"><label>Reason<input id="reject-reason" name="reason" required minLength={3} maxLength={500} autoFocus /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Rejecting…' : 'Reject'}</button></div>
    </form>
  </Modal>;
}
