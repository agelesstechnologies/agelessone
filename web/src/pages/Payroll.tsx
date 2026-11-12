import { useState, type FormEvent } from 'react';
import { Download, Plus, Trash2 } from 'lucide-react';
import {
  AddAdjustmentRequest, AddBankAccountRequest, AddSalaryRequest, CreateRunRequest, MarkRunPaidRequest,
  type BankAccount, type PayrollItem, type PayrollRun, type PayrollRunSummary, type Payslip, type Salary,
} from '@ageless/shared';
import { api, downloadFile, errText, formError } from '../api';
import { useAuth } from '../auth';
import { dayLabel, rupees, todayIst, useLoad, uuidv7 } from '../hooks';
import JobPicker from '../JobPicker';
import { PAYROLL } from '../permissions';
import { Badge, Empty, Loading, Modal, Notice, PageHead, Panel, Tabs, type Tone } from '../ui';

type TabKey = 'mine' | 'runs' | 'salaries' | 'banks';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (year: number, month: number) => `${MONTHS[month - 1]} ${year}`;
const RUN_TONE: Record<string, Tone> = { draft: 'amber', approved: 'blue', paid: 'green' };
const COMPANIES = [{ code: 'AE', name: 'Ageless Entertainments' }, { code: 'ATPL', name: 'Ageless Technologies' }];

export default function Payroll() {
  const { can } = useAuth();
  const staff = can(PAYROLL.prepare) || can(PAYROLL.approve);
  const tabs: { key: TabKey; label: string }[] = [
    ...(can(PAYROLL.payslip) ? [{ key: 'mine' as const, label: 'My payslips' }] : []),
    ...(staff ? [{ key: 'runs' as const, label: 'Payroll runs' }, { key: 'salaries' as const, label: 'Salaries' }, { key: 'banks' as const, label: 'Bank accounts' }] : []),
  ];
  const [tab, setTab] = useState<TabKey>(tabs[0]?.key ?? 'mine');
  return <>
    <PageHead eyebrow="ACCOUNTS • PAYROLL" title="Payroll" subtitle="Your payslips, and monthly salary runs for each company." />
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'mine' && <MyPayslips />}
    {tab === 'runs' && <Runs />}
    {tab === 'salaries' && <Salaries />}
    {tab === 'banks' && <Banks />}
  </>;
}

function MyPayslips() {
  const q = useLoad(() => api<Payslip[]>('/payroll/payslips/mine'));
  const [error, setError] = useState('');
  async function pdf(p: Payslip) {
    setError('');
    try { await downloadFile(`/payroll/payslips/${p.item.publicId}/pdf`, `payslip-${p.run.year}-${p.run.month}.pdf`); }
    catch (e) { setError(errText(e)); }
  }
  return <Panel title="My payslips" note="Shown once the month's payroll is approved.">
    <div className="panel-body">
      {(q.error || error) && <Notice>{q.error || error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No payslips yet" text="A payslip appears after payroll for the month is approved." /> :
        <div className="table-wrap"><table><thead><tr><th>MONTH</th><th>COMPANY</th><th>SALARY</th><th>ADDITIONS</th><th>DEDUCTIONS</th><th>NET PAY</th><th>STATUS</th><th /></tr></thead>
          <tbody>{q.data.map((p) => <tr key={p.item.publicId}>
            <td>{monthLabel(p.run.year, p.run.month)}</td><td>{p.run.companyName}</td>
            <td>{rupees(p.item.salaryForMonthPaise)}</td><td>{rupees(p.item.additionsTotalPaise)}</td><td>{rupees(p.item.deductionsTotalPaise)}</td>
            <td><b>{rupees(p.item.netPayPaise)}</b></td><td><Badge tone={RUN_TONE[p.run.status] ?? 'gray'}>{p.run.status}</Badge></td>
            <td><button className="outline-btn" onClick={() => pdf(p)}><Download size={13} /> PDF</button></td></tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}

function Runs() {
  const { can } = useAuth();
  const [year, setYear] = useState(new Date().getFullYear());
  const [company, setCompany] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useLoad(() => api<PayrollRunSummary[]>(`/payroll/runs?year=${year}${company ? `&company=${company}` : ''}`), [year, company]);
  return <Panel title="Payroll runs" action={can(PAYROLL.prepare) ? <button className="primary-btn" onClick={() => setCreating(true)}><Plus size={16} /> New run</button> : undefined}>
    <div className="panel-body">
      <div className="filters">
        <label className="inline-field">Company
          <select id="run-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All</option>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <label className="inline-field">Year
          <input id="run-year" className="input" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || year)} /></label>
      </div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No payroll runs" text="Lock the month's attendance, then create the run." /> :
        <div className="table-wrap"><table><thead><tr><th>MONTH</th><th>COMPANY</th><th>PEOPLE</th><th>SALARY</th><th>NET PAY</th><th>STATUS</th></tr></thead>
          <tbody>{q.data.map((r) => <tr key={r.publicId} className="link-row" onClick={() => setOpen(r.publicId)}>
            <td>{monthLabel(r.year, r.month)}</td><td>{r.company}</td><td>{r.totals.people}</td>
            <td>{rupees(r.totals.salaryForMonthPaise)}</td><td><b>{rupees(r.totals.netPaise)}</b></td>
            <td><Badge tone={RUN_TONE[r.status] ?? 'gray'}>{r.status}</Badge></td></tr>)}</tbody></table></div>}
    </div>
    {creating && <NewRun onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); q.reload(); setOpen(id); }} />}
    {open && <RunDetail id={open} onClose={() => setOpen(null)} onChanged={q.reload} />}
  </Panel>;
}

