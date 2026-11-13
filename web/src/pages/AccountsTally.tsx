import { useState } from 'react';
import { Check, Download, FileUp, Plus, X } from 'lucide-react';
import {
  MarkImportedRequest, NewTallyBatchRequest,
  type AccountsAccess, type CreatedTallyBatch, type TallyBatch, type TallyBatchDetail, type TallyQueue,
} from '@ageless/shared';
import { ApiFailure, api, downloadFile, errText, formError } from '../api';
import { useAuth } from '../auth';
import { rupees, useLoad, words } from '../hooks';
import { Badge, Empty, Loading, Modal, Notice, type Tone } from '../ui';

const STATE_TONE: Record<string, Tone> = { built: 'amber', approved: 'blue', imported: 'green', cancelled: 'gray', pending: 'amber', created: 'green', failed: 'red' };
const STATE_TEXT: Record<string, string> = { built: 'Waiting for approval', approved: 'Approved', imported: 'Imported', cancelled: 'Cancelled' };
const istDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Accounts -> Tally sync: build a batch (an XML file), the checker approves it, the accountant downloads it, imports it in Tally by hand and records the result. */
export default function TallySync({ company, access }: { company: string; access: AccountsAccess }) {
  const { me } = useAuth();
  const today = new Date();
  const [from, setFrom] = useState(istDate(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(istDate(today));
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const rangeOk = from !== '' && to !== '' && from <= to;
  const queue = useLoad(() => rangeOk ? api<TallyQueue>(`/accounts/tally/queue?company=${company}&from=${from}&to=${to}`) : Promise.resolve(null), [company, from, to]);
  const batches = useLoad(() => api<TallyBatch[]>(`/accounts/tally/batches?company=${company}`), [company]);
  const reloadAll = () => { queue.reload(); batches.reload(); };

  async function createBatch() {
    const parsed = NewTallyBatchRequest.safeParse({ company, from, to });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setBusy('create'); setError(''); setNote('');
    try {
      const made = await api<CreatedTallyBatch>('/accounts/tally/batches', { method: 'POST', json: parsed.data });
      setNote(`Batch built: ${made.entryCount} entries, ${rupees(made.totalMinor)}.${made.skippedBlocked ? ` ${made.skippedBlocked} left in the queue (ledger not mapped yet).` : ''} The checker must approve it before it can be downloaded.`);
      reloadAll(); setOpen(made.publicId);
    } catch (e) { setError(errText(e)); } finally { setBusy(''); }
  }

  async function approve(b: TallyBatch) {
    setBusy(b.publicId); setError(''); setNote('');
    try { await api(`/accounts/tally/batches/${b.publicId}/approve`, { method: 'POST' }); batches.reload(); }
    catch (e) { setError(errText(e)); } finally { setBusy(''); }
  }

  async function download(b: TallyBatch) {
    setBusy(b.publicId); setError('');
    try { await downloadFile(`/accounts/tally/batches/${b.publicId}/download`, `tally-${b.company}-${b.publicId.slice(0, 8)}.xml`); batches.reload(); }
    catch (e) { setError(errText(e)); } finally { setBusy(''); }
  }

  const q = queue.data;
  return <>
    <div className="filters">
      <label className="inline-field">From<input id="tally-from" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="inline-field">To<input id="tally-to" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      {access.maker && <button className="primary-btn" disabled={!!busy || !q?.readyCount} onClick={() => void createBatch()}>
        <Plus size={12} /> {busy === 'create' ? 'Building…' : `Create batch${q?.readyCount ? ` (${q.readyCount})` : ''}`}</button>}
    </div>
    <p className="muted-text">Nothing is sent to Tally from here. A batch is an XML file: the checker approves it, then you download it and import it in Tally.</p>
    {!rangeOk && <Notice>The start date must not be after the end date.</Notice>}
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
    {queue.error && <Notice>{queue.error}</Notice>}

    <h3 className="section-title">Waiting to go to Tally</h3>
    {queue.loading && !q ? <Loading /> : !q?.items.length ? <Empty title="Nothing waiting" text="Journal entries in this range are all in a batch, or there are none." /> : <>
      {q.blockedCount > 0 && <Notice>{q.blockedCount} {q.blockedCount === 1 ? 'entry uses' : 'entries use'} a ledger with no approved Tally ledger. Map and approve it in Ledger mapping; until then {q.blockedCount === 1 ? 'it stays' : 'they stay'} out of batches.</Notice>}
      {q.returnedCount > 0 && <Notice>{q.returnedCount} {q.returnedCount === 1 ? 'entry came' : 'entries came'} back from an earlier batch (see the reason in the last column).</Notice>}
      {q.limited && <Notice>Only the first entries by date are shown and batched at once; build this batch, then come back for the rest.</Notice>}
      <div className="table-wrap"><table><thead><tr><th>DATE</th><th>SOURCE</th><th>AMOUNT</th><th>STATUS</th><th>LAST ATTEMPT</th></tr></thead>
        <tbody>{q.items.map((i) => <tr key={i.entryPublicId} className={i.ready ? '' : 'row-warn'}>
          <td>{i.entryDate}</td><td>{words(i.sourceType)}</td><td>{rupees(i.totalMinor)}</td>
          <td>{i.ready ? <Badge tone="green">Ready</Badge> : <><Badge tone="red">Blocked</Badge><small className="sub">No Tally ledger: {i.blockedKeys.join(', ')}</small></>}</td>
          <td className="note-cell">{i.lastError ?? '—'}</td></tr>)}</tbody></table></div></>}

    <h3 className="section-title">Batches</h3>
    {batches.error && <Notice>{batches.error}</Notice>}
    {batches.loading && !batches.data ? <Loading /> : !batches.data?.length ? <Empty title="No batches yet" /> :
      <div className="table-wrap"><table><thead><tr><th>BUILT</th><th>ENTRIES</th><th>AMOUNT</th><th>STATE</th><th>BUILT / APPROVED BY</th><th /></tr></thead>
        <tbody>{batches.data.map((b) => <tr key={b.publicId} onClick={() => setOpen(b.publicId)}>
          <td>{when(b.createdAt)}</td>
          <td>{b.entryCount}{b.failedCount > 0 && <small className="sub">{b.failedCount} returned</small>}</td>
          <td>{rupees(b.totalMinor)}</td>
          <td><Badge tone={STATE_TONE[b.state] ?? 'gray'}>{STATE_TEXT[b.state] ?? b.state}</Badge>{b.onHold && <> <Badge tone="red">On hold</Badge></>}</td>
          <td>{b.createdBy.displayName}{b.approvedBy && <small className="sub">Approved by {b.approvedBy.displayName}</small>}</td>
          <td className="row-actions" onClick={(e) => e.stopPropagation()}>
            {access.checker && b.state === 'built' && b.createdBy.publicId !== me?.person.publicId &&
              <button className="primary-btn" disabled={!!busy} onClick={() => void approve(b)}><Check size={12} /> Approve</button>}
            {(access.maker || access.checker) && (b.state === 'approved' || b.state === 'imported') &&
              <button className="outline-btn" disabled={!!busy} onClick={() => void download(b)}><Download size={12} /> Download XML</button>}
          </td></tr>)}</tbody></table></div>}
    {open && <BatchDetail id={open} access={access} onClose={() => setOpen(null)} onChanged={reloadAll} />}
  </>;
}

function BatchDetail({ id, access, onClose, onChanged }: { id: string; access: AccountsAccess; onClose: () => void; onChanged: () => void }) {
  const { me } = useAuth();
  const q = useLoad(() => api<TallyBatchDetail>(`/accounts/tally/batches/${id}`), [id]);
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [marking, setMarking] = useState(false);
  const [failed, setFailed] = useState<Record<string, string>>({});   // entry public id -> the error Tally showed (ticked = failed)
  const b = q.data;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(''); setReasons([]);
    try { await fn(); q.reload(); onChanged(); }
    catch (e) {
      setError(errText(e));
      const details = e instanceof ApiFailure ? (e.api.details as { reasons?: string[] } | undefined) : undefined;
      if (details?.reasons) setReasons(details.reasons);
    } finally { setBusy(false); }
  }
  const post = (what: string, json?: unknown) => api(`/accounts/tally/batches/${id}/${what}`, { method: 'POST', ...(json !== undefined ? { json } : {}) });

  async function uploadResult(file: File | undefined) {
    if (!file) return;
    const resultText = await file.text();
    await run(() => post('import-result', { resultText }));
  }

  async function confirmImported() {
    const parsed = MarkImportedRequest.safeParse({ failed: Object.entries(failed).map(([entryPublicId, error]) => ({ entryPublicId, error })) });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    await run(async () => { await post('mark-imported', parsed.data); setMarking(false); setFailed({}); });
  }

  return <Modal title="Tally batch" subtitle={b ? `${b.company} · ${b.entryCount} entries · ${rupees(b.totalMinor)} · built by ${b.createdBy.displayName}` : ''} onClose={onClose}>
    {q.error && <Notice>{q.error}</Notice>}
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {reasons.length > 0 && <Notice><ul>{reasons.map((r) => <li key={r}>{r}</li>)}</ul>Use "Mark imported" and tick the entries that failed.</Notice>}
    {!b ? <Loading /> : <>
      <p><Badge tone={STATE_TONE[b.state] ?? 'gray'}>{STATE_TEXT[b.state] ?? b.state}</Badge>
        {b.approvedBy && <> Approved by {b.approvedBy.displayName}</>}{b.downloadedAt && <> · downloaded {when(b.downloadedAt)}</>}
        {b.finishedBy && b.finishedAt && <> · {b.state === 'imported' ? 'recorded' : 'cancelled'} by {b.finishedBy.displayName}, {when(b.finishedAt)}</>}
        {b.importedByConnector && b.finishedAt && <> · imported by the Tally connector, {when(b.finishedAt)}</>}</p>
      {b.onHold && <Notice>On hold: the Tally connector will not post this batch again. {b.connectorMessage} Check Tally, then use Upload Tally result or Mark imported (or cancel the batch).</Notice>}
      {!b.onHold && b.state === 'approved' && b.connectorMessage && <p className="muted-text">Connector: {b.connectorMessage}</p>}
      {b.state === 'built' && <p className="muted-text">{b.createdBy.publicId === me?.person.publicId ? 'A different person (the Accounts checker) must approve this batch before it can be downloaded.' : 'Waiting for the Accounts checker to approve.'}</p>}
      <div className="table-wrap"><table><thead><tr><th>DATE</th><th>SOURCE</th><th>AS</th><th>AMOUNT</th><th>RESULT</th>{marking && <th>FAILED IN TALLY?</th>}</tr></thead>
        <tbody>{b.entries.map((e) => <tr key={e.entryPublicId}>
          <td>{e.entryDate}</td><td>{words(e.sourceType)}</td><td>{e.voucherType.replace('Platform ', '')}</td><td>{rupees(e.totalMinor)}</td>
          <td><Badge tone={STATE_TONE[e.state] ?? 'gray'}>{e.state === 'failed' ? 'Back in queue' : e.state === 'created' ? 'In Tally' : 'Pending'}</Badge>{e.tallyMessage && <small className="sub">{e.tallyMessage}</small>}</td>
          {marking && <td><label><input type="checkbox" checked={e.entryPublicId in failed} onChange={(ev) => setFailed((f) => { const n = { ...f }; if (ev.target.checked) n[e.entryPublicId] = ''; else delete n[e.entryPublicId]; return n; })} /> Failed</label>
            {e.entryPublicId in failed && <input className="input" placeholder="The error Tally showed" maxLength={500} value={failed[e.entryPublicId]} onChange={(ev) => setFailed((f) => ({ ...f, [e.entryPublicId]: ev.target.value }))} />}</td>}
        </tr>)}</tbody></table></div>
      <div className="modal-foot">
        {(access.maker || access.checker) && (b.state === 'approved' || b.state === 'imported') &&
          <button className="outline-btn" disabled={busy} onClick={() => void run(() => downloadFile(`/accounts/tally/batches/${id}/download`, `tally-${b.company}-${id.slice(0, 8)}.xml`))}><Download size={12} /> Download XML</button>}
        {access.maker && b.state === 'approved' && (b.downloadedAt ? <>
          <label className="outline-btn" aria-disabled={busy}><FileUp size={12} /> Upload Tally result
            <input type="file" accept=".xml,.txt,.log" hidden disabled={busy} onChange={(e) => { void uploadResult(e.target.files?.[0]); e.target.value = ''; }} /></label>
          {!marking ? <button className="outline-btn" disabled={busy} onClick={() => setMarking(true)}><Check size={12} /> Mark imported</button>
            : <button className="primary-btn" disabled={busy} onClick={() => void confirmImported()}>{busy ? 'Saving…' : Object.keys(failed).length ? `Confirm: ${Object.keys(failed).length} failed` : 'Confirm: all imported'}</button>}
        </> : <span className="muted-text">Download the file, import it in Tally, then record the result here.</span>)}
        {(access.maker || access.checker) && (b.state === 'built' || b.state === 'approved') &&
          <button className="outline-btn" disabled={busy} onClick={() => { if (window.confirm('Cancel this batch? Its entries go back to the queue.')) void run(() => post('cancel')); }}><X size={12} /> Cancel batch</button>}
      </div></>}
  </Modal>;
}
