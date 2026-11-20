import { useState, type FormEvent } from 'react';
import { Download, Paperclip, Plus } from 'lucide-react';
import { AddPassedCostRequest, type IcAgreementDetail, type IcPassedCost, type IcPassedCostList } from '@ageless/shared';
import { api, downloadFile, errText, formError } from '../../api';
import { useAuth } from '../../auth';
import { dayLabel, rupees, todayIst, useLoad, uuidv7 } from '../../hooks';
import { INTERCOMPANY } from '../../permissions';
import { Badge, Empty, Loading, Modal, Notice, Panel } from '../../ui';
import { monthName, pct, stampIst, toPaise } from './common';

/** Same limits as the server: JPEG, PNG or PDF, up to 10 MB. */
const BILL_TYPES = 'image/jpeg,image/png,application/pdf';
const MAX_BILL_BYTES = 10 * 1024 * 1024;
const tooLarge = (f: File) => (f.size > MAX_BILL_BYTES ? 'The bill is larger than 10 MB. Choose a smaller file.' : '');
const ym = (date: string) => date.slice(0, 7);

/**
 * Costs the provider paid for the receiver (travel, material, outside work), on the agreement page. A cost goes on its
 * month's statement only once its bill is attached. Both companies' heads and the CEO see them; the provider's head and
 * the CEO record them and attach bills. A billed month takes no new costs or bills (the server checks it too).
 */
