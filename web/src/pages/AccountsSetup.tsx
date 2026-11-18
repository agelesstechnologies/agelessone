import { useState, type FormEvent } from 'react';
import { Check, Pencil, Plus } from 'lucide-react';
import {
  DraftTallyCompanyRequest, LEDGER_KEYS, NewPostingRuleRequest,
  type AccountsAccess, type PostingRule, type TallyCompany,
} from '@ageless/shared';
import { api, errText } from '../api';
import { useAuth } from '../auth';
import { useLoad, words } from '../hooks';
import { Badge, Empty, Loading, Modal, Notice, type Tone } from '../ui';

const COMPANY_TONE: Record<string, Tone> = { unset: 'red', draft: 'amber', approved: 'green' };
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// ---- Tally company ----

/** The Tally company this legal entity's books go to: the maker drafts it, a different person (the checker) approves it. */
export function TallyCompanyTab({ company, access }: { company: string; access: AccountsAccess }) {
  const { me } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const q = useLoad(() => api<TallyCompany>(`/accounts/tally-company?company=${company}`), [company]);
  const t = q.data;

  async function approve() {
    if (!t?.publicId) return;
    setBusy(true); setError('');
    try { await api(`/accounts/tally-company/${t.publicId}/approve`, { method: 'POST' }); q.reload(); }
    catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  if (q.loading && !t) return <Loading />;
  const missing = t?.connectorMissing;
  const missingCount = (missing?.ledgers.length ?? 0) + (missing?.costCentres.length ?? 0);
  return <>
    <p className="muted-text">The company name exactly as it is in Tally, and the first day of the books. Ledgers cannot be mapped and nothing goes to Tally until it is approved.</p>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {q.error && <Notice>{q.error}</Notice>}
    {t && <div className="table-wrap"><table><thead><tr><th>TALLY COMPANY</th><th>BOOKS FROM</th><th>STATE</th><th>DRAFTED / APPROVED BY</th><th /></tr></thead>
      <tbody><tr>
        <td>{t.tallyCompanyName ?? '—'}</td><td>{t.booksFrom ?? '—'}</td>
        <td><Badge tone={COMPANY_TONE[t.state] ?? 'gray'}>{t.state}</Badge></td>
        <td>{t.draftedBy ? `Drafted by ${t.draftedBy.displayName}` : '—'}{t.approvedBy && <small className="sub">Approved by {t.approvedBy.displayName}{t.approvedAt ? `, ${when(t.approvedAt)}` : ''}</small>}</td>
        <td className="row-actions">
          {access.maker && <button className="outline-btn" onClick={() => setEditing(true)}><Pencil size={12} /> {t.state === 'unset' ? 'Set up' : 'Change'}</button>}
          {access.checker && t.state === 'draft' && t.draftedBy?.publicId !== me?.person.publicId &&
            <button className="primary-btn" disabled={busy} onClick={() => void approve()}><Check size={12} /> Approve</button>}
        </td></tr></tbody></table></div>}
    {t?.state === 'draft' && t.draftedBy?.publicId === me?.person.publicId && <p className="muted-text">A different person (the Accounts checker) must approve your draft.</p>}
    {t?.state === 'approved' && <p className="muted-text">Changing an approved Tally company makes it a draft again until it is approved.</p>}

    {t?.state === 'approved' && <>
      <h3 className="section-title">Tally connector check</h3>
      {!t.connectorCheckedAt ? <Empty title="Not checked yet" text="The connector on the Tally server PC has not reported. It compares the ledger map with Tally." /> : <>
        <p className="muted-text">Last checked {when(t.connectorCheckedAt)}.</p>
        {missingCount === 0 ? <Notice tone="ok">Every mapped ledger exists in Tally.</Notice> : <Notice>
          Tally does not have these exactly as mapped. Create them in Tally or correct the ledger map.
          {!!missing?.ledgers.length && <><br /><b>Ledgers:</b> {missing.ledgers.join(', ')}</>}
          {!!missing?.costCentres.length && <><br /><b>Cost centres:</b> {missing.costCentres.join(', ')}</>}</Notice>}</>}
    </>}
    {editing && <TallyCompanyForm company={company} current={t ?? null} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); q.reload(); }} />}
  </>;
}

