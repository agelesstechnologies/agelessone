import { useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Send, Undo2 } from 'lucide-react';
import {
  ClientResponseRequest, IssueTransmittalRequest,
  type DesignAccessInfo, type DesignJobDetail, type DrawingSummary, type Transmittal, type TransmittalItem, type TransmittalListItem,
} from '@ageless/shared';
import { api, errText, formError } from '../../api';
import { todayIst, useApi, uuidv7 } from '../../hooks';
import { Badge, Empty, Loading, Modal, Notice, Panel } from '../../ui';
import { accessIn, DownloadButton, goDesign, PURPOSE_LABEL, refreshDesign, REV_LABEL, REV_TONE, stampIst } from './common';

// ---------------- the list ----------------

export function TransmittalList({ company }: { company?: string }) {
  const q = useApi<TransmittalListItem[]>(`/design/transmittals${company ? `?company=${company}` : ''}`);
  return <Panel title="Transmittals" note="Revisions issued to clients, newest first. Issue a new one from its design job.">
    <div className="panel-body">
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="Nothing issued yet" text="Transmittals appear here once revisions are issued." /> :
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>TRANSMITTAL</th><th>JOB</th><th>CLIENT</th><th>PURPOSE</th><th>REVISIONS</th><th>ISSUED</th></tr></thead>
          <tbody>{q.data.map((t) => <tr key={t.publicId} className="link-row" onClick={() => goDesign('transmittals', t.publicId)}>
            <td><b>{t.number}</b><small className="sub">to {t.recipient}</small></td>
            <td>{t.job.number}</td>
            <td>{t.customer.name}{t.clientProjectReference && <small className="sub">{t.clientProjectReference}</small>}</td>
            <td>{PURPOSE_LABEL[t.purpose]}</td>
            <td>{t.revisions}</td>
            <td>{stampIst(t.issuedAt)}<small className="sub">{t.issuedBy.displayName}</small></td>
          </tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}

// ---------------- issue ----------------

/** Pick the job's QC-approved revisions (one per drawing), the purpose, who it goes to; issue. */
export function IssueTransmittal({ job, candidates, onClose, onIssued }: { job: DesignJobDetail; candidates: DrawingSummary[]; onClose: () => void; onIssued: (publicId: string) => void }) {
  const [purpose, setPurpose] = useState<'for_approval' | 'for_construction' | 'for_information'>('for_approval');
  const [picked, setPicked] = useState<Set<string>>(new Set(candidates.map((d) => d.current!.publicId)));
  const [recipient, setRecipient] = useState(job.receivedFrom.name);
  const [note, setNote] = useState('');
  const [publicId] = useState(uuidv7);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const allowed = (d: DrawingSummary) => purpose !== 'for_construction' || d.current!.stage === 'construction';
  const chosen = candidates.filter((d) => picked.has(d.current!.publicId) && allowed(d));
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = IssueTransmittalRequest.safeParse({ publicId, purpose, revisionPublicIds: chosen.map((d) => d.current!.publicId), recipient, note });
    if (!parsed.success) { setError(chosen.length ? formError(parsed.error) : 'Pick at least one revision'); return; }
    setSaving(true); setError('');
    try {
      const issued = await api<Transmittal>(`/design/jobs/${job.publicId}/transmittals`, { method: 'POST', json: parsed.data });
      void refreshDesign();
      onIssued(issued.publicId);
    }
    catch (err) { setError(errText(err)); setSaving(false); }
  }
  return <Modal title={`Issue a transmittal · ${job.number}`} subtitle="Issuing a revision supersedes the drawing's earlier issued revision. The cover sheet and zip follow." onClose={onClose} wide>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Purpose<select id="tr-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as typeof purpose)}>
          {Object.entries(PURPOSE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label>To<input id="tr-recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={200} /></label>
        <label className="span-two">Note<span className="optional">optional, printed on the cover sheet</span><input id="tr-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></label>
      </div>
      <div className="mini-h">QC-approved revisions · {chosen.length} chosen</div>
      <div className="dz-pick">{candidates.map((d) => {
        const ok = allowed(d);
        return <label key={d.publicId} className={`dz-pick-row ${picked.has(d.current!.publicId) && ok ? 'on' : ''} ${ok ? '' : 'off'}`}>
          <input type="checkbox" disabled={!ok} checked={picked.has(d.current!.publicId) && ok} onChange={() => toggle(d.current!.publicId)} />
          <span><b>{d.number}</b> rev {d.current!.code} · {d.title}
            {!ok && <small className="sub">Preliminary revision: not issued for construction</small>}</span>
        </label>;
      })}</div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving || !chosen.length}><Send size={13} /> {saving ? 'Issuing…' : `Issue ${chosen.length} revision${chosen.length === 1 ? '' : 's'}`}</button></div>
    </form>
  </Modal>;
}

// ---------------- one transmittal ----------------

export function TransmittalPage({ id, access }: { id: string; access: DesignAccessInfo }) {
  const q = useApi<Transmittal>(`/design/transmittals/${id}`);
  const [answering, setAnswering] = useState<{ item: TransmittalItem; response: 'accepted' | 'returned' } | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const t = q.data;
  const back = <button className="outline-btn" onClick={() => (t ? goDesign('jobs', t.job.publicId) : goDesign('transmittals'))}><ArrowLeft size={14} /> {t ? t.job.number : 'Back'}</button>;
  if (!t) return <Panel title="Transmittal" action={back}><div className="panel-body">{q.error ? <Notice>{q.error}</Notice> : <Loading />}</div></Panel>;
  const manages = !!accessIn(access, t.company)?.manage;
  const waiting = t.items.filter((i) => i.status === 'issued').length;

  return <>
    <Panel title={`${t.number} · ${PURPOSE_LABEL[t.purpose]}`} note={`${t.customer.name}${t.clientProjectReference ? ` · ${t.clientProjectReference}` : ''} · design job ${t.job.number}`}
      action={<div className="row-actions">{back}
        <DownloadButton path={`/design/transmittals/${t.publicId}/cover-sheet`} name={`${t.number}_cover.pdf`} label="Cover sheet (PDF)" onError={setError} />
        <DownloadButton path={`/design/transmittals/${t.publicId}/zip`} name={`${t.number}.zip`} label="Drawings (zip)" onError={setError} primary />
      </div>}>
      <div className="panel-body">
        {error && <Notice onClose={() => setError('')}>{error}</Notice>}
        {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
        <div className="kv-grid">
          <span>To</span><b>{t.recipient}</b>
          <span>Issued</span><b>{stampIst(t.issuedAt)} by {t.issuedBy.displayName}</b>
          {t.note && <><span>Note</span><b className="dz-pre">{t.note}</b></>}
          <span>Client response</span><b>{waiting ? `${waiting} of ${t.items.length} still awaiting the client` : 'All answered (or superseded)'}</b>
        </div>
      </div>
    </Panel>
    <Panel title="Revisions issued" note={manages ? 'Record what the client said about each revision: accepted, or returned with comments.' : undefined}>
      <div className="panel-body">
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>DRAWING</th><th>REV</th><th>DISCIPLINE</th><th>SHEET · SCALE</th><th>STATUS</th><th /></tr></thead>
          <tbody>{t.items.map((i) => <tr key={i.revisionPublicId}>
            <td><button className="link-btn" onClick={() => goDesign('drawings', i.drawingPublicId)}><b>{i.drawingNumber}</b></button><small className="sub">{i.title}</small></td>
            <td>{i.code}</td><td>{i.discipline}</td><td>{i.sheet ?? '—'} · {i.scale ?? '—'}</td>
            <td><Badge tone={REV_TONE[i.status]}>{REV_LABEL[i.status]}</Badge></td>
            <td>{manages && i.status === 'issued' && <div className="row-actions">
              <button className="outline-btn" onClick={() => setAnswering({ item: i, response: 'accepted' })}><Check size={13} /> Accepted</button>
              <button className="danger-btn" onClick={() => setAnswering({ item: i, response: 'returned' })}><Undo2 size={13} /> Returned</button>
            </div>}</td>
          </tr>)}</tbody></table></div>
      </div>
    </Panel>
    {answering && <ResponseDialog item={answering.item} response={answering.response} recipient={t.recipient} onClose={() => setAnswering(null)}
      onSaved={() => { setAnswering(null); void refreshDesign(); setNote(answering.response === 'accepted' ? 'Recorded: accepted.' : 'Recorded: returned. The drawing needs its next revision.'); }} />}
  </>;
}

function ResponseDialog({ item, response, recipient, onClose, onSaved }: { item: TransmittalItem; response: 'accepted' | 'returned'; recipient: string; onClose: () => void; onSaved: () => void }) {
  const [comments, setComments] = useState('');
  const [respondedOn, setRespondedOn] = useState(todayIst());
  const [responderName, setResponderName] = useState(recipient);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = ClientResponseRequest.safeParse({ response, comments, respondedOn, responderName });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setSaving(true); setError('');
    try { await api(`/design/revisions/${item.revisionPublicId}/response`, { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title={`${item.drawingNumber} rev ${item.code}: ${response === 'accepted' ? 'accepted' : 'returned'} by the client`}
    subtitle={response === 'returned' ? 'Say why: the designer starts the next revision from this.' : 'Recorded once; it does not change.'} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Date<input id="cr-date" type="date" max={todayIst()} value={respondedOn} onChange={(e) => setRespondedOn(e.target.value)} /></label>
        <label>Who answered<input id="cr-name" value={responderName} onChange={(e) => setResponderName(e.target.value)} maxLength={120} /></label>
        <label className="span-two">Comments{response === 'accepted' && <span className="optional">optional</span>}
          <textarea id="cr-comments" rows={3} value={comments} onChange={(e) => setComments(e.target.value)} maxLength={4000} autoFocus={response === 'returned'} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className={response === 'accepted' ? 'primary-btn' : 'danger-btn'} disabled={saving}>{saving ? 'Saving…' : 'Record'}</button></div>
    </form>
  </Modal>;
}
