import { useState, type FormEvent } from 'react';
import { ArrowLeft, Pencil, Plus, Send, X } from 'lucide-react';
import { CreateRevisionRequest, UpdateRevisionRequest, type DesignJobDetail, type Drawing, type DrawingsReport, type Revision } from '@ageless/shared';
import { api, errText, formError } from '../../api';
import { useApi, uuidv7 } from '../../hooks';
import { Badge, CsvButton, Empty, Loading, Modal, Notice, Panel } from '../../ui';
import {
  ACCEPT, disciplineName, DownloadButton, FILE_KIND_LABEL, fileSize, goDesign, PURPOSE_LABEL, refreshDesign, REV_LABEL, REV_TONE, stampIst, UploadButton,
} from './common';

// ---------------- the register ----------------

/** Every drawing of the company's jobs with its current revision, by job and then discipline. */
export function DrawingRegister({ company }: { company: string }) {
  const [job, setJob] = useState('');
  const [discipline, setDiscipline] = useState('');
  const [status, setStatus] = useState('');
  const [csvError, setCsvError] = useState('');
  const all = useApi<DrawingsReport>(`/design/reports/drawings?company=${company}`);
  const rows = (all.data?.rows ?? []).filter((r) => (!job || r.job.publicId === job) && (!discipline || r.drawing.discipline === discipline)
    && (!status || (r.revision?.status ?? 'no_revision') === status));
  const jobs = [...new Map((all.data?.rows ?? []).map((r) => [r.job.publicId, r])).values()];
  const disciplines = [...new Set((all.data?.rows ?? []).map((r) => r.drawing.discipline))].sort();
  const params = new URLSearchParams({ company, ...(job && { job }), ...(discipline && { discipline }), ...(status && { status }) }).toString();
  return <Panel title="Drawing register" note={`Every drawing of ${company}'s design jobs with its current revision.`}>
    <div className="panel-body">
      <div className="filters">
        <label className="inline-field">Job<select id="dr-job" className="input" value={job} onChange={(e) => setJob(e.target.value)}>
          <option value="">All</option>{jobs.map((r) => <option key={r.job.publicId} value={r.job.publicId}>{r.job.number} · {r.customer}</option>)}</select></label>
        <label className="inline-field">Discipline<select id="dr-discipline" className="input" value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
          <option value="">All</option>{disciplines.map((d) => <option key={d} value={d}>{d} · {disciplineName(d)}</option>)}</select></label>
        <label className="inline-field">Status<select id="dr-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>{Object.entries(REV_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <CsvButton path={`/design/reports/drawings?${params}`} name={`drawing-register-${company}.csv`} onError={setCsvError} />
      </div>
      {(all.error || csvError) && <Notice onClose={() => setCsvError('')}>{all.error || csvError}</Notice>}
      {all.loading && !all.data ? <Loading /> : !rows.length ? <Empty title="No drawings" text="Drawings of the design jobs appear here." /> :
        [...new Set(rows.map((r) => r.job.publicId))].map((jobId) => {
          const ofJob = rows.filter((r) => r.job.publicId === jobId);
          return <div key={jobId} className="dz-group">
            <div className="mini-h"><button className="link-btn" onClick={() => goDesign('jobs', jobId)}>{ofJob[0].job.number}</button> · {ofJob[0].customer}</div>
            {[...new Set(ofJob.map((r) => r.drawing.discipline))].map((disc) => <div key={disc}>
              <div className="dz-sub">{disc} · {disciplineName(disc)}</div>
              <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>DRAWING</th><th>TITLE</th><th>REVISION</th><th>STATUS</th></tr></thead>
                <tbody>{ofJob.filter((r) => r.drawing.discipline === disc).map((r) => <tr key={r.drawing.publicId} className="link-row" onClick={() => goDesign('drawings', r.drawing.publicId)}>
                  <td><b>{r.drawing.number}</b></td><td>{r.drawing.title}</td><td>{r.revision ? `Rev ${r.revision.code}` : '—'}</td>
                  <td><Badge tone={REV_TONE[r.revision?.status ?? 'no_revision']}>{REV_LABEL[r.revision?.status ?? 'no_revision']}</Badge></td>
                </tr>)}</tbody></table></div>
            </div>)}
          </div>;
        })}
    </div>
  </Panel>;
}

// ---------------- one drawing ----------------

