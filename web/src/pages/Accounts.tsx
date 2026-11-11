import { useState, type FormEvent } from 'react';
import { Check, Lock, LockOpen, Pencil, Undo2 } from 'lucide-react';
import {
  DraftLedgerMapRequest, ReopenRequest, ReverseEntryRequest,
  type AccountsAccess, type JournalEntry, type JournalEntryPage, type LedgerMapEntry, type Period,
} from '@ageless/shared';
import { api, errText } from '../api';
import { useAuth } from '../auth';
import { rupees, useLoad, words } from '../hooks';
import { Badge, Empty, Loading, Modal, Notice, PageHead, Panel, Tabs, type Tone } from '../ui';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const COMPANIES = [{ code: 'ATPL', name: 'Ageless Technologies' }, { code: 'AE', name: 'Ageless Entertainments' }];
const PERIOD_TONE: Record<string, Tone> = { open: 'green', soft_closed: 'amber', closed: 'gray' };
const MAP_TONE: Record<string, Tone> = { unmapped: 'red', draft: 'amber', approved: 'green' };
const dateIn = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

type Tab = 'periods' | 'ledger' | 'journal' | 'requests' | 'batches' | 'bank' | 'tally' | 'reports';
/** Screens whose backend is not built yet. */
const SOON: { key: Tab; label: string }[] = [
  { key: 'requests', label: 'Payment requests' }, { key: 'batches', label: 'Payment batches' }, { key: 'bank', label: 'Bank' },
  { key: 'tally', label: 'Tally sync' }, { key: 'reports', label: 'Reports' },
];
const TABS: { key: Tab; label: string }[] = [
  ...SOON.slice(0, 3), ...SOON.slice(3, 4), { key: 'ledger', label: 'Ledger mapping' }, { key: 'journal', label: 'Journal entries' },
  { key: 'periods', label: 'Periods' }, SOON[4]!,
];

