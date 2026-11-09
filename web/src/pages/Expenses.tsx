import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Plus, X } from 'lucide-react';
import {
  CreateExpenseRequest, type ExpenseCategory, type ExpenseClaim, type ExpenseClaimList, type ExpenseReport,
} from '@ageless/shared';
import { api, errText, formError } from '../api';
import { useAuth } from '../auth';
import { VoiceInput } from '../VoiceInput';
import { addDays, dayLabel, rupees, todayIst, useLoad, useMyEmployments, uuidv7, words } from '../hooks';
import { EXPENSES } from '../permissions';
import { Badge, EXPENSE_TONE, Empty, Loading, Modal, Notice, PageHead, Panel, Tabs, CsvButton } from '../ui';

type TabKey = 'mine' | 'approve' | 'report';

export default function Expenses() {
  const { can } = useAuth();
  const tabs: { key: TabKey; label: string }[] = [
    ...(can(EXPENSES.submit) ? [{ key: 'mine' as const, label: 'My claims' }] : []),
    ...(can(EXPENSES.approve) ? [{ key: 'approve' as const, label: 'To approve' }] : []),
    ...(can(EXPENSES.report) ? [{ key: 'report' as const, label: 'Report' }] : []),
  ];
  const [tab, setTab] = useState<TabKey>(tabs[0]?.key ?? 'mine');
  return <>
    <PageHead eyebrow="HRMS • EXPENSES" title="Expenses" subtitle="Claim what you spent, approve your team's claims, and see totals." />
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'mine' && <MyClaims />}
    {tab === 'approve' && <Approvals />}
    {tab === 'report' && <Report />}
  </>;
}

const StatusBadge = ({ claim }: { claim: ExpenseClaim }) => <Badge tone={EXPENSE_TONE[claim.status] ?? 'gray'}>{claim.status}</Badge>;

function claimDetail(c: ExpenseClaim): string {
  if (c.status === 'rejected') return c.rejectionReason ? `Reason: ${c.rejectionReason}` : 'Rejected';
  if (c.status === 'paid') return c.paymentRef ? `Paid · ref ${c.paymentRef}` : 'Paid';
  if (c.status === 'approved' && c.approvedAmountPaise !== null) return `Approved ${rupees(c.approvedAmountPaise)}`;
  return c.description ?? '';
}

function MyClaims() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const q = useLoad(() => api<ExpenseClaimList>(`/hrms/expenses/mine?page=${page}&pageSize=20${status ? `&status=${status}` : ''}`), [page, status]);
  const total = q.data?.total ?? 0;
  return <Panel title="My claims" action={<button className="primary-btn" onClick={() => setAdding(true)}><Plus size={16} /> New claim</button>}>
    <div className="panel-body">
      <div className="filters">
        <label className="inline-field">Status
          <select id="claim-status" className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">All</option><option value="submitted">Submitted</option><option value="approved">Approved</option>
            <option value="rejected">Rejected</option><option value="paid">Paid</option></select></label>
      </div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.items.length ? <Empty title="No claims yet" text="Use New claim to add your first expense." /> :
        <div className="table-wrap"><table><thead><tr><th>SPENT ON</th><th>CATEGORY</th><th>COMPANY</th><th>AMOUNT</th><th>STATUS</th><th>NOTE</th></tr></thead>
          <tbody>{q.data.items.map((c) => <tr key={c.publicId}>
            <td>{dayLabel(c.spentOn)}</td><td>{c.category.name}</td><td>{c.employment.company}</td><td>{rupees(c.amountPaise)}</td>
            <td><StatusBadge claim={c} /></td><td className="note-cell">{claimDetail(c)}{c.receiptPath && <small className="sub">Receipt attached</small>}</td></tr>)}</tbody></table></div>}
      <div className="table-footer"><span>{total} claim{total === 1 ? '' : 's'}</span>
        <div className="pagination"><button disabled={page <= 1 || q.loading} onClick={() => setPage(page - 1)}><ArrowLeft size={14} /> Previous</button>
          <button disabled={page * 20 >= total || q.loading} onClick={() => setPage(page + 1)}>Next <ArrowRight size={14} /></button></div></div>
    </div>
    {adding && <NewClaim onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setPage(1); q.reload(); }} />}
  </Panel>;
}

