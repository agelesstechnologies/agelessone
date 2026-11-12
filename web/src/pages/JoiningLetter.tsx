import { useEffect, useState } from 'react';
import { Download, FileText, LoaderCircle, X } from 'lucide-react';
import type { IssuedLetter, LetterDraft, PersonDetail } from '@ageless/shared';
import { api, downloadFile, errText } from '../api';
import { dayLabel, useLoad, uuidv7 } from '../hooks';
import { Notice } from '../ui';

/**
 * The joining letter for one person (HR and the CEO only). The company's template comes filled with the job's details;
 * adjust the text for this person if needed, then Download PDF: the exact text is kept as issued and can be downloaded
 * again below. To change the wording for everyone, edit the template under Organisation → Letter templates.
 */
export default function JoiningLetter({ personPublicId, personName, employmentPublicId, onClose }:
  { personPublicId: string; personName: string; employmentPublicId?: string; onClose: () => void }) {
  const person = useLoad(() => api<PersonDetail>(`/hrms/people/${personPublicId}`), [personPublicId]);
  const jobs = (person.data?.employments ?? []).filter((j) => j.status !== 'exited');
  const [picked, setPicked] = useState(employmentPublicId ?? '');
  const job = picked || jobs.find((j) => j.isPrimary)?.publicId || jobs[0]?.publicId || '';
  const draft = useLoad(() => (job ? api<LetterDraft>(`/hrms/employments/${job}/joining-letter`) : Promise.resolve(null)), [job]);
  const issued = useLoad(() => (job ? api<IssuedLetter[]>(`/hrms/employments/${job}/joining-letters`) : Promise.resolve([])), [job]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [letterId, setLetterId] = useState(uuidv7);   // one id per version of the text: pressing twice keeps it once
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { if (draft.data) { setTitle(draft.data.title); setBody(draft.data.body); setLetterId(uuidv7()); } }, [draft.data]);

  const fileName = (l: IssuedLetter) => `joining-letter-${l.employment.employeeCode}-${l.issuedAt.slice(0, 10)}.pdf`;
  async function download(l: IssuedLetter) {
    setBusy(l.publicId); setError('');
    try { await downloadFile(`/hrms/letters/${l.publicId}/pdf`, fileName(l)); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(''); }
  }
  async function issueAndDownload() {
    if (!title.trim() || !body.trim()) { setError('The letter needs a title and some text'); return; }
    setBusy('issue'); setError('');
    try {
      const letter = await api<IssuedLetter>(`/hrms/employments/${job}/joining-letters`, { method: 'POST', json: { publicId: letterId, title, body } });
      await downloadFile(`/hrms/letters/${letter.publicId}/pdf`, fileName(letter));
      issued.reload();
    } catch (e) { setError(errText(e)); }
    finally { setBusy(''); }
  }

  return <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="modal letter-modal">
      <div className="modal-head"><div><div className="eyebrow">HR · LETTERS</div><h2>Joining letter</h2>
        <p>{personName}{draft.data ? ` · ${draft.data.employment.company} · ${draft.data.employment.employeeCode}` : ''}</p></div>
        <button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
      {(error || person.error || draft.error) && <Notice onClose={() => setError('')}>{error || person.error || draft.error}</Notice>}
      {jobs.length > 1 && <div className="form-grid"><label className="span-two">Job
        <select value={job} onChange={(e) => setPicked(e.target.value)}>{jobs.map((j) => <option key={j.publicId} value={j.publicId}>
          {j.company.code} · {j.employeeCode}{j.designation ? ` · ${j.designation}` : ''}</option>)}</select></label></div>}
      {person.data && !jobs.length ? <p className="muted-text">This person has no current job, so there is nothing to write a joining letter for.</p>
        : draft.loading && !draft.data ? <div className="loading"><LoaderCircle className="spin" size={18} />Preparing the letter…</div>
          : <div className="form-grid">
            <label className="span-two">Title<input value={title} onChange={(e) => { setTitle(e.target.value); setLetterId(uuidv7()); }} maxLength={200} /></label>
            <label className="span-two">Letter <span className="optional">filled from the company template; change anything for this person</span>
              <textarea className="letter-text" value={body} onChange={(e) => { setBody(e.target.value); setLetterId(uuidv7()); }} rows={14} maxLength={20000} /></label>
          </div>}
      <div className="detail-section"><h3><FileText size={16} />Issued letters</h3>
        {issued.data?.length ? issued.data.map((l) => <div className="detail-row" key={l.publicId}>
          <span>{dayLabel(new Date(l.issuedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }))} · by {l.issuedBy.displayName}</span>
          <button className="text-btn" disabled={busy === l.publicId} onClick={() => void download(l)}><Download size={14} /> PDF</button></div>)
          : <p className="muted-text">None yet. Download PDF keeps a copy here.</p>}
      </div>
      <div className="modal-foot"><button className="outline-btn" onClick={onClose}>Close</button>
        <button className="primary-btn" disabled={!job || !draft.data || busy === 'issue'} onClick={() => void issueAndDownload()}>
          {busy === 'issue' ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}Download PDF</button></div>
    </section>
  </div>;
}
