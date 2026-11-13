import { useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, Check, FileText, Plus, Printer, RefreshCw, Send } from 'lucide-react';
import {
  AnswerStatementRequest, BuildStatementRequest, CloseStatementRequest, CorrectLineRequest, ExplainLineRequest, InvoiceStatementRequest,
  type IcAccess, type IcAgreement, type IcStatement, type IcStatementDetail, type IcStatementLine,
} from '@ageless/shared';
import { api, errText, formError } from '../../api';
import { useAuth } from '../../auth';
import { addDays, dayLabel, hm, rupees, todayIst, useLoad } from '../../hooks';
import { openTicket } from '../../pages/Tickets';
import { Badge, Empty, Loading, Modal, Notice, Panel } from '../../ui';
import {
  COMPANIES, goIc, lastMonth, LINE_TONE, monthName, paiseInput, SERVICE_LABEL, stampIst, STATEMENT_LABEL, STATEMENT_TONE, toPaise,
} from './common';

const companyName = (code: string) => COMPANIES.find((c) => c.code === code)?.name ?? code;
const EVENT_LABEL: Record<string, string> = { disputed: 'Disputed', corrected: 'Corrected', removed: 'Removed', explained: 'Explained', credited: 'Credited after invoicing' };

// ---------------- the list, by month ----------------

export function StatementList({ access }: { access: IcAccess }) {
  const { me } = useAuth();
  const [year, setYear] = useState(Number(todayIst().slice(0, 4)));
  const [status, setStatus] = useState('');
  const [building, setBuilding] = useState(false);
  const q = useLoad(() => api<IcStatement[]>(`/intercompany/statements?year=${year}${status ? `&status=${status}` : ''}`), [year, status]);
  // the provider's head (or the CEO) builds statements: the agreements they may build for
  const agreements = useLoad(() => (access.agreements > 0 ? api<IcAgreement[]>('/intercompany/agreements') : Promise.resolve([] as IcAgreement[])), [access.agreements]);
  const buildable = (agreements.data ?? []).filter((a) => a.status !== 'draft' && (access.manages || a.provider.head.person.publicId === me?.person.publicId));
  const months = [...new Set((q.data ?? []).map((s) => `${s.year}-${String(s.month).padStart(2, '0')}`))].sort().reverse();

  return <Panel title="Statements" note="One statement per agreement and month, built once the provider's attendance month is locked."
    action={buildable.length ? <button className="primary-btn" onClick={() => setBuilding(true)}><Plus size={16} /> Build statement</button> : undefined}>
    <div className="panel-body">
      <div className="filters">
        <label className="inline-field">Year<input id="ics-year" className="input" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || year)} /></label>
        <label className="inline-field">Status<select id="ics-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>{Object.entries(STATEMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !months.length ? <Empty title="No statements" text="Statements you prepare, approve or review appear here, month by month." /> :
        months.map((m) => <div key={m}>
          <div className="mini-h">{monthName(m)}</div>
          <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>COMPANIES</th><th>STATUS</th><th>HOURS</th><th>TOTAL</th><th>NEXT</th></tr></thead>
            <tbody>{q.data!.filter((s) => `${s.year}-${String(s.month).padStart(2, '0')}` === m).map((s) => <tr key={s.publicId} className="link-row" onClick={() => goIc('statements', s.publicId)}>
              <td><b>{s.provider} → {s.receiver}</b><small className="sub">{companyName(s.provider)} bills {companyName(s.receiver)}</small></td>
              <td><Badge tone={STATEMENT_TONE[s.status] ?? 'gray'}>{STATEMENT_LABEL[s.status]}</Badge></td>
              <td>{hm(s.minutes)}</td>
              <td><b>{rupees(s.totalMinor)}</b></td>
              <td>{next(s)}</td></tr>)}</tbody></table></div>
        </div>)}
    </div>
    {building && <BuildStatement agreements={buildable} onClose={() => setBuilding(false)} onBuilt={(id) => { setBuilding(false); goIc('statements', id); }} />}
  </Panel>;
}