export default function Accounts() {
  const [tab, setTab] = useState<Tab>('periods');
  const [company, setCompany] = useState(COMPANIES[0]!.code);
  const access = useLoad(() => api<AccountsAccess>(`/accounts/access?company=${company}`), [company]);
  const a = access.data;
  return <>
    <PageHead eyebrow="ACCOUNTS" title="Accounts" subtitle="Periods, Tally ledger mapping and the journal. Tally stays the books." />
    <Panel>
      <div className="panel-body">
        <div className="filters">
          <label className="inline-field">Company
            <select id="acc-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
              {COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
          {a && <span className="muted-text">You are: {[a.maker && 'Accounts maker', a.checker && 'Accounts checker', a.ceo && 'CEO'].filter(Boolean).join(', ') || 'view only'}</span>}
        </div>
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        {access.error && <Notice>{access.error}</Notice>}
        {!a ? <Loading /> :
          tab === 'periods' ? <Periods company={company} access={a} /> :
          tab === 'ledger' ? <LedgerMap company={company} access={a} /> :
          tab === 'journal' ? <Journal company={company} access={a} /> :
          <Empty title="Coming soon" text={`${TABS.find((t) => t.key === tab)?.label} will appear here when its backend is ready.`} />}
      </div>
    </Panel>
  </>;
}

// ---- periods ----

function Periods({ company, access }: { company: string; access: AccountsAccess }) {
  const { me } = useAuth();
  const [year, setYear] = useState(new Date().getFullYear());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [asking, setAsking] = useState<Period | null>(null);
  const q = useLoad(() => api<Period[]>(`/accounts/periods?company=${company}&year=${year}`), [company, year]);

  async function act(p: Period, what: 'soft-close' | 'close' | 'reopen-approve') {
    const label = `${MONTHS[p.month - 1]} ${p.year}`;
    const text = { 'soft-close': `Soft-close ${label}?`, close: `Close ${label}? Nothing more can be posted into it.`, 'reopen-approve': `Reopen ${label}?` }[what];
    if (!window.confirm(text)) return;
    setBusy(`${what}-${p.month}`); setError('');
    try { await api(`/accounts/periods/${what}`, { method: 'POST', json: { company, year: p.year, month: p.month } }); q.reload(); }
    catch (e) { setError(errText(e)); } finally { setBusy(''); }
  }

  return <>
    <div className="filters"><label className="inline-field">Year
      <input id="acc-year" className="input" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || year)} /></label></div>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {q.error && <Notice>{q.error}</Notice>}
    {q.loading && !q.data ? <Loading /> :
      <div className="table-wrap"><table><thead><tr><th>MONTH</th><th>STATE</th><th>CLOSED BY</th><th>REOPEN</th><th /></tr></thead>
        <tbody>{q.data?.map((p) => {
          const mine = p.reopenRequestedBy?.publicId === me?.person.publicId;
          return <tr key={p.month}>
            <td>{MONTHS[p.month - 1]} {p.year}</td>
            <td><Badge tone={PERIOD_TONE[p.state] ?? 'gray'}>{words(p.state)}</Badge></td>
            <td>{p.closedBy ? <>{p.closedBy.displayName}<small className="sub">{p.closedAt ? dateIn(p.closedAt) : ''}</small></> : '—'}</td>
            <td className="note-cell">{p.reopenRequestedBy
              ? <>Asked by {p.reopenRequestedBy.displayName}: {p.reopenReason}<small className="sub">Waiting for the CEO to approve</small></>
              : p.state === 'closed' ? <small className="sub">Needs a request, then the CEO's approval</small> : ''}</td>
            <td className="row-actions">
              {access.checker && p.state === 'open' && <button className="outline-btn" disabled={!!busy} onClick={() => void act(p, 'soft-close')}><Lock size={12} /> Soft close</button>}
              {access.checker && p.state !== 'closed' && <button className="outline-btn" disabled={!!busy} onClick={() => void act(p, 'close')}><Lock size={12} /> Close</button>}
              {(access.maker || access.checker) && p.state === 'closed' && !p.reopenRequestedBy && <button className="outline-btn" onClick={() => setAsking(p)}><LockOpen size={12} /> Reopen</button>}
              {access.ceo && p.state === 'closed' && p.reopenRequestedBy && !mine && <button className="primary-btn" disabled={!!busy} onClick={() => void act(p, 'reopen-approve')}><Check size={12} /> Approve reopen</button>}
            </td></tr>;
        })}</tbody></table></div>}
    {asking && <ReopenForm company={company} period={asking} onClose={() => setAsking(null)} onSaved={() => { setAsking(null); q.reload(); }} />}
  </>;
}

