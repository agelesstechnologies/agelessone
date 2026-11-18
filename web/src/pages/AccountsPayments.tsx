import { useState, type FormEvent } from 'react';
import { Ban, Check, FileUp, Link2, Plus, X } from 'lucide-react';
import {
  BANK_LEDGER_KEYS, BankImportRequest, MarkBatchPaid, NewPaymentBatch, NewPaymentRequest, PaymentDecision,
  type AccountsAccess, type BankImportLine, type BankLine, type PaymentBatch, type PaymentBatchDetail, type PaymentRequest, type PaymentsSummary, type TrialBalance,
} from '@ageless/shared';
import { api, errText } from '../api';
import { useAuth } from '../auth';
import { rupees, todayIst, useLoad, words } from '../hooks';
import { Badge, Empty, Loading, Modal, Notice, type Tone } from '../ui';

const REQUEST_TONE: Record<string, Tone> = { pending: 'amber', approved: 'blue', rejected: 'red', batched: 'blue', paid: 'green', cancelled: 'gray' };
const BATCH_TONE: Record<string, Tone> = { draft: 'amber', approved: 'blue', paid: 'green', cancelled: 'gray' };
const LINE_TONE: Record<string, Tone> = { unmatched: 'amber', matched: 'green' };

type Props = { company: string; access: AccountsAccess };

/** Asks for a reason (3+ characters) and runs `act` with it. Used to reject and cancel. */
function ReasonModal({ title, action, onClose, onDone }: { title: string; action: (note: string) => Promise<unknown>; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = PaymentDecision.safeParse({ note: String(new FormData(e.currentTarget).get('note') ?? '') });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Give a reason'); return; }
    setSaving(true); setError('');
    try { await action(parsed.data.note); onDone(); } catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title={title} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid one"><label>Reason<input id="reason-note" name="note" required maxLength={300} autoFocus /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Back</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Confirm'}</button></div>
    </form>
  </Modal>;
}

// ---- payment requests ----

export function PaymentRequestsTab({ company, access }: Props) {
  const { me } = useAuth();
  const [state, setState] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState<{ r: PaymentRequest; what: 'reject' | 'cancel' } | null>(null);
  const q = useLoad(() => api<PaymentRequest[]>(`/accounts/payment-requests?company=${company}${state ? `&state=${state}` : ''}`), [company, state]);

  async function approve(r: PaymentRequest) {
    setError('');
    try { await api(`/accounts/payment-requests/${r.publicId}/approve`, { method: 'POST' }); q.reload(); } catch (e) { setError(errText(e)); }
  }
  return <>
    <div className="filters">
      <label className="inline-field">State
        <select id="pr-state" className="input" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All</option>{['pending', 'approved', 'batched', 'paid', 'rejected', 'cancelled'].map((s) => <option key={s} value={s}>{words(s)}</option>)}</select></label>
      {access.maker && <button className="primary-btn" onClick={() => setAdding(true)}><Plus size={12} /> New request</button>}
    </div>
    <p className="muted-text">The Accounts maker asks for a payment; a different person (the Accounts checker) approves it. Approved requests are paid through a payment batch.</p>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {q.error && <Notice>{q.error}</Notice>}
    {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No payment requests" text="Use New request to ask for a payment." /> :
      <div className="table-wrap"><table><thead><tr><th>PAYEE</th><th>PURPOSE</th><th>AMOUNT</th><th>DUE</th><th>STATE</th><th>REQUESTED BY</th><th /></tr></thead>
        <tbody>{q.data.map((r) => <tr key={r.publicId}>
          <td>{r.payeeName}<small className="sub">{r.payeeKind}</small></td><td>{r.purpose}{r.decisionNote && <small className="sub">{r.decisionNote}</small>}</td>
          <td>{rupees(r.amountMinor)}</td><td>{r.dueDate}</td><td><Badge tone={REQUEST_TONE[r.state] ?? 'gray'}>{r.state}</Badge></td>
          <td>{r.requestedBy.displayName}{r.decidedBy && <small className="sub">Decided by {r.decidedBy.displayName}</small>}</td>
          <td className="row-actions">{r.state === 'pending' && <>
            {access.checker && r.requestedBy.publicId !== me?.person.publicId && <>
              <button className="primary-btn" onClick={() => void approve(r)}><Check size={12} /> Approve</button>
              <button className="outline-btn" onClick={() => setReason({ r, what: 'reject' })}><X size={12} /> Reject</button></>}
            {access.maker && <button className="outline-btn" onClick={() => setReason({ r, what: 'cancel' })}><Ban size={12} /> Cancel</button>}</>}</td>
        </tr>)}</tbody></table></div>}
    {adding && <NewRequestForm company={company} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.reload(); }} />}
    {reason && <ReasonModal title={`${reason.what === 'reject' ? 'Reject' : 'Cancel'} payment to ${reason.r.payeeName}`} onClose={() => setReason(null)} onDone={() => { setReason(null); q.reload(); }}
      action={(note) => api(`/accounts/payment-requests/${reason.r.publicId}/${reason.what}`, { method: 'POST', json: { note } })} />}
  </>;
}