function TallyCompanyForm({ company, current, onClose, onSaved }: { company: string; current: TallyCompany | null; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = DraftTallyCompanyRequest.safeParse({
      ...(current?.publicId ? { publicId: current.publicId } : {}),
      company, tallyCompanyName: String(f.get('tallyCompanyName') ?? ''), booksFrom: String(f.get('booksFrom') ?? ''),
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setSaving(true); setError('');
    try { await api('/accounts/tally-company', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title={`Tally company for ${company}`} subtitle="Saved as a draft. The Accounts checker approves it." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid one">
        <label>Company name in Tally<input id="tc-name" name="tallyCompanyName" required maxLength={120} defaultValue={current?.tallyCompanyName ?? ''} autoFocus /></label>
        <label>Books start on<input id="tc-books" name="booksFrom" type="date" required defaultValue={current?.booksFrom ?? ''} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Save draft'}</button></div>
    </form>
  </Modal>;
}

// ---- posting rules ----

/** Which ledgers each event debits and credits. A new version is added each time; old ones are never edited. */
export function PostingRulesTab({ company, access }: { company: string; access: AccountsAccess }) {
  const [editing, setEditing] = useState<PostingRule | null>(null);
  const q = useLoad(() => api<PostingRule[]>(`/accounts/posting-rules?company=${company}`), [company]);
  const usingDefault = q.data?.some((r) => r.source === 'default') ?? false;

  return <>
    <p className="muted-text">Each event writes one journal entry: a debit ledger and a credit ledger. Saving a change adds a new version from the date you choose; earlier versions stay as they were.</p>
    {usingDefault && <Notice>Some events still use the built-in placeholder ledgers. The CA must confirm them, then the Accounts checker saves them here.</Notice>}
    {q.error && <Notice>{q.error}</Notice>}
    {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No posting rules" /> :
      <div className="table-wrap"><table><thead><tr><th>EVENT</th><th>DEBIT</th><th>CREDIT</th><th>DEDUCTIONS</th><th>VERSION</th><th>FROM</th><th /></tr></thead>
        <tbody>{q.data.map((r) => <tr key={r.eventType} className={r.source === 'default' ? 'row-warn' : ''}>
          <td>{words(r.eventType)}</td><td className="mono">{r.debitLedgerKey}</td><td className="mono">{r.creditLedgerKey}</td>
          <td className="mono">{r.deductionLedgerKey ?? '—'}</td>
          <td>{r.source === 'default' ? <Badge tone="amber">Placeholder</Badge> : <>v{r.version}<small className="sub">{r.company ?? 'Whole group'}</small></>}</td>
          <td>{r.effectiveFrom ?? '—'}</td>
          <td className="row-actions">{access.checker && <button className="outline-btn" onClick={() => setEditing(r)}><Plus size={12} /> New version</button>}</td>
        </tr>)}</tbody></table></div>}
    {editing && <PostingRuleForm company={company} rule={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.reload(); }} />}
  </>;
}

function PostingRuleForm({ company, rule, onClose, onSaved }: { company: string; rule: PostingRule; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // One id per open form: a double click or a retry is stored once.
  const [publicId] = useState(() => crypto.randomUUID());
  const keyOptions = (blank?: string) => <>{blank && <option value="">{blank}</option>}{LEDGER_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}</>;
  // The default's ledger keys are placeholders such as expense.<category>, so only offer them when they are a real key.
  const known = (k: string | null) => (k && (LEDGER_KEYS as readonly string[]).includes(k) ? k : '');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const deduction = String(f.get('deduction') ?? '');
    const parsed = NewPostingRuleRequest.safeParse({
      publicId,
      ...(f.get('scope') === 'company' ? { company } : {}),
      eventType: rule.eventType,
      debitLedgerKey: String(f.get('debit') ?? ''), creditLedgerKey: String(f.get('credit') ?? ''),
      ...(deduction ? { deductionLedgerKey: deduction } : {}),
      effectiveFrom: String(f.get('effectiveFrom') ?? ''),
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setSaving(true); setError('');
    try { await api('/accounts/posting-rules', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); setSaving(false); }
  }

  return <Modal title={`Posting rule: ${words(rule.eventType)}`} subtitle="Saved as a new version. Debit and credit must be different ledgers." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid one">
        <label>Applies to<select id="pr-scope" name="scope" className="input" defaultValue="company">
          <option value="company">{company} only</option><option value="group">Whole group (default for every company)</option></select></label>
        <label>Debit ledger<select id="pr-debit" name="debit" className="input" required defaultValue={known(rule.debitLedgerKey)}>{keyOptions('Choose…')}</select></label>
        <label>Credit ledger<select id="pr-credit" name="credit" className="input" required defaultValue={known(rule.creditLedgerKey)}>{keyOptions('Choose…')}</select></label>
        {rule.eventType === 'payroll_approved' &&
          <label>Other deductions<small className="sub">For a deduction label with no ledger of its own (PF, ESI, PT, TDS and Advance have one)</small>
            <select id="pr-deduction" name="deduction" className="input" defaultValue={known(rule.deductionLedgerKey)}>{keyOptions('None')}</select></label>}
        <label>In force from<input id="pr-from" name="effectiveFrom" type="date" required defaultValue={istToday()} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Save new version'}</button></div>
    </form>
  </Modal>;
}