function NewRun({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = CreateRunRequest.safeParse({ company: String(f.get('company')), year: Number(f.get('year')), month: Number(f.get('month')) });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { const run = await api<PayrollRun>('/payroll/runs', { method: 'POST', json: parsed.data }); onSaved(run.publicId); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="New payroll run" subtitle="The month's attendance must be locked first." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label className="span-two">Company<select id="newrun-company" name="company">{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <label>Month<select id="newrun-month" name="month" defaultValue={prev.getMonth() + 1}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
        <label>Year<input id="newrun-year" name="year" type="number" defaultValue={prev.getFullYear()} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Creating…' : 'Create run'}</button></div>
    </form>
  </Modal>;
}

function RunDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const q = useLoad(() => api<PayrollRun>(`/payroll/runs/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<PayrollItem | null>(null);
  const [paying, setPaying] = useState(false);
  const run = q.data;
  const draft = run?.status === 'draft';

  /** Run one action; the answer is the updated run. */
  async function act(fn: () => Promise<PayrollRun | void>) {
    setBusy(true); setError('');
    try { const r = await fn(); if (r) q.setData(r); onChanged(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }
  const post = (action: string) => act(() => api<PayrollRun>(`/payroll/runs/${id}/${action}`, { method: 'POST' }));
  const file = (kind: 'register' | 'bank-file') => act(async () => { await downloadFile(`/payroll/runs/${id}/${kind}`, `${kind}.csv`); });

  return <Modal title={run ? `${run.company} · ${monthLabel(run.year, run.month)}` : 'Payroll run'} subtitle={run ? `Status: ${run.status}` : undefined} onClose={onClose}>
    {error && <Notice>{error}</Notice>}
    {q.error && <Notice>{q.error}</Notice>}
    {!run ? <Loading /> : <>
      <div className="kpi-row">
        <div className="kpi"><small>PEOPLE</small><strong>{run.totals.people}</strong></div>
        <div className="kpi"><small>SALARY FOR MONTH</small><strong>{rupees(run.totals.salaryForMonthPaise)}</strong></div>
        <div className="kpi"><small>NET PAY</small><strong>{rupees(run.totals.netPaise)}</strong><span>+{rupees(run.totals.additionsPaise)} · −{rupees(run.totals.deductionsPaise)}</span></div>
      </div>
      {run.withoutSalary.length > 0 && <Notice>{run.withoutSalary.length} job{run.withoutSalary.length === 1 ? ' has' : 's have'} no salary and will not be paid: {run.withoutSalary.map((w) => `${w.person.displayName} (${w.employment.employeeCode})`).join(', ')}.</Notice>}
      <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>ABSENT</th><th>SALARY</th><th>ADJUSTMENTS</th><th>NET</th>{draft && <th />}</tr></thead>
        <tbody>{run.items.map((it) => <tr key={it.publicId}>
          <td>{it.person.displayName}<small className="sub">{it.employment.employeeCode}</small></td>
          <td>{it.absentDays}</td><td>{rupees(it.salaryForMonthPaise)}<small className="sub">of {rupees(it.monthlySalaryPaise)}</small></td>
          <td>{it.adjustments.length === 0 ? '—' : it.adjustments.map((a) => <div key={a.publicId}>
            {a.kind === 'addition' ? '+' : '−'}{rupees(a.amountPaise)} {a.label}
            {draft && can(PAYROLL.prepare) && <button className="icon-button" style={{ display: 'inline-grid' }} aria-label={`Remove ${a.label}`} disabled={busy}
              onClick={() => act(() => api<PayrollRun>(`/payroll/adjustments/${a.publicId}`, { method: 'DELETE' }))}><Trash2 size={12} /></button>}</div>)}</td>
          <td><b>{rupees(it.netPayPaise)}</b></td>
          {draft && <td>{can(PAYROLL.prepare) && <button className="outline-btn" onClick={() => setAdding(it)}><Plus size={12} /> Adjust</button>}</td>}</tr>)}</tbody></table></div>
      <div className="modal-foot">
        {draft && can(PAYROLL.prepare) && <button className="outline-btn" disabled={busy} onClick={() => post('recalculate')}>Recalculate</button>}
        {draft && can(PAYROLL.approve) && <button className="primary-btn" disabled={busy} onClick={() => post('approve')}>Approve</button>}
        {run.status === 'approved' && can(PAYROLL.prepare) && <button className="primary-btn" disabled={busy} onClick={() => setPaying(true)}>Mark paid</button>}
        {run.status !== 'draft' && <>
          <button className="outline-btn" disabled={busy} onClick={() => file('register')}><Download size={13} /> Register</button>
          <button className="outline-btn" disabled={busy} onClick={() => file('bank-file')}><Download size={13} /> Bank file</button></>}
      </div>
      {run.status === 'paid' && <p className="muted-text">Paid {run.paidAt ? new Date(run.paidAt).toLocaleDateString('en-IN') : ''} · ref {run.bankRef}</p>}
    </>}
    {adding && <AdjustmentForm item={adding} onClose={() => setAdding(null)} onSaved={(r) => { q.setData(r); onChanged(); setAdding(null); }} />}
    {paying && <MarkPaid id={id} onClose={() => setPaying(false)} onSaved={(r) => { q.setData(r); onChanged(); setPaying(false); }} />}
  </Modal>;
}

function AdjustmentForm({ item, onClose, onSaved }: { item: PayrollItem; onClose: () => void; onSaved: (r: PayrollRun) => void }) {
  const [adjId] = useState(uuidv7);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = AddAdjustmentRequest.safeParse({
      publicId: adjId, kind: String(f.get('kind')), label: String(f.get('label')), amountPaise: Math.round(Number(f.get('amount')) * 100),
      ...(String(f.get('note')).trim() ? { note: String(f.get('note')) } : {}),
    });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { onSaved(await api<PayrollRun>(`/payroll/items/${item.publicId}/adjustments`, { method: 'POST', json: parsed.data })); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Add adjustment" subtitle={item.person.displayName} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Type<select id="adj-kind" name="kind"><option value="deduction">Deduction</option><option value="addition">Addition</option></select></label>
        <label>Label<input id="adj-label" name="label" required placeholder="PT, TDS, Advance, Bonus…" /></label>
        <label>Amount (₹)<input id="adj-amount" name="amount" type="number" min="0.01" step="0.01" required /></label>
        <label>Note <span className="optional">optional</span><input id="adj-note" name="note" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Add'}</button></div>
    </form>
  </Modal>;
}

function MarkPaid({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: (r: PayrollRun) => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = MarkRunPaidRequest.safeParse({ paidAt: new Date(`${String(f.get('paidOn'))}T12:00:00+05:30`).toISOString(), bankRef: String(f.get('bankRef')) });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { onSaved(await api<PayrollRun>(`/payroll/runs/${id}/mark-paid`, { method: 'POST', json: parsed.data })); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Mark as paid" subtitle="After the bank transfer is done." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Paid on<input id="paid-on" name="paidOn" type="date" required defaultValue={new Date().toLocaleDateString('en-CA')} /></label>
        <label>Bank reference<input id="paid-ref" name="bankRef" required minLength={3} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Mark paid'}</button></div>
    </form>
  </Modal>;
}

const COMPANY_FILTER = (value: string, onChange: (v: string) => void) =>
  <label className="inline-field">Company
    <select id="pay-company" className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All</option>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>;

function Salaries() {
  const { can } = useAuth();
  const [company, setCompany] = useState('');
  const [adding, setAdding] = useState(false);
  const q = useLoad(() => api<Salary[]>(`/payroll/salaries${company ? `?company=${company}` : ''}`), [company]);
  return <Panel title="Salaries" note="Fixed monthly salary per job. A change is a new row from a date; nothing is edited."
    action={can(PAYROLL.prepare) ? <button className="primary-btn" onClick={() => setAdding(true)}><Plus size={16} /> Add salary</button> : undefined}>
    <div className="panel-body">
      <div className="filters">{COMPANY_FILTER(company, setCompany)}</div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No salaries yet" text="Add a salary before creating the month's payroll run." /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>COMPANY</th><th>MONTHLY SALARY</th><th>FROM</th><th>NOTE</th></tr></thead>
          <tbody>{q.data.map((x) => <tr key={x.publicId}>
            <td><b>{x.person.displayName}</b><small className="sub">{x.employment.employeeCode}</small></td><td>{x.employment.company}</td>
            <td><b>{rupees(x.monthlyAmountPaise)}</b></td><td>{dayLabel(x.effectiveFrom)}</td><td>{x.note ?? '—'}</td></tr>)}</tbody></table></div>}
    </div>
    {adding && <AddSalary onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.reload(); }} />}
  </Panel>;
}

function AddSalary({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const [job, setJob] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const note = String(f.get('note')).trim();
    const parsed = AddSalaryRequest.safeParse({
      publicId: id, employmentPublicId: job, monthlyAmountPaise: Math.round(Number(f.get('amount')) * 100),
      effectiveFrom: String(f.get('from')), ...(note ? { note } : {}),
    });
    if (!parsed.success) { setError(job ? formError(parsed.error, 'Check the form') : 'Choose a person and job'); return; }
    setSaving(true); setError('');
    try { await api('/payroll/salaries', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Add salary" subtitle="Monthly salary for one job, from a date." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <JobPicker idPrefix="sal" onChange={setJob} />
        <label>Monthly salary (₹)<input id="sal-amount" name="amount" type="number" min="1" step="0.01" required /></label>
        <label>Effective from<input id="sal-from" name="from" type="date" required defaultValue={todayIst()} /></label>
        <label className="span-two">Note <span className="optional">optional</span><input id="sal-note" name="note" maxLength={200} placeholder="e.g. Annual revision" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Add salary'}</button></div>
    </form>
  </Modal>;
}

function Banks() {
  const { can } = useAuth();
  const [company, setCompany] = useState('');
  const [adding, setAdding] = useState(false);
  const q = useLoad(() => api<BankAccount[]>(`/payroll/bank-accounts${company ? `?company=${company}` : ''}`), [company]);
  return <Panel title="Bank accounts" note="Where each job's salary is paid. Account numbers are masked."
    action={can(PAYROLL.prepare) ? <button className="primary-btn" onClick={() => setAdding(true)}><Plus size={16} /> Add bank account</button> : undefined}>
    <div className="panel-body">
      <div className="filters">{COMPANY_FILTER(company, setCompany)}</div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No bank accounts yet" text="The bank file needs one for everyone being paid." /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>COMPANY</th><th>ACCOUNT HOLDER</th><th>ACCOUNT</th><th>IFSC</th><th>FROM</th></tr></thead>
          <tbody>{q.data.map((x) => <tr key={x.publicId}>
            <td><b>{x.person.displayName}</b><small className="sub">{x.employment.employeeCode}</small></td><td>{x.employment.company}</td>
            <td>{x.accountHolder}</td><td>{x.accountNumberMasked}</td><td>{x.ifsc}</td><td>{dayLabel(x.effectiveFrom)}</td></tr>)}</tbody></table></div>}
    </div>
    {adding && <AddBank onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.reload(); }} />}
  </Panel>;
}

function AddBank({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const [job, setJob] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = AddBankAccountRequest.safeParse({
      publicId: id, employmentPublicId: job, accountHolder: String(f.get('holder')), accountNumber: String(f.get('number')),
      ifsc: String(f.get('ifsc')), effectiveFrom: String(f.get('from')),
    });
    if (!parsed.success) { setError(job ? formError(parsed.error, 'Check the form') : 'Choose a person and job'); return; }
    setSaving(true); setError('');
    try { await api('/payroll/bank-accounts', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Add bank account" subtitle="Where this job's salary is paid, from a date." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <JobPicker idPrefix="bank" onChange={setJob} />
        <label className="span-two">Account holder<input id="bank-holder" name="holder" required minLength={2} maxLength={100} /></label>
        <label>Account number<input id="bank-number" name="number" required inputMode="numeric" autoComplete="off" /></label>
        <label>IFSC<input id="bank-ifsc" name="ifsc" required placeholder="HDFC0001234" /></label>
        <label className="span-two">Effective from<input id="bank-from" name="from" type="date" required defaultValue={todayIst()} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Add bank account'}</button></div>
    </form>
  </Modal>;
}