function ReopenForm({ company, period, onClose, onSaved }: { company: string; period: Period; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = ReopenRequest.safeParse({ company, year: period.year, month: period.month, reason: String(new FormData(e.currentTarget).get('reason') ?? '') });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Give a reason'); return; }
    setSaving(true); setError('');
    try { await api('/accounts/periods/reopen-request', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title="Ask to reopen" subtitle={`${MONTHS[period.month - 1]} ${period.year}. The CEO must approve; the reason is kept on record.`} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid one"><label>Reason<input id="reopen-reason" name="reason" required minLength={3} maxLength={500} autoFocus /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Sending…' : 'Send request'}</button></div>
    </form>
  </Modal>;
}

// ---- ledger mapping ----

function LedgerMap({ company, access }: { company: string; access: AccountsAccess }) {
  const { me } = useAuth();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<LedgerMapEntry | null>(null);
  const [busy, setBusy] = useState('');
  const q = useLoad(() => api<LedgerMapEntry[]>(`/accounts/ledger-map?company=${company}`), [company]);
  const unmapped = q.data?.filter((m) => m.state === 'unmapped').length ?? 0;

  async function approve(m: LedgerMapEntry) {
    setBusy(m.ledgerKey); setError('');
    try { await api(`/accounts/ledger-map/${m.publicId}/approve`, { method: 'POST' }); q.reload(); }
    catch (e) { setError(errText(e)); } finally { setBusy(''); }
  }

  return <>
    {unmapped > 0 && <Notice>{unmapped} ledger {unmapped === 1 ? 'key has' : 'keys have'} no Tally ledger yet. Entries for them will wait until they are mapped and approved.</Notice>}
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {q.error && <Notice>{q.error}</Notice>}
    {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No ledger keys yet" /> :
      <div className="table-wrap"><table><thead><tr><th>LEDGER KEY</th><th>TALLY COMPANY</th><th>TALLY LEDGER</th><th>STATE</th><th>DRAFTED / APPROVED BY</th><th /></tr></thead>
        <tbody>{q.data.map((m) => <tr key={m.ledgerKey} className={m.state === 'unmapped' ? 'row-warn' : ''}>
          <td className="mono">{m.ledgerKey}</td><td>{m.tallyCompany ?? '—'}</td><td>{m.tallyLedgerName ?? '—'}</td>
          <td><Badge tone={MAP_TONE[m.state] ?? 'gray'}>{m.state}</Badge></td>
          <td>{m.draftedBy ? `Drafted by ${m.draftedBy.displayName}` : '—'}{m.approvedBy && <small className="sub">Approved by {m.approvedBy.displayName}</small>}</td>
          <td className="row-actions">
            {access.maker && <button className="outline-btn" onClick={() => setEditing(m)}><Pencil size={12} /> {m.state === 'unmapped' ? 'Map' : 'Change'}</button>}
            {access.checker && m.state === 'draft' && m.draftedBy?.publicId !== me?.person.publicId &&
              <button className="primary-btn" disabled={busy === m.ledgerKey} onClick={() => void approve(m)}><Check size={12} /> Approve</button>}
          </td></tr>)}</tbody></table></div>}
    {editing && <LedgerForm company={company} entry={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(); }} />}
  </>;
}

function LedgerForm({ company, entry, onClose, onSaved }: { company: string; entry: LedgerMapEntry; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = DraftLedgerMapRequest.safeParse({ company, ledgerKey: entry.ledgerKey, tallyCompany: String(f.get('tallyCompany')), tallyLedgerName: String(f.get('tallyLedgerName')) });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setSaving(true); setError('');
    try { await api('/accounts/ledger-map', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title={`Tally ledger for ${entry.ledgerKey}`} subtitle="Saved as a draft. The Accounts checker approves it before anything is sent to Tally." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid one">
        <label>Company name in Tally<input id="map-company" name="tallyCompany" required maxLength={120} defaultValue={entry.tallyCompany ?? ''} autoFocus /></label>
        <label>Ledger name in Tally<input id="map-ledger" name="tallyLedgerName" required maxLength={120} defaultValue={entry.tallyLedgerName ?? ''} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Save draft'}</button></div>
    </form>
  </Modal>;
}

// ---- journal entries ----

const SOURCES = ['expense_approved', 'expense_paid', 'payroll_approved', 'salary_paid', 'reversal'];
/** Where a source document is looked at in the app. */
const SOURCE_PAGE: Record<string, { href: string; label: string }> = {
  expense_approved: { href: '#expenses', label: 'Open Expenses' }, expense_paid: { href: '#expenses', label: 'Open Expenses' },
  payroll_approved: { href: '#payroll', label: 'Open Payroll' }, salary_paid: { href: '#payroll', label: 'Open Payroll' },
};

function Journal({ company, access }: { company: string; access: AccountsAccess }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sourceType, setSourceType] = useState('');
  const [ledgerKey, setLedgerKey] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<JournalEntry | null>(null);
  const qs = new URLSearchParams({ company, page: String(page), pageSize: '25', ...(from && { from }), ...(to && { to }), ...(sourceType && { sourceType }), ...(ledgerKey.trim() && { ledgerKey: ledgerKey.trim() }) });
  const q = useLoad(() => api<JournalEntryPage>(`/accounts/journal-entries?${qs}`), [company, from, to, sourceType, ledgerKey, page]);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;

  return <>
    <div className="filters">
      <label className="inline-field">From<input id="je-from" className="input" type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></label>
      <label className="inline-field">To<input id="je-to" className="input" type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} /></label>
      <label className="inline-field">Source
        <select id="je-source" className="input" value={sourceType} onChange={(e) => reset(setSourceType)(e.target.value)}>
          <option value="">All</option>{SOURCES.map((s) => <option key={s} value={s}>{words(s)}</option>)}</select></label>
      <label className="inline-field">Ledger
        <input id="je-ledger" className="input" placeholder="e.g. bank" value={ledgerKey} onChange={(e) => reset(setLedgerKey)(e.target.value)} /></label>
    </div>
    {q.error && <Notice>{q.error}</Notice>}
    {q.loading && !q.data ? <Loading /> : !q.data?.items.length ? <Empty title="No journal entries" text="Entries appear when expenses and payroll are approved and paid." /> : <>
      <div className="table-wrap"><table><thead><tr><th>DATE</th><th>SOURCE</th><th>LINES</th><th>AMOUNT</th><th>STATUS</th></tr></thead>
        <tbody>{q.data.items.map((e) => <tr key={e.publicId} onClick={() => setOpen(e)}>
          <td>{e.entryDate}</td><td>{words(e.sourceType)}</td><td>{e.lines.length}</td><td>{rupees(e.totalDebitMinor)}</td>
          <td>{e.reversedByPublicId ? <Badge tone="amber">Reversed</Badge> : e.reversesPublicId ? <Badge tone="gray">Reversal</Badge> : <Badge tone="green">Posted</Badge>}</td></tr>)}</tbody></table></div>
      <div className="table-footer"><span>{q.data.total} entries</span>
        <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div></div></>}
    {open && <EntryDetail entry={open} canReverse={access.checker} onClose={() => setOpen(null)} onReversed={() => { setOpen(null); q.reload(); }} />}
  </>;
}

function EntryDetail({ entry, canReverse, onClose, onReversed }: { entry: JournalEntry; canReverse: boolean; onClose: () => void; onReversed: () => void }) {
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const source = SOURCE_PAGE[entry.sourceType];
  async function reverse() {
    const parsed = ReverseEntryRequest.safeParse({ reason });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Give a reason'); return; }
    setSaving(true); setError('');
    try { await api(`/accounts/journal-entries/${entry.publicId}/reverse`, { method: 'POST', json: parsed.data }); onReversed(); }
    catch (e) { setError(errText(e)); setSaving(false); }
  }
  return <Modal title={`Journal entry · ${entry.entryDate}`} subtitle={`${words(entry.sourceType)} · ${entry.company}${entry.createdBy ? ` · by ${entry.createdBy.displayName}` : ''}`} onClose={onClose}>
    {error && <Notice>{error}</Notice>}
    <div className="table-wrap"><table><thead><tr><th>LEDGER</th><th>DEBIT</th><th>CREDIT</th></tr></thead>
      <tbody>{entry.lines.map((l, i) => <tr key={i}><td className="mono">{l.ledgerKey}</td><td>{l.debitMinor ? rupees(l.debitMinor) : ''}</td><td>{l.creditMinor ? rupees(l.creditMinor) : ''}</td></tr>)}
        <tr><td><b>Total</b></td><td><b>{rupees(entry.totalDebitMinor)}</b></td><td><b>{rupees(entry.totalCreditMinor)}</b></td></tr></tbody></table></div>
    {entry.description && <p className="muted-text">{entry.description}</p>}
    {entry.reversedByPublicId && <p className="muted-text">This entry has been reversed.</p>}
    <div className="modal-foot">
      {source && <a className="outline-btn" href={source.href} onClick={onClose}>{source.label}</a>}
      {canReverse && entry.sourceType !== 'reversal' && !entry.reversedByPublicId && (reason === null
        ? <button className="outline-btn" onClick={() => setReason('')}><Undo2 size={12} /> Reverse</button>
        : <>
          <input id="reverse-reason" className="input" placeholder="Reason for the reversal" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          <button className="primary-btn" disabled={saving} onClick={() => void reverse()}>{saving ? 'Reversing…' : 'Post reversal'}</button></>)}
    </div>
  </Modal>;
}