function NewRequestForm({ company, onClose, onSaved }: { company: string; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [publicId] = useState(() => crypto.randomUUID());   // one id per open form: a double click is stored once
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = NewPaymentRequest.safeParse({
      publicId, company, payeeName: String(f.get('payeeName') ?? ''), payeeKind: String(f.get('payeeKind') ?? ''), purpose: String(f.get('purpose') ?? ''),
      amountMinor: Math.round(Number(f.get('amount')) * 100), dueDate: String(f.get('dueDate') ?? ''),
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setSaving(true); setError('');
    try { await api('/accounts/payment-requests', { method: 'POST', json: parsed.data }); onSaved(); } catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title={`New payment request · ${company}`} subtitle="Waits for the Accounts checker to approve." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Payee<input id="pr-payee" name="payeeName" required maxLength={120} autoFocus /></label>
        <label>Kind<select id="pr-kind" name="payeeKind" defaultValue="vendor"><option value="vendor">Vendor</option><option value="employee">Employee</option><option value="other">Other</option></select></label>
        <label>Amount (₹)<input id="pr-amount" name="amount" type="number" min="0.01" step="0.01" required /></label>
        <label>Due date<input id="pr-due" name="dueDate" type="date" required defaultValue={todayIst()} /></label>
      </div>
      <div className="form-grid one"><label>Purpose<input id="pr-purpose" name="purpose" required maxLength={300} /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Ask for payment'}</button></div>
    </form>
  </Modal>;
}

// ---- payment batches ----

export function PaymentBatchesTab({ company, access }: Props) {
  const [building, setBuilding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useLoad(() => api<PaymentBatch[]>(`/accounts/payment-batches?company=${company}`), [company]);
  return <>
    <div className="filters">{access.maker && <button className="primary-btn" onClick={() => setBuilding(true)}><Plus size={12} /> Build batch</button>}</div>
    <p className="muted-text">A batch pays approved requests together from one bank account. The maker builds it, a different person approves it, then the maker marks it paid with the bank reference.</p>
    {q.error && <Notice>{q.error}</Notice>}
    {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No payment batches" text="Approve some payment requests, then build a batch." /> :
      <div className="table-wrap"><table><thead><tr><th>CREATED</th><th>BANK</th><th>REQUESTS</th><th>TOTAL</th><th>STATE</th><th>BANK REFERENCE</th></tr></thead>
        <tbody>{q.data.map((b) => <tr key={b.publicId} onClick={() => setOpen(b.publicId)}>
          <td>{new Date(b.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}<small className="sub">{b.createdBy.displayName}</small></td>
          <td className="mono">{b.bankLedgerKey}</td><td>{b.requestCount}</td><td>{rupees(b.totalMinor)}</td>
          <td><Badge tone={BATCH_TONE[b.state] ?? 'gray'}>{b.state}</Badge>{b.reconciled && <Badge tone="green">Reconciled</Badge>}</td>
          <td>{b.bankReference ?? '—'}{b.paidOn && <small className="sub">Paid {b.paidOn}</small>}</td></tr>)}</tbody></table></div>}
    {building && <BuildBatchForm company={company} onClose={() => setBuilding(false)} onSaved={() => { setBuilding(false); q.reload(); }} />}
    {open && <BatchDetail id={open} access={access} onClose={() => setOpen(null)} onChanged={() => q.reload()} />}
  </>;
}

function BuildBatchForm({ company, onClose, onSaved }: { company: string; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [publicId] = useState(() => crypto.randomUUID());
  const q = useLoad(() => api<PaymentRequest[]>(`/accounts/payment-requests?company=${company}&state=approved`), [company]);
  const total = (q.data ?? []).filter((r) => picked.includes(r.publicId)).reduce((s, r) => s + r.amountMinor, 0);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = NewPaymentBatch.safeParse({ publicId, company, bankLedgerKey: String(new FormData(e.currentTarget).get('bank') ?? ''), requestPublicIds: picked });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setSaving(true); setError('');
    try { await api('/accounts/payment-batches', { method: 'POST', json: parsed.data }); onSaved(); } catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title={`Build payment batch · ${company}`} subtitle="Only approved requests can be added." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid one"><label>Pay from<select id="pb-bank" name="bank" defaultValue="bank.operating">{BANK_LEDGER_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label></div>
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No approved requests" text="Approve a payment request first." /> :
        <div className="table-wrap"><table><thead><tr><th /><th>PAYEE</th><th>PURPOSE</th><th>AMOUNT</th></tr></thead>
          <tbody>{q.data.map((r) => <tr key={r.publicId}>
            <td><input type="checkbox" aria-label={`Add ${r.payeeName}`} checked={picked.includes(r.publicId)}
              onChange={(e) => setPicked(e.target.checked ? [...picked, r.publicId] : picked.filter((x) => x !== r.publicId))} /></td>
            <td>{r.payeeName}</td><td>{r.purpose}</td><td>{rupees(r.amountMinor)}</td></tr>)}</tbody></table></div>}
      <p className="muted-text">{picked.length} selected · {rupees(total)}</p>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving || !picked.length}>{saving ? 'Saving…' : 'Build batch'}</button></div>
    </form>
  </Modal>;
}

function BatchDetail({ id, access, onClose, onChanged }: { id: string; access: AccountsAccess; onClose: () => void; onChanged: () => void }) {
  const { me } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const q = useLoad(() => api<PaymentBatchDetail>(`/accounts/payment-batches/${id}`), [id]);
  const b = q.data;
  async function run(path: string, json?: unknown) {
    setBusy(true); setError('');
    try { await api(`/accounts/payment-batches/${id}/${path}`, { method: 'POST', ...(json !== undefined ? { json } : {}) }); q.reload(); onChanged(); }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  async function pay(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = MarkBatchPaid.safeParse({ paidOn: String(f.get('paidOn') ?? ''), bankReference: String(f.get('bankReference') ?? '') });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    await run('mark-paid', parsed.data);
    setPaying(false);
  }
  return <Modal title={b ? `Payment batch · ${rupees(b.totalMinor)}` : 'Payment batch'} subtitle={b ? `${b.company} · ${b.bankLedgerKey} · ${b.state}` : undefined} onClose={onClose}>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {!b ? <Loading /> : <>
      <div className="table-wrap"><table><thead><tr><th>PAYEE</th><th>PURPOSE</th><th>AMOUNT</th></tr></thead>
        <tbody>{b.requests.map((r) => <tr key={r.publicId}><td>{r.payeeName}</td><td>{r.purpose}</td><td>{rupees(r.amountMinor)}</td></tr>)}</tbody></table></div>
      <p className="muted-text">Built by {b.createdBy.displayName}{b.approvedBy ? ` · approved by ${b.approvedBy.displayName}` : ''}{b.paidBy ? ` · paid by ${b.paidBy.displayName} on ${b.paidOn}, ref ${b.bankReference}` : ''}.</p>
      {b.state === 'draft' && b.createdBy.publicId === me?.person.publicId && <p className="muted-text">A different person (the Accounts checker) must approve the batch you built.</p>}
      {paying && <form onSubmit={pay} className="form-grid">
        <label>Paid on<input id="pb-paid-on" name="paidOn" type="date" required defaultValue={todayIst()} /></label>
        <label>Bank reference (UTR)<input id="pb-ref" name="bankReference" required maxLength={60} autoFocus /></label>
        <div className="modal-foot"><button type="button" className="outline-btn" onClick={() => setPaying(false)}>Back</button><button className="primary-btn" disabled={busy}>Confirm paid</button></div></form>}
      {!paying && <div className="modal-foot">
        {b.state === 'draft' && access.checker && b.createdBy.publicId !== me?.person.publicId && <button className="primary-btn" disabled={busy} onClick={() => void run('approve')}><Check size={12} /> Approve</button>}
        {b.state === 'approved' && access.maker && <button className="primary-btn" disabled={busy} onClick={() => setPaying(true)}>Mark paid</button>}
        {(b.state === 'draft' || b.state === 'approved') && (access.maker || access.checker) && <button className="outline-btn" disabled={busy} onClick={() => setCancelling(true)}><Ban size={12} /> Cancel batch</button>}
      </div>}
    </>}
    {cancelling && <ReasonModal title="Cancel this payment batch" onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); q.reload(); onChanged(); }}
      action={(note) => api(`/accounts/payment-batches/${id}/cancel`, { method: 'POST', json: { note } })} />}
  </Modal>;
}

// ---- bank ----

/** Turns pasted CSV rows `date,description,reference,debit,credit` (amounts in rupees) into import lines. */
function parseStatement(text: string): { lines: BankImportLine[]; error: string } {
  const lines: BankImportLine[] = [];
  const rows = text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  for (const [i, row] of rows.entries()) {
    const c = row.split(',').map((x) => x.trim());
    if (i === 0 && /date/i.test(c[0] ?? '')) continue;   // header row
    if (c.length < 5) return { lines: [], error: `Line ${i + 1}: expected date, description, reference, debit, credit` };
    const debit = Math.round(Number(c[3] || 0) * 100), credit = Math.round(Number(c[4] || 0) * 100);
    if (Number.isNaN(debit) || Number.isNaN(credit)) return { lines: [], error: `Line ${i + 1}: the amounts must be numbers` };
    lines.push({ txnDate: c[0]!, description: c[1]!, ...(c[2] ? { reference: c[2] } : {}), debitMinor: debit, creditMinor: credit });
  }
  return { lines, error: '' };
}

export function BankTab({ company, access }: Props) {
  const [bank, setBank] = useState('');
  const [state, setState] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [importing, setImporting] = useState(false);
  const [matching, setMatching] = useState<BankLine | null>(null);
  const q = useLoad(() => api<BankLine[]>(`/accounts/bank/lines?company=${company}${bank ? `&bankLedgerKey=${bank}` : ''}${state ? `&state=${state}` : ''}`), [company, bank, state]);
  return <>
    <div className="filters">
      <label className="inline-field">Bank
        <select id="bk-bank" className="input" value={bank} onChange={(e) => setBank(e.target.value)}><option value="">All</option>{BANK_LEDGER_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
      <label className="inline-field">State
        <select id="bk-state" className="input" value={state} onChange={(e) => setState(e.target.value)}><option value="">All</option><option value="unmatched">Unmatched</option><option value="matched">Matched</option></select></label>
      {access.maker && <button className="primary-btn" onClick={() => setImporting(true)}><FileUp size={12} /> Import statement</button>}
    </div>
    <p className="muted-text">Import the bank statement, then match each money-out line to the paid payment batch it settled (same bank, same amount).</p>
    {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {q.error && <Notice>{q.error}</Notice>}
    {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No bank lines" text="Use Import statement to add the bank's transactions." /> :
      <div className="table-wrap"><table><thead><tr><th>DATE</th><th>DESCRIPTION</th><th>BANK</th><th>MONEY OUT</th><th>MONEY IN</th><th>STATE</th><th /></tr></thead>
        <tbody>{q.data.map((l) => <tr key={l.publicId}>
          <td>{l.txnDate}</td><td>{l.description}{l.reference && <small className="sub">Ref {l.reference}</small>}</td><td className="mono">{l.bankLedgerKey}</td>
          <td>{l.debitMinor ? rupees(l.debitMinor) : ''}</td><td>{l.creditMinor ? rupees(l.creditMinor) : ''}</td>
          <td><Badge tone={LINE_TONE[l.state] ?? 'gray'}>{l.state}</Badge></td>
          <td className="row-actions">{access.maker && l.state === 'unmatched' && l.debitMinor > 0 &&
            <button className="outline-btn" onClick={() => setMatching(l)}><Link2 size={12} /> Match</button>}</td></tr>)}</tbody></table></div>}
    {importing && <ImportForm company={company} onClose={() => setImporting(false)}
      onSaved={(msg) => { setImporting(false); setNote(msg); q.reload(); }} />}
    {matching && <MatchForm company={company} line={matching} onClose={() => setMatching(null)} onError={setError} onSaved={() => { setMatching(null); q.reload(); }} />}
  </>;
}

function ImportForm({ company, onClose, onSaved }: { company: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const { lines, error: bad } = parseStatement(String(f.get('rows') ?? ''));
    if (bad) { setError(bad); return; }
    const parsed = BankImportRequest.safeParse({ company, bankLedgerKey: String(f.get('bank') ?? ''), lines });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the rows'); return; }
    setSaving(true); setError('');
    try {
      const r = await api<{ imported: number; skipped: number }>('/accounts/bank/import', { method: 'POST', json: parsed.data });
      onSaved(`Imported ${r.imported} line(s); ${r.skipped} already on file.`);
    } catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title={`Import bank statement · ${company}`} subtitle="One row per line: date (YYYY-MM-DD), description, reference, money out, money in. Amounts in rupees." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid one">
        <label>Bank<select id="bk-import-bank" name="bank" defaultValue="bank.operating">{BANK_LEDGER_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
        <label>Rows<textarea id="bk-rows" name="rows" rows={8} required className="input mono" placeholder={'2026-11-05,NEFT to Demo Vendor,UTR123,2500.00,\n2026-11-06,Customer receipt,UTR456,,10000.00'} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Importing…' : 'Import'}</button></div>
    </form>
  </Modal>;
}

function MatchForm({ company, line, onClose, onError, onSaved }: { company: string; line: BankLine; onClose: () => void; onError: (m: string) => void; onSaved: () => void }) {
  const q = useLoad(() => api<PaymentBatch[]>(`/accounts/payment-batches?company=${company}`), [company]);
  const options = (q.data ?? []).filter((b) => b.state === 'paid' && !b.reconciled && b.bankLedgerKey === line.bankLedgerKey && b.totalMinor === line.debitMinor);
  async function match(batch: PaymentBatch) {
    try { await api(`/accounts/bank/lines/${line.publicId}/match`, { method: 'POST', json: { batchPublicId: batch.publicId } }); onSaved(); }
    catch (e) { onError(errText(e)); onClose(); }
  }
  return <Modal title={`Match ${rupees(line.debitMinor)} · ${line.txnDate}`} subtitle={line.description} onClose={onClose}>
    {q.loading && !q.data ? <Loading /> : !options.length ? <Empty title="No paid batch fits" text={`Needs a paid, not yet reconciled batch of exactly ${rupees(line.debitMinor)} on ${line.bankLedgerKey}.`} /> :
      <div className="table-wrap"><table><thead><tr><th>PAID ON</th><th>REFERENCE</th><th>REQUESTS</th><th /></tr></thead>
        <tbody>{options.map((b) => <tr key={b.publicId}><td>{b.paidOn}</td><td>{b.bankReference}</td><td>{b.requestCount}</td>
          <td className="row-actions"><button className="primary-btn" onClick={() => void match(b)}>Match</button></td></tr>)}</tbody></table></div>}
  </Modal>;
}

// ---- reports ----

export function ReportsTab({ company }: Props) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const tb = useLoad(() => api<TrialBalance>(`/accounts/reports/trial-balance?company=${company}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`), [company, from, to]);
  const sm = useLoad(() => api<PaymentsSummary>(`/accounts/reports/payments-summary?company=${company}`), [company]);
  const s = sm.data, t = tb.data;
  return <>
    <h3 className="section-title">Payments and bank</h3>
    {sm.error && <Notice>{sm.error}</Notice>}
    {!s ? <Loading /> : <div className="table-wrap"><table><thead><tr><th>WHAT</th><th>STATE</th><th>COUNT</th><th>AMOUNT</th></tr></thead>
      <tbody>
        {Object.entries(s.requests).map(([k, v]) => <tr key={`r${k}`}><td>Payment requests</td><td><Badge tone={REQUEST_TONE[k] ?? 'gray'}>{k}</Badge></td><td>{v.count}</td><td>{rupees(v.totalMinor)}</td></tr>)}
        {Object.entries(s.batches).map(([k, v]) => <tr key={`b${k}`}><td>Payment batches</td><td><Badge tone={BATCH_TONE[k] ?? 'gray'}>{k}</Badge></td><td>{v.count}</td><td>{rupees(v.totalMinor)}</td></tr>)}
        <tr><td>Bank lines</td><td>Money out, unmatched</td><td>{s.bank.unmatchedOut.count}</td><td>{rupees(s.bank.unmatchedOut.totalMinor)}</td></tr>
        <tr><td>Bank lines</td><td>Money in, unmatched</td><td>{s.bank.unmatchedIn.count}</td><td>{rupees(s.bank.unmatchedIn.totalMinor)}</td></tr>
        <tr><td>Bank lines</td><td>Matched to a batch</td><td>{s.bank.matched.count}</td><td>{rupees(s.bank.matched.totalMinor)}</td></tr>
        <tr><td>Payment batches</td><td>Paid, not yet in the bank</td><td>{s.bank.paidBatchesNotReconciled.count}</td><td>{rupees(s.bank.paidBatchesNotReconciled.totalMinor)}</td></tr>
      </tbody></table></div>}

    <h3 className="section-title">Trial balance</h3>
    <div className="filters">
      <label className="inline-field">From<input id="tb-from" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="inline-field">To<input id="tb-to" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
    </div>
    {tb.error && <Notice>{tb.error}</Notice>}
    {tb.loading && !t ? <Loading /> : !t?.rows.length ? <Empty title="No journal entries in this period" /> :
      <div className="table-wrap"><table><thead><tr><th>LEDGER</th><th>DEBIT</th><th>CREDIT</th><th>BALANCE</th></tr></thead>
        <tbody>{t.rows.map((r) => <tr key={r.ledgerKey}><td className="mono">{r.ledgerKey}</td><td>{r.debitMinor ? rupees(r.debitMinor) : ''}</td><td>{r.creditMinor ? rupees(r.creditMinor) : ''}</td>
          <td>{rupees(Math.abs(r.balanceMinor))} {r.balanceMinor === 0 ? '' : r.balanceMinor > 0 ? 'Dr' : 'Cr'}</td></tr>)}
          <tr><td><b>Total</b></td><td><b>{rupees(t.totalDebitMinor)}</b></td><td><b>{rupees(t.totalCreditMinor)}</b></td><td /></tr></tbody></table></div>}
  </>;
}
