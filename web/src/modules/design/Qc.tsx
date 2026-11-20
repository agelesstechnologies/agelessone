import { useEffect, useState } from 'react';
import { ArrowLeft, Check, ExternalLink, X } from 'lucide-react';
import { QcReviewRequest, type Drawing, type QcChecklist, type QcQueueReport, type Revision } from '@ageless/shared';
import { api, errText, fetchBlob, formError } from '../../api';
import { useAuth } from '../../auth';
import { useApi, uuidv7 } from '../../hooks';
import { Badge, Empty, Loading, Notice, Panel } from '../../ui';
import { ACCEPT, DownloadButton, FILE_KIND_LABEL, goDesign, refreshDesign, REV_LABEL, REV_TONE, stampIst } from './common';

// ---------------- the queue ----------------

/** Submitted revisions waiting for QC, oldest first. */
export function QcQueue({ company }: { company: string }) {
  const q = useApi<QcQueueReport>(`/design/reports/qc-queue?company=${company}`);
  return <Panel title="Waiting for QC" note="Submitted revisions, oldest first. You never review a revision you drew, nor one of a job whose tickets you work on.">
    <div className="panel-body">
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.rows.length ? <Empty title="Nothing to review" text="Revisions submitted for QC appear here." /> :
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>DRAWING</th><th>REVISION</th><th>JOB</th><th>SUBMITTED</th><th>WAITING</th></tr></thead>
          <tbody>{q.data.rows.map((r) => <tr key={r.revision.publicId} className="link-row" onClick={() => goDesign('qc', r.revision.publicId)}>
            <td><b>{r.drawing.number}</b><small className="sub">{r.drawing.title}</small></td>
            <td>Rev {r.revision.code}</td>
            <td>{r.job.number}</td>
            <td>{r.submittedBy.displayName}<small className="sub">{stampIst(r.submittedAt)}</small></td>
            <td>{r.waitingDays === 0 ? 'Today' : <Badge tone={r.waitingDays > 2 ? 'red' : 'amber'}>{r.waitingDays} day{r.waitingDays === 1 ? '' : 's'}</Badge>}</td>
          </tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}

// ---------------- the review screen (desktop first) ----------------

type Answer = { passed: boolean | null; note: string };

/** The revision's PDF beside the checklist, comments and mark-ups; approve or send back with changes needed. */
export function ReviewScreen({ revisionId }: { revisionId: string }) {
  const { me } = useAuth();
  const rev = useApi<Revision>(`/design/revisions/${revisionId}`);
  const drawingId = rev.data?.drawingPublicId;
  const drawing = useApi<Drawing>(drawingId ? `/design/drawings/${drawingId}` : null);
  const company = drawing.data?.company;
  const checklist = useApi<QcChecklist>(company ? `/design/qc/checklist?company=${company}` : null);
  const pdf = rev.data?.files.find((f) => f.kind === 'pdf');
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [comments, setComments] = useState('');
  const [markups, setMarkups] = useState<File[]>([]);
  const [publicId] = useState(uuidv7);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!pdf) return;
    let url = '';
    let gone = false;
    fetchBlob(`/design/revision-files/${pdf.publicId}/file`)
      .then((b) => { if (gone) return; url = URL.createObjectURL(new Blob([b], { type: 'application/pdf' })); setPdfUrl(url); })
      .catch((e) => !gone && setPdfError(errText(e)));
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [pdf?.publicId]);

  const items = checklist.data?.items ?? [];
  const answered = items.filter((i) => answers[i]?.passed !== null && answers[i]?.passed !== undefined).length;
  const allPassed = items.length > 0 && items.every((i) => answers[i]?.passed === true);
  const set = (item: string, a: Partial<Answer>) => setAnswers((x) => ({ ...x, [item]: { passed: x[item]?.passed ?? null, note: x[item]?.note ?? '', ...a } }));

  async function decide(decision: 'approved' | 'changes_needed') {
    const parsed = QcReviewRequest.safeParse({ publicId, decision, comments,
      checklist: items.map((item) => ({ item, passed: answers[item]?.passed === true, ...(answers[item]?.note.trim() && { note: answers[item].note.trim() }) })) });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    if (answered < items.length) { setError('Mark every checklist item as passed or failed'); return; }
    const body = new FormData();
    body.append('publicId', publicId);
    body.append('decision', decision);
    if (comments.trim()) body.append('comments', comments.trim());
    body.append('checklist', JSON.stringify(parsed.data.checklist));
    for (const m of markups.slice(0, 5)) body.append('files', m);
    setBusy(true); setError('');
    try {
      rev.setData(await api<Revision>(`/design/revisions/${revisionId}/qc`, { method: 'POST', body }));
      void refreshDesign();
      setDone(decision === 'approved' ? 'Approved: it can now be issued in a transmittal.' : 'Sent back: the designer starts the next revision.');
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  const back = <button className="outline-btn" onClick={() => goDesign('qc')}><ArrowLeft size={14} /> Queue</button>;
  const r = rev.data;
  if (!r) return <Panel title="QC review" action={back}><div className="panel-body">{rev.error ? <Notice>{rev.error}</Notice> : <Loading />}</div></Panel>;
  const mine = me && [r.titleBlock.drawnBy.publicId, r.createdBy.publicId, r.submittedBy?.publicId].includes(me.person.publicId);

  return <Panel title={`QC · ${r.drawingNumber} revision ${r.code}`} note={`${r.title} · ${r.stage === 'construction' ? 'construction' : 'preliminary'}`}
    action={<div className="row-actions">{back}
      {drawing.data && <button className="outline-btn" onClick={() => goDesign('drawings', drawing.data!.publicId)}>Drawing</button>}
      <Badge tone={REV_TONE[r.status]}>{REV_LABEL[r.status]}</Badge></div>}>
    <div className="qc-review">
      <div className="qc-pdf-pane">
        {pdfError && <Notice>{pdfError}</Notice>}
        {!pdf ? <Empty title="No PDF" /> : !pdfUrl ? <Loading text="Opening the PDF…" /> : <>
          <iframe className="qc-pdf" src={pdfUrl} title={`${r.drawingNumber} revision ${r.code}`} />
          <a className="outline-btn qc-open" href={pdfUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Open the PDF in a new tab</a>
        </>}
      </div>
      <div className="qc-side">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice onClose={() => setError('')}>{error}</Notice>}
        <div className="kv-grid">
          <span>Change</span><b className="dz-pre">{r.changeNote}</b>
          <span>Drawn by</span><b>{r.titleBlock.drawnBy.displayName}</b>
          <span>Title block</span><b>scale {r.titleBlock.scale ?? '—'} · sheet {r.titleBlock.sheet ?? '—'}{r.titleBlock.clientProjectReference && ` · ${r.titleBlock.clientProjectReference}`}</b>
          {r.submittedAt && <><span>Submitted</span><b>{stampIst(r.submittedAt)} by {r.submittedBy?.displayName}</b></>}
        </div>
        <div className="chip-row">{r.files.filter((f) => f.kind !== 'pdf').map((f) =>
          <DownloadButton key={f.publicId} path={`/design/revision-files/${f.publicId}/file`} name={f.name} label={`${FILE_KIND_LABEL[f.kind]}: ${f.name}`} onError={setError} />)}</div>

        {r.qc ? <div className="qc-decided">
          <div className="mini-h">Decision</div>
          <p><Badge tone={r.qc.decision === 'approved' ? 'green' : 'red'}>{r.qc.decision === 'approved' ? 'Approved' : 'Changes needed'}</Badge> by {r.qc.reviewer.displayName}, {stampIst(r.qc.decidedAt)}</p>
          {r.qc.comments && <p className="dz-pre">{r.qc.comments}</p>}
          <ul className="qc-done-list">{r.qc.checklist.map((c) => <li key={c.item} className={c.passed ? 'ok' : 'bad'}>{c.passed ? '✓' : '✗'} {c.item}{c.note && <small> — {c.note}</small>}</li>)}</ul>
        </div> : r.status !== 'submitted' ? <Notice>This revision is {REV_LABEL[r.status].toLowerCase()}: only submitted revisions are reviewed.</Notice> : <>
          {mine && <Notice>You drew or submitted this revision: someone else reviews it.</Notice>}
          <div className="mini-h">Checklist · {answered} of {items.length}</div>
          {checklist.error && <Notice>{checklist.error}</Notice>}
          <ol className="qc-checklist">{items.map((item) => {
            const a = answers[item];
            return <li key={item}>
              <div className="qc-item"><span>{item}</span>
                <div className="qc-toggle">
                  <button type="button" className={a?.passed === true ? 'on pass' : ''} onClick={() => set(item, { passed: true })}><Check size={13} /> Pass</button>
                  <button type="button" className={a?.passed === false ? 'on fail' : ''} onClick={() => set(item, { passed: false })}><X size={13} /> Fail</button>
                </div></div>
              {a?.passed === false && <input className="input" value={a.note} onChange={(e) => set(item, { note: e.target.value })} placeholder="What is wrong (optional)" maxLength={500} />}
            </li>;
          })}</ol>
          <label className="qc-field">Comments<span className="optional">needed for changes needed</span>
            <textarea id="qc-comments" className="input" rows={4} value={comments} onChange={(e) => setComments(e.target.value)} maxLength={4000} /></label>
          <label className="qc-field">Marked-up files<span className="optional">PDF, JPEG or PNG, up to 5</span>
            <input id="qc-markups" type="file" multiple accept={ACCEPT.markup} onChange={(e) => setMarkups([...(e.target.files ?? [])].slice(0, 5))} /></label>
          <div className="qc-actions">
            <button type="button" className="danger-btn" disabled={busy || !!mine || comments.trim().length < 3} title={comments.trim().length < 3 ? 'Say what needs changing' : undefined}
              onClick={() => void decide('changes_needed')}>Changes needed</button>
            <button type="button" className="primary-btn" disabled={busy || !!mine || !allPassed} title={allPassed ? undefined : 'Every item must pass to approve'}
              onClick={() => void decide('approved')}><Check size={14} /> Approve</button>
          </div>
        </>}
      </div>
    </div>
  </Panel>;
}
