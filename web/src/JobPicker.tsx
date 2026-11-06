import { useState } from 'react';
import type { PersonDetail, PersonList } from '@ageless/shared';
import { api, errText } from './api';

/**
 * Pick one job (employment): search for a person, then choose which of their jobs.
 * `onChange` gets the job's public ID, or '' while nothing is chosen.
 */
export default function JobPicker({ onChange, idPrefix = 'job' }: { onChange: (employmentPublicId: string) => void; idPrefix?: string }) {
  const [search, setSearch] = useState('');
  const [people, setPeople] = useState<PersonList['items']>([]);
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [error, setError] = useState('');

  async function find() {
    setError(''); setPerson(null); onChange('');
    try { setPeople((await api<PersonList>(`/hrms/people?search=${encodeURIComponent(search)}&pageSize=20`)).items); }
    catch (e) { setError(errText(e)); }
  }
  async function choose(publicId: string) {
    setError(''); onChange('');
    if (!publicId) { setPerson(null); return; }
    try {
      const p = await api<PersonDetail>(`/hrms/people/${publicId}`);
      setPerson(p);
      const live = p.employments.filter((j) => j.status !== 'exited');
      if (live.length === 1) onChange(live[0]!.publicId);
    } catch (e) { setError(errText(e)); }
  }
  const jobs = person?.employments.filter((j) => j.status !== 'exited') ?? [];

  return <>
    <label className="span-two">Find person
      <span className="chip-row">
        <input id={`${idPrefix}-search`} className="input" value={search} placeholder="Name, employee code, phone or email"
          onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void find(); } }} />
        <button type="button" className="outline-btn" onClick={() => void find()}>Search</button></span></label>
    {error && <span className="span-two muted-text">{error}</span>}
    {!!people.length && <label className="span-two">Person
      <select id={`${idPrefix}-person`} defaultValue="" onChange={(e) => void choose(e.target.value)}>
        <option value="">Choose…</option>
        {people.map((p) => <option key={p.publicId} value={p.publicId}>{p.displayName}{p.primaryEmployment ? ` · ${p.primaryEmployment.employeeCode}` : ''}</option>)}</select></label>}
    {person && <label className="span-two">Job
      <select id={`${idPrefix}-job`} key={person.publicId} defaultValue={jobs.length === 1 ? jobs[0]!.publicId : ''} onChange={(e) => onChange(e.target.value)} required>
        {jobs.length !== 1 && <option value="">Choose…</option>}
        {jobs.map((j) => <option key={j.publicId} value={j.publicId}>{j.company.code} · {j.employeeCode}{j.designation ? ` · ${j.designation}` : ''}</option>)}</select></label>}
  </>;
}