export function PassedCostsPanel({ a }: { a: IcAgreementDetail }) {
  const { can, me } = useAuth();
  const records = can(INTERCOMPANY.manage) || a.provider.head.person.publicId === me?.person.publicId;
  const canAdd = records && a.status !== 'draft';
  const [month, setMonth] = useState('');
  const q = useLoad(() => api<IcPassedCostList>(`/intercompany/agreements/${a.publicId}/passed-costs${month ? `?month=${month}` : ''}`), [a.publicId, month]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const billed = new Set(a.billedMonths.map((m) => `${m.year}-${String(m.month).padStart(2, '0')}`));
  const rows = q.data?.rows ?? [];
  const months = [...new Set(rows.map((c) => ym(c.incurredOn)))].sort().reverse();
  const terms = a.passedCostHandling === 'percent' ? `at cost plus ${pct(a.passedCostPercent)}` : 'at cost';

  async function attach(c: IcPassedCost, f: File) {
    const big = tooLarge(f);
    if (big) { setError(big); return; }
    setBusy(c.publicId); setError(''); setNote('');
    try {
      const body = new FormData(); body.append('bill', f);
      await api<IcPassedCost>(`/intercompany/passed-costs/${c.publicId}/bill`, { method: 'POST', body });
      setNote(c.bill ? 'Bill replaced.' : 'Bill attached: the cost now counts.');
      q.reload();
    } catch (e) { setError(errText(e)); }
    finally { setBusy(''); }
  }
  async function view(c: IcPassedCost) {
    setError('');
    try { await downloadFile(`/intercompany/passed-costs/${c.publicId}/bill`, `bill-${c.incurredOn}.${c.bill?.fileType ?? 'pdf'}`); }
    catch (e) { setError(errText(e)); }
  }

  return <Panel title="Costs passed on"
    note={`What ${a.provider.company} paid for ${a.receiver.company} (travel, material, outside work). Billed ${terms} on that month's statement, once its bill is attached.`}
    action={<div className="row-actions">
      <label className="month-pick">Month <input id="icc-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
      {month && <button className="text-btn" onClick={() => setMonth('')}>All months</button>}
      {canAdd && <button className="primary-btn" onClick={() => setAdding(true)}><Plus size={16} /> Add cost</button>}
    </div>}>
    <div className="panel-body">
      {q.error && <Notice>{q.error}</Notice>}
      {error && <Notice onClose={() => setError('')}>{error}</Notice>}
      {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
      {q.loading && !q.data ? <Loading /> : !rows.length
        ? <Empty title={month ? `No costs in ${monthName(month)}` : 'No costs passed on'}
          text={canAdd ? 'Add a cost with its bill. Without the bill it waits and is not billed.' : 'Costs the provider pays for the receiver appear here.'} /> : <>
          <div className="chip-row">
            <span className="ic-chip"><b>Counted</b> {rupees(q.data!.countedMinor)} <small>bill attached</small></span>
            {q.data!.waitingForBillMinor > 0 && <span className="ic-chip"><b>Waiting for a bill</b> {rupees(q.data!.waitingForBillMinor)} <small>not billed yet</small></span>}
          </div>
          {months.map((m) => {
            const list = rows.filter((c) => ym(c.incurredOn) === m);
            const locked = billed.has(m);
            return <div key={m}>
              <div className="mini-h">{monthName(m)} · {rupees(list.filter((c) => c.counted).reduce((t, c) => t + c.amountMinor, 0))} counted{locked && <> <Badge tone="gray">Billed</Badge></>}</div>
              <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>DATE</th><th>WHAT</th><th>AMOUNT</th><th>BILL</th><th>ADDED</th><th /></tr></thead>
                <tbody>{list.map((c) => <tr key={c.publicId}>
                  <td>{dayLabel(c.incurredOn)}</td>
                  <td>{c.description}{c.projectPublicId && <small className="sub">Project <span className="mono">{c.projectPublicId.slice(0, 8)}</span></small>}</td>
                  <td><b>{rupees(c.amountMinor)}</b></td>
                  <td>{c.counted ? <Badge tone="green">Attached · counts</Badge> : <Badge tone="amber">Waiting for bill</Badge>}
                    {c.bill && <small className="sub">{c.bill.uploadedBy.displayName}, {stampIst(c.bill.uploadedAt)}</small>}</td>
                  <td>{c.createdBy.displayName}<small className="sub">{stampIst(c.createdAt)}</small></td>
                  <td><div className="row-actions">
                    {c.bill && <button className="outline-btn" onClick={() => void view(c)}><Download size={13} /> Bill</button>}
                    {records && !locked && <BillButton label={c.bill ? 'Replace bill' : 'Attach bill'} busy={busy === c.publicId} onFile={(f) => attach(c, f)} />}
                  </div></td>
                </tr>)}</tbody></table></div>
            </div>;
          })}
        </>}
    </div>
    {adding && <AddCost a={a} billed={billed} onClose={() => setAdding(false)}
      onSaved={(c) => { setAdding(false); setNote(c.counted ? 'Cost added with its bill: it counts.' : 'Cost added. Attach its bill so it counts.'); q.reload(); }} />}
  </Panel>;
}

/** A button that opens the file picker and uploads the chosen bill at once. */
function BillButton({ label, busy, onFile }: { label: string; busy: boolean; onFile: (f: File) => Promise<void> }) {
  return <label className="outline-btn" style={{ cursor: busy ? 'wait' : 'pointer' }}><Paperclip size={13} /> {busy ? 'Uploading…' : label}
    <input type="file" accept={BILL_TYPES} hidden disabled={busy}
      onChange={(e) => { const i = e.currentTarget; const f = i.files?.[0]; if (f) void onFile(f).then(() => { i.value = ''; }); }} /></label>;
}

function AddCost({ a, billed, onClose, onSaved }: { a: IcAgreementDetail; billed: Set<string>; onClose: () => void; onSaved: (c: IcPassedCost) => void }) {
  const today = todayIst();
  const last = a.endDate && a.endDate < today ? a.endDate : today;
  const [publicId] = useState(uuidv7);
  const [incurredOn, setIncurredOn] = useState(last);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [project, setProject] = useState('');
  const [bill, setBill] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amountMinor = toPaise(amount);
    if (amountMinor === null || amountMinor <= 0) { setError('Enter the amount in rupees, e.g. 2500 or 2,500.50'); return; }
    if (billed.has(ym(incurredOn))) { setError(`${monthName(ym(incurredOn))} is billed: it takes no new costs.`); return; }
    const big = bill ? tooLarge(bill) : '';
    if (big) { setError(big); return; }
    const parsed = AddPassedCostRequest.safeParse({ publicId, description, amountMinor, incurredOn, projectPublicId: project.trim() });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    const body = new FormData();
    for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) body.append(k, String(v));
    if (bill) body.append('bill', bill);
    setSaving(true); setError('');
    try { onSaved(await api<IcPassedCost>(`/intercompany/agreements/${a.publicId}/passed-costs`, { method: 'POST', body })); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }

  return <Modal title="Add a cost passed on" subtitle={`Paid by ${a.provider.company} for ${a.receiver.company}. It counts on the month's statement once its bill is attached; you can attach the bill later.`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label className="span-two">What was it<input id="icc-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300}
          placeholder="e.g. Courier of prototype boards to the AE site" autoFocus /></label>
        <label>Amount (₹)<input id="icc-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 2500" /></label>
        <label>Date paid<input id="icc-date" type="date" min={a.startDate} max={last} value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)} /></label>
        <label className="span-two">Bill<span className="optional">JPEG, PNG or PDF, up to 10 MB · can be attached later</span>
          <input id="icc-bill" type="file" accept={BILL_TYPES} onChange={(e) => setBill(e.target.files?.[0] ?? null)} /></label>
        <label className="span-two">{a.receiver.company} project ID<span className="optional">optional · paste it when the cost is for one project</span>
          <input id="icc-project" value={project} onChange={(e) => setProject(e.target.value)} placeholder="Paste the ID" autoComplete="off" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : bill ? 'Add cost with bill' : 'Add cost'}</button></div>
    </form>
  </Modal>;
}