export function DrawingPage({ id }: { id: string }) {
  const q = useApi<Drawing>(`/design/drawings/${id}`);
  const jobId = q.data?.job.publicId;
  const job = useApi<DesignJobDetail>(jobId ? `/design/jobs/${jobId}` : null);
  const [dialog, setDialog] = useState<'revision' | 'rename' | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const d = q.data;
  const back = <button className="outline-btn" onClick={() => (jobId ? goDesign('jobs', jobId) : goDesign('drawings'))}><ArrowLeft size={14} /> {d ? d.job.number : 'Back'}</button>;
  if (!d) return <Panel title="Drawing" action={back}><div className="panel-body">{q.error ? <Notice>{q.error}</Notice> : <Loading />}</div></Panel>;
  const open = !!job.data && job.data.status !== 'closed' && job.data.status !== 'cancelled';
  const draws = open && !!job.data?.actions.draw;
  const working = d.revisions.find((r) => r.status === 'draft' || r.status === 'submitted');
  const newest = [...d.revisions].reverse();
  const anySubmitted = d.revisions.some((r) => r.status !== 'draft');
  const hasConstruction = d.revisions.some((r) => r.stage === 'construction');

  return <>
    <Panel title={`${d.number} · ${d.title}`} note={`${d.discipline} · ${disciplineName(d.discipline)} · design job ${d.job.number}`}
      action={<div className="row-actions">{back}
        {draws && !anySubmitted && <button className="outline-btn" onClick={() => setDialog('rename')}><Pencil size={13} /> Rename</button>}
        {draws && !working && <button className="primary-btn" onClick={() => setDialog('revision')}><Plus size={16} /> New revision</button>}
      </div>}>
      <div className="panel-body">
        {(error || job.error) && <Notice onClose={() => setError('')}>{error || job.error}</Notice>}
        {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
        {!d.revisions.length && <Empty title="No revision yet" text={draws ? 'Upload the first revision with New revision (PDF, source files, BOM, change note).' : 'The first revision appears here.'} />}
        {working?.status === 'submitted' && <Notice tone="ok">Revision {working.code} is waiting for QC. A submitted revision never changes; after QC, the next revision can be started.</Notice>}
      </div>
    </Panel>

    {working?.status === 'draft' && <DraftRevision rev={working} canEdit={draws} onChange={(r) => { void refreshDesign(); if (r === 'submitted') setNote('Submitted for QC.'); }} />}

    {newest.filter((r) => r.status !== 'draft').map((r) => <RevisionCard key={r.publicId} rev={r} onError={setError} />)}

    {dialog === 'revision' && <NewRevision drawing={d} hasConstruction={hasConstruction} onClose={() => setDialog(null)}
      onDone={(submitted) => { setDialog(null); void refreshDesign(); setNote(submitted ? 'Revision submitted for QC.' : 'Draft saved: add the remaining files, then submit.'); }} />}
    {dialog === 'rename' && <Rename drawing={d} onClose={() => setDialog(null)} onSaved={(nd) => { q.setData(nd); void refreshDesign(); setDialog(null); setNote('Renamed.'); }} />}
  </>;
}

/** A submitted (or later) revision: title block, files, QC, transmittal, the client's response. */
function RevisionCard({ rev, onError }: { rev: Revision; onError: (m: string) => void }) {
  return <Panel title={`Revision ${rev.code}`} note={`${rev.stage === 'construction' ? 'Construction' : 'Preliminary'} · ${rev.changeNote}`}
    action={<Badge tone={REV_TONE[rev.status]}>{REV_LABEL[rev.status]}</Badge>}>
    <div className="panel-body">
      <div className="kv-grid">
        <span>Title</span><b>{rev.title}</b>
        <span>Title block</span><b>Drawn by {rev.titleBlock.drawnBy.displayName} · scale {rev.titleBlock.scale ?? '—'} · sheet {rev.titleBlock.sheet ?? '—'}
          {rev.titleBlock.clientProjectReference && ` · ${rev.titleBlock.clientProjectReference}`}</b>
        {rev.submittedAt && <><span>Submitted</span><b>{stampIst(rev.submittedAt)} by {rev.submittedBy?.displayName}</b></>}
        {rev.qc && <><span>QC</span><b>
          <Badge tone={rev.qc.decision === 'approved' ? 'green' : 'red'}>{rev.qc.decision === 'approved' ? 'Approved' : 'Changes needed'}</Badge> by {rev.qc.reviewer.displayName}, {stampIst(rev.qc.decidedAt)}
          {rev.qc.comments && <span className="dz-pre"> — {rev.qc.comments}</span>}
          {rev.qc.checklist.filter((c) => !c.passed).map((c) => <small key={c.item} className="sub">✗ {c.item}{c.note ? `: ${c.note}` : ''}</small>)}
        </b></>}
        {rev.issuedIn && <><span>Issued</span><b><button className="link-btn" onClick={() => goDesign('transmittals', rev.issuedIn!.publicId)}>{rev.issuedIn.number}</button>
          {' '}{PURPOSE_LABEL[rev.issuedIn.purpose]}, {stampIst(rev.issuedIn.issuedAt)}</b></>}
        {rev.response && <><span>Client</span><b><Badge tone={rev.response.response === 'accepted' ? 'green' : 'red'}>{rev.response.response === 'accepted' ? 'Accepted' : 'Returned'}</Badge>
          {' '}{rev.response.responderName}, {rev.response.respondedOn}{rev.response.comments && <span className="dz-pre"> — {rev.response.comments}</span>}</b></>}
        {rev.supersededAt && <><span>Superseded</span><b>{stampIst(rev.supersededAt)}</b></>}
      </div>
      <Files rev={rev} onError={onError} />
      {rev.qc?.files.length ? <div className="chip-row">{rev.qc.files.map((f) =>
        <DownloadButton key={f.publicId} path={`/design/qc-files/${f.publicId}/file`} name={f.name} label={`Mark-up ${f.name.split('_qc-')[1] ?? ''}`} onError={onError} />)}</div> : null}
    </div>
  </Panel>;
}

function Files({ rev, onError, onRemove }: { rev: Revision; onError: (m: string) => void; onRemove?: (fileId: string) => void }) {
  if (!rev.files.length) return <p className="muted-text">No files yet.</p>;
  return <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>FILE</th><th>KIND</th><th>SIZE</th><th /></tr></thead>
    <tbody>{rev.files.map((f) => <tr key={f.publicId}>
      <td><b>{f.name}</b><small className="sub">{f.uploadedBy.displayName}, {stampIst(f.uploadedAt)}</small></td>
      <td>{FILE_KIND_LABEL[f.kind]}</td><td>{fileSize(f.sizeBytes)}</td>
      <td><div className="row-actions">
        <DownloadButton path={`/design/revision-files/${f.publicId}/file`} name={f.name} label="Download" onError={onError} />
        {onRemove && <button className="outline-btn" onClick={() => onRemove(f.publicId)}><X size={13} /> Remove</button>}
      </div></td>
    </tr>)}</tbody></table></div>;
}

/** The draft being worked on: change note and title block, its files, and Submit. */
function DraftRevision({ rev, canEdit, onChange }: { rev: Revision; canEdit: boolean; onChange: (what: 'files' | 'saved' | 'submitted') => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const hasPdf = rev.files.some((f) => f.kind === 'pdf');

  async function upload(kind: 'pdf' | 'source' | 'bom', files: File[]) {
    setBusy(kind); setError('');
    try {
      for (const file of files) {
        const body = new FormData(); body.append('publicId', uuidv7()); body.append('kind', kind); body.append('file', file);
        await api(`/design/revisions/${rev.publicId}/files`, { method: 'POST', body });
      }
      onChange('files');
    } catch (e) { setError(errText(e)); }
    finally { setBusy(''); }
  }
  async function remove(fileId: string) {
    setError('');
    try { await api(`/design/revision-files/${fileId}/remove`, { method: 'POST', json: {} }); onChange('files'); } catch (e) { setError(errText(e)); }
  }
  async function submit() {
    setBusy('submit'); setError('');
    try { await api(`/design/revisions/${rev.publicId}/submit`, { method: 'POST', json: {} }); setConfirm(false); onChange('submitted'); }
    catch (e) { setError(errText(e)); setConfirm(false); }
    finally { setBusy(''); }
  }

  return <Panel title={`Revision ${rev.code} — draft`} note={`${rev.stage === 'construction' ? 'Construction' : 'Preliminary'} · ${rev.changeNote}`}
    action={canEdit ? <div className="row-actions">
      <button className="outline-btn" onClick={() => setEditing(true)}><Pencil size={13} /> Edit</button>
      <button className="primary-btn" disabled={!hasPdf || !!busy} title={hasPdf ? undefined : 'Attach the drawing PDF first'} onClick={() => setConfirm(true)}><Send size={13} /> Submit for QC</button>
    </div> : undefined}>
    <div className="panel-body">
      {error && <Notice onClose={() => setError('')}>{error}</Notice>}
      <div className="kv-grid">
        <span>Title</span><b>{rev.title}</b>
        <span>Title block</span><b>Drawn by {rev.titleBlock.drawnBy.displayName} · scale {rev.titleBlock.scale ?? '—'} · sheet {rev.titleBlock.sheet ?? '—'}
          {rev.titleBlock.clientProjectReference && ` · ${rev.titleBlock.clientProjectReference}`}</b>
      </div>
      {canEdit && <div className="chip-row">
        <UploadButton label={hasPdf ? 'Replace PDF' : 'Drawing PDF'} accept={ACCEPT.pdf} busy={busy === 'pdf'} onFiles={(f) => upload('pdf', f.slice(0, 1))} />
        <UploadButton label="Source files" accept={ACCEPT.source} multiple busy={busy === 'source'} onFiles={(f) => upload('source', f)} />
        <UploadButton label="BOM" accept={ACCEPT.bom} busy={busy === 'bom'} onFiles={(f) => upload('bom', f.slice(0, 1))} />
      </div>}
      <Files rev={rev} onError={setError} onRemove={canEdit ? (fid) => void remove(fid) : undefined} />
    </div>
    {editing && <EditRevision rev={rev} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChange('saved'); }} />}
    {confirm && <Modal title={`Submit revision ${rev.code}?`} subtitle="A submitted revision never changes: its files and title block are fixed, and it goes to Design QC." onClose={() => setConfirm(false)}>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={() => setConfirm(false)}>Not yet</button>
        <button type="button" className="primary-btn" disabled={busy === 'submit'} onClick={() => void submit()}>{busy === 'submit' ? 'Submitting…' : 'Submit for QC'}</button></div>
    </Modal>}
  </Panel>;
}

