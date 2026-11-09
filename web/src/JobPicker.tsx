import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { PersonDetail, PersonList } from '@ageless/shared';
import { api, errText } from './api';

type Found = PersonList['items'][number];

/**
 * One search box: type 2+ letters of a name or employee code, matching people drop down, click one. The chosen person
 * shows in the box with × to clear. onPick gets the person (or null when cleared).
 */
function PersonSearch({ id, label, hint, onPick }: { id: string; label: string; hint?: string; onPick: (p: Found | null) => void }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Found | null>(null);
  const [error, setError] = useState('');
  const box = useRef<HTMLLabelElement>(null);

  // search as you type (after a short pause)
  useEffect(() => {
    if (chosen || text.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => {
      api<PersonList>(`/hrms/people?search=${encodeURIComponent(text.trim())}&pageSize=8`)
        .then((r) => { setFound(r.items); setOpen(true); setError(''); })
        .catch((e) => setError(errText(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [text, chosen]);

  // a click elsewhere closes the list
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (p: Found | null) => { setChosen(p); setText(p ? p.displayName : ''); setOpen(false); onPick(p); };
  const code = (p: Found) => p.primaryEmployment?.employeeCode;

  return <label className="span-two person-search" ref={box}>{label}{hint && <span className="optional">{hint}</span>}
    <span className="person-search-box">
      <input id={id} value={chosen ? `${chosen.displayName}${code(chosen) ? ` · ${code(chosen)}` : ''}` : text} readOnly={!!chosen}
        placeholder="Type a name or employee code" autoComplete="off"
        onChange={(e) => setText(e.target.value)} onFocus={() => found.length && setOpen(true)} />
      {chosen && <button type="button" className="person-clear" onClick={() => pick(null)} aria-label="Clear"><X size={15} /></button>}
    </span>
    {open && !chosen && text.trim().length >= 2 && <ul className="person-results" role="listbox">
      {found.length ? found.map((p) => <li key={p.publicId} role="option" aria-selected="false" onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
        <b>{p.displayName}</b><small>{[code(p), p.primaryEmployment?.company].filter(Boolean).join(' · ')}</small></li>)
        : <li className="none">No one found</li>}
    </ul>}
    {error && <small className="field-error">{error}</small>}
  </label>;
}

/** Pick a person; onChange gets their public ID, or '' while none is chosen. */
export function PersonPicker({ idPrefix, label, hint, onChange }: { idPrefix: string; label: string; hint?: string; onChange: (publicId: string) => void }) {
  return <PersonSearch id={`${idPrefix}-search`} label={label} hint={hint} onPick={(p) => onChange(p?.publicId ?? '')} />;
}

/**
 * Pick one job: search for the person; a person with one current job is done, one with several also picks the job.
 * onChange gets the job's public ID, or '' while nothing is chosen.
 */
export default function JobPicker({ onChange, idPrefix = 'job', label = 'Person', hint }: { onChange: (employmentPublicId: string) => void; idPrefix?: string; label?: string; hint?: string }) {
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [error, setError] = useState('');
  const jobs = person?.employments.filter((j) => j.status !== 'exited') ?? [];

  async function choose(p: Found | null) {
    setError(''); setPerson(null); onChange('');
    if (!p) return;
    try {
      const detail = await api<PersonDetail>(`/hrms/people/${p.publicId}`);
      setPerson(detail);
      const live = detail.employments.filter((j) => j.status !== 'exited');
      if (live.length === 1) onChange(live[0]!.publicId);
      if (!live.length) setError('This person has no current job');
    } catch (e) { setError(errText(e)); }
  }

  return <>
    <PersonSearch id={`${idPrefix}-search`} label={label} hint={hint} onPick={(p) => void choose(p)} />
    {error && <span className="span-two field-error">{error}</span>}
    {jobs.length > 1 && <label className="span-two">Which job
      <select id={`${idPrefix}-job`} key={person!.publicId} defaultValue="" onChange={(e) => onChange(e.target.value)} required>
        <option value="">Choose…</option>
        {jobs.map((j) => <option key={j.publicId} value={j.publicId}>{j.company.code} · {j.employeeCode}{j.designation ? ` · ${j.designation}` : ''}</option>)}</select></label>}
  </>;
}