/** What happens next, in a few words. */
function next(s: IcStatement): string {
  switch (s.status) {
    case 'draft': return 'Waiting for the provider\'s approval';
    case 'approved_by_provider': return 'Ready to send';
    case 'sent': return `Receiver answers by ${dayLabel(s.reviewDueOn!)}`;
    case 'partly_disputed': return 'Provider corrects or explains';
    case 'accepted': return s.accepted?.as === 'automatic' ? 'Accepted automatically · to invoice' : 'Accepted · to invoice';
    case 'invoiced': return `Invoice ${s.invoice?.number} · unpaid`;
    default: return s.closed ? `Paid ${dayLabel(s.closed.paidOn)}` : '';
  }
}

function BuildStatement({ agreements, onClose, onBuilt }: { agreements: IcAgreement[]; onClose: () => void; onBuilt: (id: string) => void }) {
  const [agreement, setAgreement] = useState(agreements[0]?.publicId ?? '');
  const [month, setMonth] = useState(lastMonth(todayIst()));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = BuildStatementRequest.safeParse({ year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setSaving(true); setError('');
    try { onBuilt((await api<IcStatementDetail>(`/intercompany/agreements/${agreement}/statements`, { method: 'POST', json: parsed.data })).publicId); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Build a statement" subtitle="From the month's billable ticket time, the rates in force and the costs with bills. The provider's attendance month must be locked." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label className="span-two">Agreement<select id="icb-agreement" value={agreement} onChange={(e) => setAgreement(e.target.value)}>
          {agreements.map((a) => <option key={a.publicId} value={a.publicId}>{a.provider.company} → {a.receiver.company} ({a.status})</option>)}</select></label>
        <label className="span-two">Month<input id="icb-month" type="month" value={month} max={lastMonth(todayIst())} onChange={(e) => setMonth(e.target.value)} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving || !agreement}>{saving ? 'Building…' : 'Build'}</button></div>
    </form>
  </Modal>;
}

// ---------------- one statement ----------------

type Dialog = { kind: 'correct' | 'explain' | 'credit'; line: IcStatementLine } | 'invoice' | 'close' | 'document' | null;

/** Lines grouped as the receiver reads them: by project, then service; then costs passed on; then credits. */
function groups(lines: IcStatementLine[]) {
  const out: { key: string; title: string; services: { key: string; title: string; lines: IcStatementLine[] }[] }[] = [];
  for (const l of lines.filter((x) => x.kind === 'labour')) {
    const pk = l.project?.publicId ?? 'none';
    let g = out.find((x) => x.key === pk);
    if (!g) {
      g = { key: pk, title: l.project ? `${l.project.kind === 'project' ? 'Project' : 'Design request'} ${l.project.publicId.slice(0, 8)}` : 'No project', services: [] };
      out.push(g);
    }
    const sk = l.serviceType ?? 'other';
    let s = g.services.find((x) => x.key === sk);
    if (!s) { s = { key: sk, title: SERVICE_LABEL[sk] ?? sk, lines: [] }; g.services.push(s); }
    s.lines.push(l);
  }
  const costs = lines.filter((x) => x.kind === 'passed_cost');
  const credits = lines.filter((x) => x.kind === 'credit');
  if (costs.length) out.push({ key: 'costs', title: 'Costs passed on', services: [{ key: 'costs', title: 'With their bills', lines: costs }] });
  if (credits.length) out.push({ key: 'credits', title: 'Credits from earlier statements', services: [{ key: 'credits', title: 'Corrections after invoicing', lines: credits }] });
  return out;
}
const billed = (lines: IcStatementLine[]) => lines.filter((l) => l.status !== 'removed').reduce((t, l) => t + l.amountMinor, 0);

export function StatementPage({ id }: { id: string }) {
  const q = useLoad(() => api<IcStatementDetail>(`/intercompany/statements/${id}`), [id]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [disputes, setDisputes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const s = q.data;

  async function act(path: string, json: unknown, done: string, after?: () => void) {
    setBusy(true); setError(''); setNote('');
    try { q.setData(await api<IcStatementDetail>(`/intercompany/${path}`, { method: 'POST', json })); setDialog(null); setNote(done); after?.(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }
  async function answer() {
    const parsed = AnswerStatementRequest.safeParse({ disputes: Object.entries(disputes).map(([linePublicId, reason]) => ({ linePublicId, reason })) });
    if (!parsed.success) { setError(formError(parsed.error, 'Give a reason for every line you dispute')); return; }
    await act(`statements/${id}/answer`, parsed.data, parsed.data.disputes.length ? `Sent back with ${parsed.data.disputes.length} disputed line(s).` : 'Accepted.', () => setDisputes({}));
  }

  const back = <button className="outline-btn" onClick={() => goIc('statements')}><ArrowLeft size={14} /> Statements</button>;
  if (!s) return <Panel title="Statement" action={back}><div className="panel-body">{q.error ? <Notice>{q.error}</Notice> : <Loading />}</div></Panel>;

  const a = s.actions;
  const answering = a.answer;
  const correcting = a.correct && s.status === 'partly_disputed';
  const crediting = a.correct && (s.status === 'invoiced' || s.status === 'closed');
  const seesCost = s.costMinor !== null;
  const disputed = Object.keys(disputes).length;
  const invoiced = s.status === 'invoiced' || s.status === 'closed';

  return <>
    <Panel title={`${s.provider} → ${s.receiver} · ${monthName(s.year, s.month)}`} note={`${companyName(s.provider)} bills ${companyName(s.receiver)}`}
      action={<div className="row-actions">{back}
        {a.rebuild && <button className="outline-btn" disabled={busy} onClick={() => void act(`statements/${id}/rebuild`, {}, 'Rebuilt from today\'s time, rates and costs.')}><RefreshCw size={13} /> Rebuild</button>}
        {a.approve && <button className="primary-btn" disabled={busy} onClick={() => void act(`statements/${id}/approve`, {}, `Approved. ${monthName(s.year, s.month)} is now billed.`)}><Check size={14} /> Approve</button>}
        {a.send && <button className="primary-btn" disabled={busy} onClick={() => void act(`statements/${id}/send`, {}, 'Sent to the receiver.')}><Send size={14} /> {s.round > 0 ? 'Send again' : 'Send to receiver'}</button>}
        {a.invoice && <button className="primary-btn" onClick={() => setDialog('invoice')}><FileText size={14} /> Create invoice</button>}
        {a.close && <button className="outline-btn" onClick={() => setDialog('close')}>Mark paid</button>}
        {invoiced && <button className="outline-btn" onClick={() => setDialog('document')}><FileText size={13} /> {s.viewerSide === 'receiver' ? 'View bill' : 'View invoice'}</button>}
      </div>}>
      <div className="panel-body">
        {error && <Notice onClose={() => setError('')}>{error}</Notice>}
        {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
        <div className="kv-grid">
          <span>Status</span><b><Badge tone={STATEMENT_TONE[s.status] ?? 'gray'}>{STATEMENT_LABEL[s.status]}</Badge>{s.round > 1 && <small className="sub">sent {s.round} times</small>}</b>
          <span>Total</span><b>{rupees(s.totalMinor)} · {hm(s.minutes)}</b>
          {seesCost && <><span>Cost (CEO only)</span><b>{rupees(s.costMinor!)} · margin {rupees(s.totalMinor - s.costMinor!)}</b></>}
          <span>Prepared</span><b>{s.preparedBy.displayName}, {stampIst(s.preparedAt)}</b>
          {s.approved && <><span>Approved</span><b>{s.approved.by.displayName} ({s.approved.as === 'head' ? 'department head' : 'CEO'}), {stampIst(s.approved.at)}</b></>}
          {s.sentAt && <><span>Sent</span><b>{stampIst(s.sentAt)}{s.status === 'sent' && ` · answer by ${dayLabel(s.reviewDueOn!)}`}</b></>}
          {s.accepted && <><span>Accepted</span><b>{s.accepted.as === 'automatic' ? `Automatically: no answer by ${dayLabel(s.reviewDueOn!)}` : `${s.accepted.by?.displayName}`}, {stampIst(s.accepted.at)}</b></>}
          {s.invoice && <><span>Invoice</span><b>{s.invoice.number} of {dayLabel(s.invoice.on)} · due {dayLabel(addDays(s.invoice.on, s.paymentTermsDays))}</b></>}
          {s.closed && <><span>Paid</span><b>{dayLabel(s.closed.paidOn)} · {s.closed.paymentRef}</b></>}
        </div>
        {answering && <Notice tone="ok">Review by {dayLabel(s.reviewDueOn!)}: tick the lines you dispute and say why; every other line is accepted. No answer by then means accepted.</Notice>}
        {correcting && <Notice>Lines were disputed: correct, remove or explain each one, then send again.</Notice>}
      </div>
    </Panel>

    {groups(s.lines).map((g) => <Panel key={g.key} title={g.title} note={rupees(billed(g.services.flatMap((x) => x.lines)))}>
      <div className="panel-body">{g.services.map((sv) => <div key={sv.key}>
        <div className="mini-h">{sv.title} · {rupees(billed(sv.lines))}</div>
        <div className="table-wrap"><table className="stack-mobile ic-lines"><thead><tr><th>LINE</th><th>HOURS × RATE</th><th>AMOUNT</th><th>STATUS</th><th>TICKETS</th>{seesCost && <th>COST</th>}<th /></tr></thead>
          <tbody>{sv.lines.map((l) => <LineRows key={l.publicId} l={l} seesCost={seesCost}
            dispute={answering && l.status === 'pending' ? { value: disputes[l.publicId], set: (v) => setDisputes((d) => {
              const nextD = { ...d }; if (v === undefined) delete nextD[l.publicId]; else nextD[l.publicId] = v; return nextD; }) } : undefined}
            actions={<>
              {correcting && l.status === 'disputed' && !l.resolution && <>
                {l.kind !== 'credit' && <button className="outline-btn" onClick={() => setDialog({ kind: 'correct', line: l })}>Correct</button>}
                <button className="outline-btn" onClick={() => setDialog({ kind: 'explain', line: l })}>Explain</button></>}
              {crediting && l.kind !== 'credit' && l.status !== 'removed' && l.amountMinor - l.creditedMinor > 0 &&
                <button className="outline-btn" onClick={() => setDialog({ kind: 'credit', line: l })}>Correct (credit)</button>}
            </>} />)}</tbody></table></div>
      </div>)}</div>
    </Panel>)}
    {!s.lines.length && <Panel><div className="panel-body"><Empty title="Nothing billed" text="No billable ticket time and no costs with bills in this month." /></div></Panel>}

    {answering && <div className="ic-answer-bar">
      <span>{disputed ? `${disputed} line(s) disputed; the rest accepted` : 'Everything accepted'}</span>
      <button className="primary-btn" disabled={busy} onClick={() => void answer()}>{disputed ? 'Send answer' : 'Accept statement'}</button></div>}

    {dialog && typeof dialog === 'object' && <LineDialog kind={dialog.kind} line={dialog.line} busy={busy} error={error}
      onClose={() => { setDialog(null); setError(''); }}
      onSubmit={(json) => void act(`statement-lines/${dialog.line.publicId}/${dialog.kind === 'explain' ? 'explain' : 'correct'}`, json,
        dialog.kind === 'credit' ? 'Credit added: it goes on the next statement.' : dialog.kind === 'explain' ? 'Explanation saved.' : 'Line corrected.')} />}
    {dialog === 'invoice' && <CreateInvoice s={s} busy={busy} error={error} onClose={() => { setDialog(null); setError(''); }}
      onSubmit={(json) => void act(`statements/${id}/invoice`, json, 'Invoice created.', () => setDialog('document'))} />}
    {dialog === 'close' && <MarkPaid busy={busy} error={error} onClose={() => { setDialog(null); setError(''); }}
      onSubmit={(json) => void act(`statements/${id}/close`, json, 'Paid and closed.')} />}
    {dialog === 'document' && <InvoiceDocument s={s} onClose={() => setDialog(null)} />}
  </>;
}

/** A line, then its tickets and its dispute thread. */
function LineRows({ l, seesCost, dispute, actions }: { l: IcStatementLine; seesCost: boolean; actions: ReactNode;
  dispute?: { value: string | undefined; set: (v: string | undefined) => void } }) {
  const corrected = l.originalAmountMinor !== null && l.originalAmountMinor !== l.amountMinor;
  return <>
    <tr className={l.status === 'removed' ? 'ic-removed' : undefined}>
      <td><b>{l.person?.displayName ?? l.description}</b>{l.person && <small className="sub">{l.grade ? `Grade ${l.grade}` : l.description}</small>}
        {l.creditFor && <small className="sub">{l.creditFor.reason}</small>}</td>
      <td>{l.kind === 'labour' ? <>{hm(l.minutes ?? 0)} × {rupees(l.rateMinor ?? 0)}/h</> : '—'}</td>
      <td><b>{rupees(l.amountMinor)}</b>{corrected && <small className="sub ic-was">was {rupees(l.originalAmountMinor!)}</small>}
        {l.creditedMinor > 0 && <small className="sub">credited {rupees(l.creditedMinor)} later</small>}</td>
      <td><Badge tone={LINE_TONE[l.status] ?? 'gray'}>{l.status}</Badge>{l.resolution && <small className="sub">{l.resolution.kind}</small>}</td>
      <td>{l.tickets.length ? <span className="ic-tickets">{l.tickets.map((t) => <button key={t.publicId} className="link-btn" title={t.title}
        onClick={() => openTicket(t.publicId)}>{t.number}{l.tickets.length > 1 && ` · ${hm(t.minutes)}`}</button>)}</span> : '—'}</td>
      {seesCost && <td>{l.costMinor === null ? '—' : rupees(l.costMinor)}{l.costPerHourMinor !== null && <small className="sub">{rupees(l.costPerHourMinor)}/h</small>}</td>}
      <td><div className="row-actions">
        {dispute && <label className="ic-dispute"><input type="checkbox" checked={dispute.value !== undefined} onChange={(e) => dispute.set(e.target.checked ? '' : undefined)} /> Dispute</label>}
        {actions}</div></td>
    </tr>
    {dispute && dispute.value !== undefined && <tr className="ic-sub-row"><td colSpan={seesCost ? 7 : 6}>
      <input className="input ic-reason" value={dispute.value} onChange={(e) => dispute.set(e.target.value)} placeholder="Why do you dispute this line?" autoFocus /></td></tr>}
    {l.thread.length > 0 && <tr className="ic-sub-row"><td colSpan={seesCost ? 7 : 6}>
      <ol className="ic-thread">{l.thread.map((e, i) => <li key={i} className={`ic-${e.kind}`}>
        <b>{EVENT_LABEL[e.kind]}</b> by {e.by.displayName} · {stampIst(e.at)}{e.round > 1 && ` · round ${e.round}`}
        {e.amountAfterMinor !== null && e.amountBeforeMinor !== e.amountAfterMinor && <> · {rupees(e.amountBeforeMinor ?? 0)} → {rupees(e.amountAfterMinor)}</>}
        <span>{e.reason}</span></li>)}</ol></td></tr>}
  </>;
}

function LineDialog({ kind, line, busy, error, onClose, onSubmit }: { kind: 'correct' | 'explain' | 'credit'; line: IcStatementLine; busy: boolean; error: string;
  onClose: () => void; onSubmit: (json: unknown) => void }) {
  const left = line.amountMinor - line.creditedMinor;
  const [remove, setRemove] = useState(false);
  const [amount, setAmount] = useState(paiseInput(kind === 'credit' ? left : line.amountMinor));
  const [reason, setReason] = useState('');
  const [check, setCheck] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    if (kind === 'explain') {
      const parsed = ExplainLineRequest.safeParse({ reason });
      if (!parsed.success) { setCheck(formError(parsed.error)); return; }
      onSubmit(parsed.data); return;
    }
    const amountMinor = remove ? undefined : toPaise(amount);
    if (!remove && amountMinor === null) { setCheck('Enter the new amount in rupees'); return; }
    const parsed = CorrectLineRequest.safeParse(remove ? { remove: true, reason } : { amountMinor, reason });
    if (!parsed.success) { setCheck(formError(parsed.error)); return; }
    setCheck(''); onSubmit(parsed.data);
  }
  const title = kind === 'explain' ? 'Explain this line' : kind === 'credit' ? 'Correct after invoicing' : 'Correct this line';
  const subtitle = kind === 'credit' ? `The invoice stays as it is: what you take off goes on the next statement as a credit (${rupees(left)} can still be credited).`
    : kind === 'explain' ? 'The line stays as it is and goes back to the receiver with your explanation.' : `Now ${rupees(line.amountMinor)}. Lower it or remove it; it goes back to the receiver.`;
  return <Modal title={title} subtitle={subtitle} onClose={onClose}>
    <form onSubmit={submit}>
      {(check || error) && <Notice>{check || error}</Notice>}
      <p className="muted-text">{line.description}</p>
      {line.dispute && <Notice tone="ok">Disputed: {line.dispute.reason}</Notice>}
      <div className="form-grid">
        {kind !== 'explain' && <>
          <label className="span-two check-row"><input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> {kind === 'credit' ? 'Credit the whole line' : 'Remove the line'}</label>
          {!remove && <label className="span-two">{kind === 'credit' ? 'The line should have been (₹)' : 'New amount (₹)'}<input id="icl-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}
        </>}
        <label className="span-two">Reason<input id="icl-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Shown to the receiver" autoFocus /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  </Modal>;
}

/**
 * "Create invoice": records the invoice number and date of an accepted statement and opens the invoice. Until the
 * Accounts module issues invoices, the invoice is this document, made from the statement.
 */
function CreateInvoice({ s, busy, error, onClose, onSubmit }: { s: IcStatementDetail; busy: boolean; error: string; onClose: () => void; onSubmit: (json: unknown) => void }) {
  const [invoiceNumber, setNumber] = useState(`${s.provider}-IC-${s.year}${String(s.month).padStart(2, '0')}`);
  const [invoicedOn, setOn] = useState(todayIst());
  const [check, setCheck] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = InvoiceStatementRequest.safeParse({ invoiceNumber, invoicedOn });
    if (!parsed.success) { setCheck(formError(parsed.error)); return; }
    setCheck(''); onSubmit(parsed.data);
  }
  return <Modal title="Create invoice" subtitle={`${rupees(s.totalMinor)} to ${companyName(s.receiver)}, due ${s.paymentTermsDays} days after its date. The receiver sees it as their bill.`} onClose={onClose}>
    <form onSubmit={submit}>
      {(check || error) && <Notice>{check || error}</Notice>}
      <div className="form-grid">
        <label>Invoice number<input id="ici-number" value={invoiceNumber} onChange={(e) => setNumber(e.target.value)} /></label>
        <label>Invoice date<input id="ici-date" type="date" value={invoicedOn} onChange={(e) => setOn(e.target.value)} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={busy}>{busy ? 'Creating…' : 'Create invoice'}</button></div>
    </form>
  </Modal>;
}

function MarkPaid({ busy, error, onClose, onSubmit }: { busy: boolean; error: string; onClose: () => void; onSubmit: (json: unknown) => void }) {
  const [paidOn, setPaidOn] = useState(todayIst());
  const [paymentRef, setRef] = useState('');
  const [check, setCheck] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = CloseStatementRequest.safeParse({ paidOn, paymentRef });
    if (!parsed.success) { setCheck(formError(parsed.error)); return; }
    setCheck(''); onSubmit(parsed.data);
  }
  return <Modal title="Mark paid" subtitle="The statement is closed; it leaves the intercompany balance." onClose={onClose}>
    <form onSubmit={submit}>
      {(check || error) && <Notice>{check || error}</Notice>}
      <div className="form-grid">
        <label>Paid on<input id="icp-date" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></label>
        <label>Payment reference<input id="icp-ref" value={paymentRef} onChange={(e) => setRef(e.target.value)} placeholder="UTR or cheque number" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={busy}>{busy ? 'Saving…' : 'Mark paid'}</button></div>
    </form>
  </Modal>;
}

/** The invoice (provider's side) or the matching bill (receiver's side), made from the statement; printable. */
function InvoiceDocument({ s, onClose }: { s: IcStatementDetail; onClose: () => void }) {
  if (!s.invoice) return null;
  const due = addDays(s.invoice.on, s.paymentTermsDays);
  const overdue = !s.closed && todayIst() > due;
  const title = s.viewerSide === 'receiver' ? `Bill from ${companyName(s.provider)}` : `Invoice to ${companyName(s.receiver)}`;
  const rows = groups(s.lines).flatMap((g) => g.services.map((sv) => ({ title: g.key === 'costs' || g.key === 'credits' ? g.title : `${g.title} · ${sv.title}`,
    minutes: sv.lines.filter((l) => l.kind === 'labour' && l.status !== 'removed').reduce((t, l) => t + (l.minutes ?? 0), 0), amount: billed(sv.lines) })));
  return <Modal title={title} subtitle={`${monthName(s.year, s.month)} · statement accepted ${s.accepted ? stampIst(s.accepted.at) : ''}`} onClose={onClose}>
    <div className="ic-invoice">
      <h3>{title}</h3>
      <div className="ic-invoice-head">
        <div><small>{s.viewerSide === 'receiver' ? 'SUPPLIER' : 'FROM'}</small><b>{companyName(s.provider)}</b><small>{s.viewerSide === 'receiver' ? 'BILLED TO YOU' : 'TO'}</small><b>{companyName(s.receiver)}</b></div>
        <div className="ic-invoice-no"><small>{s.viewerSide === 'receiver' ? 'BILL (THEIR INVOICE) NO.' : 'INVOICE NO.'}</small><b>{s.invoice.number}</b>
          <small>DATE</small><b>{dayLabel(s.invoice.on)}</b><small>DUE</small><b>{dayLabel(due)}</b></div>
      </div>
      <table className="stack-mobile"><thead><tr><th>FOR</th><th>HOURS</th><th>AMOUNT</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><td>{r.title}</td><td>{r.minutes ? hm(r.minutes) : '—'}</td><td>{rupees(r.amount)}</td></tr>)}
          <tr className="ic-total"><td>Total</td><td>{hm(s.minutes)}</td><td>{rupees(s.totalMinor)}</td></tr></tbody></table>
      <p className="ic-invoice-state">{s.closed ? <Badge tone="green">Paid {dayLabel(s.closed.paidOn)} · {s.closed.paymentRef}</Badge>
        : <Badge tone={overdue ? 'red' : 'amber'}>{overdue ? `Overdue since ${dayLabel(due)}` : `Unpaid · due ${dayLabel(due)}`}</Badge>}</p>
    </div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button>
      <button type="button" className="primary-btn" onClick={() => window.print()}><Printer size={14} /> Print</button></div>
  </Modal>;
}