interface RevForm { changeNote: string; title: string; scale: string; sheet: string; reference: string }

function RevFields({ f, set }: { f: RevForm; set: (p: Partial<RevForm>) => void }) {
  return <>
    <label className="span-two">Change note<span className="optional">what this revision changes</span>
      <textarea id="rv-note" rows={2} value={f.changeNote} onChange={(e) => set({ changeNote: e.target.value })} maxLength={2000} /></label>
    <label className="span-two">Title (title block)<input id="rv-title" value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} /></label>
    <label>Scale<input id="rv-scale" value={f.scale} onChange={(e) => set({ scale: e.target.value })} maxLength={30} placeholder="e.g. 1:20" /></label>
    <label>Sheet<input id="rv-sheet" value={f.sheet} onChange={(e) => set({ sheet: e.target.value })} maxLength={30} placeholder="e.g. 1 of 2" /></label>
    <label className="span-two">Client project reference<span className="optional">left empty: none on the title block</span>
      <input id="rv-ref" value={f.reference} onChange={(e) => set({ reference: e.target.value })} maxLength={200} /></label>
  </>;
}

/**
 * "Upload a revision": the next revision with its change note, title block and files in one go; saved as a draft, or
 * submitted for QC straight away when its PDF is attached.
 */
function NewRevision({ drawing, hasConstruction, onClose, onDone }: { drawing: Drawing; hasConstruction: boolean; onClose: () => void; onDone: (submitted: boolean) => void }) {
  const last = drawing.revisions[drawing.revisions.length - 1];
  const [stage, setStage] = useState<'preliminary' | 'construction'>(hasConstruction ? 'construction' : 'preliminary');
  const [f, setF] = useState<RevForm>({ changeNote: '', title: last?.title ?? drawing.title, scale: last?.titleBlock.scale ?? '', sheet: last?.titleBlock.sheet ?? '',
    reference: last?.titleBlock.clientProjectReference ?? '' });
  const [pdf, setPdf] = useState<File | null>(null);
  const [sources, setSources] = useState<File[]>([]);
  const [bom, setBom] = useState<File | null>(null);
  const [publicId] = useState(uuidv7);
  const [error, setError] = useState('');
  const [step, setStep] = useState('');
  const returned = last && (last.status === 'returned' || last.status === 'changes_needed') ? last : null;

  async function save(e: { preventDefault(): void }, submit: boolean) {
    e.preventDefault();
    const parsed = CreateRevisionRequest.safeParse({ publicId, stage, changeNote: f.changeNote, title: f.title, scale: f.scale, sheet: f.sheet,
      clientProjectReference: f.reference });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    if (submit && !pdf) { setError('Attach the drawing PDF to submit'); return; }
    setError('');
    try {
      setStep('Saving the revision…');
      const rev = await api<Revision>(`/design/drawings/${drawing.publicId}/revisions`, { method: 'POST', json: parsed.data });
      const files: [string, File][] = [...(pdf ? [['pdf', pdf] as [string, File]] : []), ...sources.map((s) => ['source', s] as [string, File]), ...(bom ? [['bom', bom] as [string, File]] : [])];
      for (const [kind, file] of files) {
        setStep(`Uploading ${file.name}…`);
        const body = new FormData(); body.append('publicId', uuidv7()); body.append('kind', kind); body.append('file', file);
        await api(`/design/revisions/${rev.publicId}/files`, { method: 'POST', body });
      }
      if (submit) { setStep('Submitting…'); await api(`/design/revisions/${rev.publicId}/submit`, { method: 'POST', json: {} }); }
      onDone(submit);
    } catch (err) {
      // what was saved stays (the draft shows on the page); say what failed
      setError(`${errText(err)} The draft keeps what was saved so far.`);
      setStep('');
    }
  }

  return <Modal title={`New revision of ${drawing.number}`} subtitle="Preliminary revisions are lettered (A, B, C …), construction revisions numbered (0, 1, 2 …)." onClose={onClose} wide>
    <form onSubmit={(e) => void save(e, false)}>
      {error && <Notice>{error}</Notice>}
      {returned && <Notice tone="ok">Revision {returned.code} was {returned.status === 'returned' ? `returned by the client${returned.response?.comments ? `: ${returned.response.comments}` : ''}`
        : `sent back by QC${returned.qc?.comments ? `: ${returned.qc.comments}` : ''}`}</Notice>}
      <div className="form-grid">
        <label className="span-two">Stage<select id="rv-stage" value={stage} onChange={(e) => setStage(e.target.value as typeof stage)}>
          {!hasConstruction && <option value="preliminary">Preliminary (next letter)</option>}
          <option value="construction">For construction (next number)</option></select></label>
        <RevFields f={f} set={(p) => setF({ ...f, ...p })} />
        <label className="span-two">Drawing PDF<span className="optional">needed to submit</span><input id="rv-pdf" type="file" accept={ACCEPT.pdf} onChange={(e) => setPdf(e.target.files?.[0] ?? null)} /></label>
        <label>Source files<span className="optional">CAD, several allowed</span><input id="rv-src" type="file" multiple accept={ACCEPT.source} onChange={(e) => setSources([...(e.target.files ?? [])])} /></label>
        <label>BOM<span className="optional">CSV, XLSX or PDF</span><input id="rv-bom" type="file" accept={ACCEPT.bom} onChange={(e) => setBom(e.target.files?.[0] ?? null)} /></label>
      </div>
      {step && <p className="muted-text">{step}</p>}
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="outline-btn" disabled={!!step}>Save draft</button>
        <button type="button" className="primary-btn" disabled={!!step || !pdf} onClick={(e) => void save(e, true)}><Send size={13} /> Save and submit</button></div>
    </form>
  </Modal>;
}

