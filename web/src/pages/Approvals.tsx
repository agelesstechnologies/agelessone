import { useState, type FormEvent } from 'react';
import { Check, Send, X } from 'lucide-react';
import type { ApprovalItem, ApprovalType, ApprovalsInbox } from '@ageless/shared';
import { api, errText } from '../api';
import { useAuth } from '../auth';
import { dayLabel, rupees, useLoad } from '../hooks';
import { MANAGEMENT } from '../permissions';
import { Badge, Empty, Loading, Modal, Notice, PageHead, Panel, Tabs, type Tone } from '../ui';

/** Where each kind of request is approved, rejected or forwarded (the backend checks permission and "not your own"). */
export const BASE: Record<ApprovalType, string> = {
  leave: '/hrms/leave/requests', expense: '/hrms/expenses',
  correction: '/hrms/attendance/corrections', overtime: '/hrms/attendance/overtime',
};
export const LABEL: Record<ApprovalType, string> = { leave: 'Leave', expense: 'Expense', correction: 'Correction', overtime: 'Overtime' };
export const TONE: Record<ApprovalType, Tone> = { leave: 'blue', expense: 'amber', correction: 'gray', overtime: 'green' };
type Filter = 'all' | ApprovalType;

/** "Sent to CEO" with who forwarded it (or that it waited too long) and why. */
export function SentToCeo({ item }: { item: ApprovalItem }) {
  if (!item.escalation) return null;
  const how = item.escalation.by ? `Forwarded by ${item.escalation.by.displayName}: ${item.escalation.reason}` : item.escalation.reason;
  return <span title={how}><Badge tone="red">Sent to CEO</Badge><small className="sub">{how}</small></span>;
}

export default function Approvals() {
  const { scopeOf } = useAuth();
  const isCeo = scopeOf(MANAGEMENT) === 'all';
  const q = useLoad(() => api<ApprovalsInbox>('/hrms/approvals/mine'));
  const [filter, setFilter] = useState<Filter>('all');
  const [asking, setAsking] = useState<{ item: ApprovalItem; action: 'reject' | 'forward' } | null>(null);
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
          <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>TYPE</th><th>PERSON</th><th>DETAILS</th><th>WHEN</th><th>WAITING</th><th /></tr></thead>
            <tbody>{items.map((i) => <tr key={`${i.type}-${i.publicId}`}>
              <td><Badge tone={TONE[i.type]}>{LABEL[i.type]}</Badge></td>
              <td>{i.person.displayName}<small className="sub">{i.company}</small></td>
              <td>{i.summary}{i.amountPaise !== null && <small className="sub">{rupees(i.amountPaise)}</small>}<SentToCeo item={i} /></td>
              <td>{i.fromDate ? dayLabel(i.fromDate) : '—'}{i.toDate && i.toDate !== i.fromDate ? ` – ${dayLabel(i.toDate)}` : ''}</td>
              <td>{i.ageDays === 0 ? 'Today' : `${i.ageDays}d`}</td>
              <td><div className="row-actions">
                <button className="primary-btn" disabled={busy === i.publicId} onClick={() => approve(i)}><Check size={13} /> Approve</button>
                <button className="danger-btn" disabled={busy === i.publicId} onClick={() => setAsking({ item: i, action: 'reject' })}><X size={13} /> Reject</button>
                {!isCeo && !i.escalation && <button className="outline-btn" disabled={busy === i.publicId} onClick={() => setAsking({ item: i, action: 'forward' })}
                  title="Send to the CEO; you can still decide it"><Send size={13} /> Forward to CEO</button>}
              </div></td></tr>)}</tbody></table></div>}
      </div>
    </Panel>
    {asking && <AskReason item={asking.item} action={asking.action} onClose={() => setAsking(null)} onDone={() => { setAsking(null); q.reload(); }} />}
  </>;
}

/** Reject, or forward to the CEO: both need a reason. */
export function AskReason({ item, action, onClose, onDone }: { item: ApprovalItem; action: 'reject' | 'forward'; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const text = action === 'reject'
    ? { title: 'Reject request', button: 'Reject', busy: 'Rejecting…', label: 'Reason' }
    : { title: 'Forward to the CEO', button: 'Forward', busy: 'Forwarding…', label: 'Why does the CEO need to decide this?' };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    if (reason.length < 3) { setError('Give a reason (at least 3 characters)'); return; }
    setSaving(true); setError('');
    try { await api(`${BASE[item.type]}/${item.publicId}/${action}`, { method: 'POST', json: { reason } }); onDone(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title={text.title} subtitle={`${item.person.displayName} · ${item.summary}`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      {action === 'forward' && <p className="sub">It appears on the CEO's dashboard. You can still approve or reject it until the CEO does.</p>}
      <div className="form-grid one"><label>{text.label}<input name="reason" required minLength={3} maxLength={500} autoFocus /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? text.busy : text.button}</button></div>
    </form>
  </Modal>;
}