function NewClaim({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { jobs, primary, error: jobsError } = useMyEmployments();
  const cats = useLoad(() => api<ExpenseCategory[]>('/hrms/expenses/categories'));
  const [claimId] = useState(uuidv7); // one id per form, so pressing Submit twice stores one claim
  const [jobId, setJobId] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!jobId && primary) setJobId(primary.publicId); }, [primary, jobId]);
  useEffect(() => { if (!category && cats.data?.[0]) setCategory(cats.data[0].code); }, [cats.data, category]);
  const needsReceipt = cats.data?.find((c) => c.code === category)?.receiptRequired ?? false;

  const [photo, setPhoto] = useState<File | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : ''), [photo]);
  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);
  useEffect(() => {
    if (cameraOn && videoRef.current && streamRef.current) { videoRef.current.srcObject = streamRef.current; void videoRef.current.play(); }
  }, [cameraOn]);

  async function startCamera() {
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) { setCameraError('Camera is not available here. It needs https or localhost; use Choose File instead.'); return; }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      setCameraOn(true);
    } catch { setCameraError('Camera access was blocked. Allow it in the browser address bar, or use Choose File.'); }
  }
  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null; setCameraOn(false);
  }
  function capture() {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      setPhoto(new File([blob], `receipt-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      stopCamera();
    }, 'image/jpeg', 0.85);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const rupeeText = String(form.get('amount') ?? '').trim();
    const parsed = CreateExpenseRequest.safeParse({
      publicId: claimId, employmentPublicId: jobId, categoryCode: category, spentOn: String(form.get('spentOn')),
      amountPaise: Math.round(Number(rupeeText) * 100), description: String(form.get('description') ?? ''),
    });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    const receipt = form.get('receipt');
    const body = new FormData();
    for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) body.append(k, String(v));
    if (photo) body.append('receipt', photo);
    else if (receipt instanceof File && receipt.size > 0) body.append('receipt', receipt);
    setSaving(true); setError('');
    try { await api('/hrms/expenses', { method: 'POST', body }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }

  return <Modal title="New expense claim" subtitle="Amounts are in rupees." onClose={onClose}>
    <form onSubmit={submit}>
      {(error || jobsError || cats.error) && <Notice>{error || jobsError || cats.error}</Notice>}
      <div className="form-grid">
        {jobs.length > 1 && <label className="span-two">Company
          <select id="claim-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            {jobs.map((j) => <option key={j.publicId} value={j.publicId}>{j.company.name} · {j.employeeCode}</option>)}</select></label>}
        <label>Category
          <select id="claim-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {cats.data?.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <label>Date spent<input id="claim-date" name="spentOn" type="date" required max={todayIst()} defaultValue={todayIst()} /></label>
        <label>Amount (₹)<input id="claim-amount" name="amount" type="number" inputMode="decimal" min="0.01" step="0.01" required placeholder="0.00" /></label>
        <div>
          <label htmlFor="claim-receipt">Receipt {needsReceipt ? <span className="optional">required</span> : <span className="optional">optional</span>}</label>
          <div style={{ border: '1px solid #e3e7ee', borderRadius: 5, background: '#fff', padding: '6px 9px', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
            <input id="claim-receipt" name="receipt" type="file" accept="image/jpeg,image/png,application/pdf" required={needsReceipt && !photo}
              style={{ border: 0, padding: 0, height: 'auto', background: 'transparent', width: '100%' }} />
            <button type="button" onClick={startCamera}
              style={{ font: 'inherit', fontSize: 13, padding: '1px 6px', border: '1px solid #767676', borderRadius: 3, background: '#efefef', color: '#000', cursor: 'pointer' }}>
              {photo ? 'Retake photo' : 'Click a photo'}</button>
          </div>
        </div>
        <div className="span-two">
          {cameraError && <Notice>{cameraError}</Notice>}
          {cameraOn && <div style={{ marginTop: 12 }}>
            <video ref={videoRef} playsInline muted style={{ width: '100%', maxHeight: 320, borderRadius: 8, background: '#000' }} />
            <div className="modal-foot" style={{ marginTop: 8 }}>
              <button type="button" className="outline-btn" onClick={stopCamera}>Close camera</button>
              <button type="button" className="primary-btn" onClick={capture}>Capture</button></div></div>}
          {photo && !cameraOn && <div style={{ marginTop: 12 }}>
            <img src={photoUrl} alt="Receipt preview" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8 }} />
            <button type="button" className="outline-btn" style={{ marginLeft: 8 }} onClick={() => setPhoto(null)}>Remove photo</button></div>}
        </div>
        <label className="span-two">Description<VoiceInput id="claim-description" name="description" maxLength={500} placeholder="What was it for?" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving || !jobId || !category}>{saving ? 'Submitting…' : 'Submit claim'}</button></div>
    </form>
  </Modal>;
}

type Action = { claim: ExpenseClaim; kind: 'reject' | 'pay' };

function Approvals() {
  const { can } = useAuth();
  const q = useLoad(() => api<ExpenseClaim[]>('/hrms/expenses/to-approve'));
  const [rows, setRows] = useState<ExpenseClaim[]>([]);
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  useEffect(() => { if (q.data) setRows(q.data); }, [q.data]);

  const replace = (c: ExpenseClaim) => setRows((all) => all.map((r) => (r.publicId === c.publicId ? c : r)));

  async function approve(c: ExpenseClaim) {
    setBusyId(c.publicId); setError('');
    try { replace(await api<ExpenseClaim>(`/hrms/expenses/${c.publicId}/approve`, { method: 'POST', json: {} })); }
    catch (e) { setError(errText(e)); }
    finally { setBusyId(''); }
  }

  return <Panel title="Claims to approve" note="Submitted claims from the people who report to you.">
    <div className="panel-body">
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {q.loading ? <Loading /> : !rows.length ? <Empty title="Nothing waiting" text="New claims from your team appear here." /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>SPENT ON</th><th>CATEGORY</th><th>AMOUNT</th><th>STATUS</th><th>NOTE</th><th /></tr></thead>
          <tbody>{rows.map((c) => <tr key={c.publicId}>
            <td><b>{c.person.displayName}</b><small className="sub">{c.employment.company}</small></td><td>{dayLabel(c.spentOn)}</td><td>{c.category.name}</td>
            <td>{rupees(c.amountPaise)}</td><td><StatusBadge claim={c} /></td><td className="note-cell">{claimDetail(c)}{c.receiptPath && <small className="sub">Receipt attached</small>}</td>
            <td className="row-actions">
              {c.status === 'submitted' && <>
                <button className="outline-btn ok" disabled={busyId === c.publicId} onClick={() => void approve(c)}><Check size={13} /> Approve</button>
                <button className="outline-btn danger" onClick={() => setAction({ claim: c, kind: 'reject' })}><X size={13} /> Reject</button></>}
              {c.status === 'approved' && can(EXPENSES.pay) && <button className="outline-btn" onClick={() => setAction({ claim: c, kind: 'pay' })}>Mark paid</button>}
            </td></tr>)}</tbody></table></div>}
    </div>
    {action && <Decision action={action} onClose={() => setAction(null)} onDone={(c) => { replace(c); setAction(null); }} />}
  </Panel>;
}

function Decision({ action, onClose, onDone }: { action: Action; onClose: () => void; onDone: (c: ExpenseClaim) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reject = action.kind === 'reject';
  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (reject && t.length < 3) { setError('Give a reason of at least 3 characters'); return; }
    if (!reject && !t) { setError('Enter the payment reference'); return; }
    setBusy(true); setError('');
    try {
      const path = `/hrms/expenses/${action.claim.publicId}/${reject ? 'reject' : 'mark-paid'}`;
      onDone(await api<ExpenseClaim>(path, { method: 'POST', json: reject ? { reason: t } : { paymentRef: t } }));
    } catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }
  return <Modal title={reject ? 'Reject claim' : 'Mark as paid'} subtitle={`${action.claim.person.displayName} · ${rupees(action.claim.amountPaise)}`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid"><label className="span-two">{reject ? 'Reason' : 'Payment reference'}
        <input id="decision-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={reject ? 500 : 100} autoFocus
          placeholder={reject ? 'Tell the person why' : 'Bank or UPI reference'} /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={busy}>{reject ? 'Reject claim' : 'Mark paid'}</button></div>
    </form>
  </Modal>;
}

function Report() {
  const [to, setTo] = useState(todayIst());
  const [from, setFrom] = useState(addDays(todayIst(), -29));
  const [company, setCompany] = useState('');
  const [csvError, setCsvError] = useState('');
  const q = useLoad(() => api<ExpenseReport>(`/hrms/expenses/report?from=${from}&to=${to}${company ? `&company=${company}` : ''}`), [from, to, company]);
  const r = q.data;
  return <Panel title="Expense report" note="Claims by the date they were spent.">
    <div className="panel-body">
      <div className="filters">
        <label className="inline-field">From<input id="rep-from" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline-field">To<input id="rep-to" type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="inline-field">Company
          <select id="rep-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All companies</option><option value="AE">Ageless Entertainments</option><option value="ATPL">Ageless Technologies</option></select></label>
        <CsvButton path={`/hrms/expenses/report?from=${from}&to=${to}${company ? `&company=${company}` : ''}`} name="expense-report.csv" onError={setCsvError} />
      </div>
      {(q.error || csvError) && <Notice onClose={() => setCsvError('')}>{q.error || csvError}</Notice>}
      {q.loading && !r ? <Loading /> : r && <>
        <div className="mini-stats">
          <div><small>CLAIMS</small><strong>{r.total.count}</strong></div>
          <div><small>CLAIMED</small><strong>{rupees(r.total.amountPaise)}</strong></div>
          <div><small>APPROVED</small><strong>{rupees(r.total.approvedPaise)}</strong></div>
          <div><small>PAID</small><strong>{rupees(r.total.paidPaise)}</strong></div>
        </div>
        {!r.byCategory.length ? <Empty title="No claims in this range" /> : <>
          <div className="table-wrap"><table><thead><tr><th>CATEGORY</th><th>CLAIMS</th><th>CLAIMED</th><th>APPROVED</th><th>PAID</th></tr></thead>
            <tbody>{r.byCategory.map((c) => <tr key={c.code}><td>{c.name}</td><td>{c.count}</td><td>{rupees(c.amountPaise)}</td><td>{rupees(c.approvedPaise)}</td><td>{rupees(c.paidPaise)}</td></tr>)}</tbody></table></div>
          <div className="chip-row">{r.byStatus.map((s) => <Badge key={s.status} tone={EXPENSE_TONE[s.status] ?? 'gray'}>{words(s.status)} · {s.count} · {rupees(s.amountPaise)}</Badge>)}</div></>}
      </>}
    </div>
  </Panel>;
}