function EditRevision({ rev, onClose, onSaved }: { rev: Revision; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<RevForm>({ changeNote: rev.changeNote, title: rev.title, scale: rev.titleBlock.scale ?? '', sheet: rev.titleBlock.sheet ?? '',
    reference: rev.titleBlock.clientProjectReference ?? '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = UpdateRevisionRequest.safeParse({ changeNote: f.changeNote, title: f.title, scale: f.scale, sheet: f.sheet, clientProjectReference: f.reference });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setSaving(true); setError('');
    try { await api(`/design/revisions/${rev.publicId}`, { method: 'PATCH', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title={`Edit revision ${rev.code}`} subtitle="Only a draft changes." onClose={onClose} wide>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid"><RevFields f={f} set={(p) => setF({ ...f, ...p })} /></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
    </form>
  </Modal>;
}

function Rename({ drawing, onClose, onSaved }: { drawing: Drawing; onClose: () => void; onSaved: (d: Drawing) => void }) {
  const [title, setTitle] = useState(drawing.title);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError('');
    try { onSaved(await api<Drawing>(`/design/drawings/${drawing.publicId}`, { method: 'PATCH', json: { title } })); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title={`Rename ${drawing.number}`} subtitle="Until a revision is submitted." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid"><label className="span-two">Title<input id="dd-rename" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
    </form>
  </Modal>;
}
