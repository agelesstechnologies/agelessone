import { useEffect, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  CreateHolidayRequest, CreateWeeklyOffRequest, type Holiday, type WeeklyOff, type WeeklyOffRule, type WorkCalendar,
} from '@ageless/shared';
import { api, errText, formError } from '../api';
import { useAuth } from '../auth';
import { addDays, dayLabel, todayIst, useLoad, useMyEmployments, uuidv7 } from '../hooks';
import { CALENDAR } from '../permissions';
import { Badge, DAY_TONE, Empty, Loading, Modal, Notice, PageHead, Panel, Tabs } from '../ui';

type TabKey = 'calendar' | 'holidays' | 'offs';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COMPANIES: [string, string][] = [['AE', 'Ageless Entertainments'], ['ATPL', 'Ageless Technologies']];

export default function Calendar() {
  const { can } = useAuth();
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'calendar', label: 'My calendar' }, { key: 'holidays', label: 'Holidays' },
    ...(can(CALENDAR.manage) ? [{ key: 'offs' as const, label: 'Weekly offs' }] : []),
  ];
  const [tab, setTab] = useState<TabKey>('calendar');
  return <>
    <PageHead eyebrow="HRMS • CALENDAR" title="Calendar" subtitle="Working days, holidays and weekly offs." />
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'calendar' && <MyCalendar />}
    {tab === 'holidays' && <Holidays />}
    {tab === 'offs' && <WeeklyOffs />}
  </>;
}

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const nextMonthStart = (d: string) => { const x = new Date(`${monthStart(d)}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); return x.toISOString().slice(0, 10); };

function MyCalendar() {
  const { jobs, primary, error: jobsError } = useMyEmployments();
  const [jobId, setJobId] = useState('');
  const [month, setMonth] = useState(monthStart(todayIst()));
  useEffect(() => { if (!jobId && primary) setJobId(primary.publicId); }, [primary, jobId]);
  const q = useLoad(() => (jobId ? api<WorkCalendar>(`/hrms/calendar?employment=${jobId}&from=${month}&to=${addDays(nextMonthStart(month), -1)}`) : Promise.resolve(null)), [jobId, month]);
  const shift = (n: number) => { const x = new Date(`${month}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); setMonth(x.toISOString().slice(0, 10)); };
  const lead = q.data?.days[0] ? new Date(`${q.data.days[0].date}T00:00:00Z`).getUTCDay() : 0;
  return <Panel title={new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' })} note="Working days, weekly offs and holidays for your job."
    action={<div className="chip-row"><button className="outline-btn" onClick={() => shift(-1)}>Previous</button><button className="outline-btn" onClick={() => shift(1)}>Next</button></div>}>
    <div className="panel-body">
      {jobs.length > 1 && <div className="filters"><label className="inline-field">Job
        <select id="cal-job" className="input" value={jobId} onChange={(e) => setJobId(e.target.value)}>
          {jobs.map((j) => <option key={j.publicId} value={j.publicId}>{j.company.code} · {j.employeeCode}</option>)}</select></label></div>}
      {(q.error || jobsError) && <Notice>{q.error || jobsError}</Notice>}
      {q.loading && !q.data ? <Loading /> : q.data && <div className="cal-grid" role="grid">
        {WEEKDAYS.map((w) => <b key={w} className="cal-head">{w}</b>)}
        {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
        {q.data.days.map((d) => <div key={d.date} className={`cal-day cal-${d.kind} ${d.date === todayIst() ? 'cal-today' : ''}`} title={d.holiday ?? d.optionalHoliday ?? d.kind.replace('_', ' ')}>
          <span>{Number(d.date.slice(8))}</span>{(d.holiday || d.optionalHoliday) && <small>{d.holiday ?? `${d.optionalHoliday} (optional)`}</small>}</div>)}
      </div>}
      <div className="chip-row"><Badge tone={DAY_TONE.working!}>working</Badge><Badge tone={DAY_TONE.weekly_off!}>weekly off</Badge><Badge tone="amber">holiday</Badge></div>
    </div>
  </Panel>;
}

function Holidays() {
  const { can } = useAuth();
  const [year, setYear] = useState(new Date().getFullYear());
  const [company, setCompany] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const q = useLoad(() => api<Holiday[]>(`/hrms/holidays?year=${year}${company ? `&company=${company}` : ''}`), [year, company]);
  async function remove(h: Holiday) {
    setError('');
    try { await api(`/hrms/holidays/${h.publicId}`, { method: 'DELETE' }); q.reload(); }
    catch (e) { setError(errText(e)); }
  }
  return <Panel title="Holidays" note="Optional holidays are working days that staff may take as leave."
    action={can(CALENDAR.manage) && <button className="primary-btn" onClick={() => setAdding(true)}><Plus size={16} /> Add holiday</button>}>
    <div className="panel-body">
      <div className="filters">
        <label className="inline-field">Year<input id="hol-year" className="input" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || year)} /></label>
        <label className="inline-field">Company
          <select id="hol-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
            <option value="">All companies</option>{COMPANIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
      </div>
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No holidays" text="Nothing is listed for this year." /> :
        <div className="table-wrap"><table><thead><tr><th>DATE</th><th>HOLIDAY</th><th>COMPANY</th><th>TYPE</th>{can(CALENDAR.manage) && <th />}</tr></thead>
          <tbody>{q.data.map((h) => <tr key={h.publicId}>
            <td>{dayLabel(h.date)}</td><td>{h.name}</td><td>{h.company}</td><td><Badge tone={h.isOptional ? 'amber' : 'gray'}>{h.isOptional ? 'optional' : 'holiday'}</Badge></td>
            {can(CALENDAR.manage) && <td className="row-actions"><button className="outline-btn danger" onClick={() => void remove(h)} aria-label={`Delete ${h.name}`}><Trash2 size={13} /> Delete</button></td>}</tr>)}</tbody></table></div>}
    </div>
    {adding && <AddHoliday onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.reload(); }} />}
  </Panel>;
}

function AddHoliday({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const parsed = CreateHolidayRequest.safeParse({ publicId: id, company: d.get('company'), date: d.get('date'), name: String(d.get('name') ?? '').trim(), isOptional: d.get('isOptional') === 'on' });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { await api('/hrms/holidays', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Add a holiday" onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Company<select id="addhol-company" name="company">{COMPANIES.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}</select></label>
        <label>Date<input id="addhol-date" name="date" type="date" required defaultValue={todayIst()} /></label>
        <label className="span-two">Name<input id="addhol-name" name="name" required minLength={2} maxLength={100} placeholder="e.g. Diwali" /></label>
        <label className="span-two check-row"><input name="isOptional" type="checkbox" /> Optional (restricted) holiday: a working day staff may take as leave</label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn" disabled={saving}>Add holiday</button></div>
    </form>
  </Modal>;
}

const ruleText = (r: WeeklyOffRule): string => {
  const every = r.weekdays.map((w) => WEEKDAYS[w]);
  const nth = r.nthWeekdays.map((n) => `${n.nth.map((x) => `${x}${['th', 'st', 'nd', 'rd'][x] ?? 'th'}`).join(' & ')} ${WEEKDAYS[n.weekday]}`);
  return [...(every.length ? [`Every ${every.join(', ')}`] : []), ...nth].join(' + ') || 'No weekly off';
};

function WeeklyOffs() {
  const [company, setCompany] = useState('AE');
  const [adding, setAdding] = useState(false);
  const q = useLoad(() => api<WeeklyOff[]>(`/hrms/weekly-offs?company=${company}`), [company]);
  return <Panel title="Weekly offs" note="A company default, or one person's own rule. A new rule ends the open one the day before it starts."
    action={<button className="primary-btn" onClick={() => setAdding(true)}><Plus size={16} /> Set weekly off</button>}>
    <div className="panel-body">
      <div className="filters"><label className="inline-field">Company
        <select id="off-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>{COMPANIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label></div>
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No weekly offs set" /> :
        <div className="table-wrap"><table><thead><tr><th>FOR</th><th>RULE</th><th>FROM</th><th>TO</th></tr></thead>
          <tbody>{q.data.map((w) => <tr key={w.publicId}>
            <td>{w.employment ? <><b>{w.employment.person.displayName}</b><small className="sub">{w.employment.employeeCode}</small></> : `${w.company} default`}</td>
            <td>{ruleText(w.rule)}</td><td>{dayLabel(w.validFrom)}</td><td>{w.validTo ? dayLabel(w.validTo) : 'Open'}</td></tr>)}</tbody></table></div>}
    </div>
    {adding && <SetWeeklyOff company={company} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); q.reload(); }} />}
  </Panel>;
}

function SetWeeklyOff({ company, onClose, onSaved }: { company: string; onClose: () => void; onSaved: () => void }) {
  const [id] = useState(uuidv7);
  const [days, setDays] = useState<number[]>([0]);
  const [satNth, setSatNth] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const flip = (list: number[], n: number) => (list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort());
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const to = String(d.get('to') ?? '');
    const satEvery = days.includes(6);
    const parsed = CreateWeeklyOffRequest.safeParse({
      publicId: id, company: d.get('company'), validFrom: d.get('from'), ...(to ? { validTo: to } : {}),
      rule: { weekdays: days, nthWeekdays: satNth.length && !satEvery ? [{ weekday: 6, nth: satNth }] : [] },
    });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setSaving(true); setError('');
    try { await api('/hrms/weekly-offs', { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Set a weekly off" subtitle="For the whole company. Leave every box empty for no weekly off." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label className="span-two">Company<select id="setoff-company" name="company" defaultValue={company}>{COMPANIES.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}</select></label>
        <fieldset className="span-two"><legend>Every week</legend><div className="chip-row">{WEEKDAYS.map((w, i) =>
          <label key={w} className="check-row"><input type="checkbox" checked={days.includes(i)} onChange={() => setDays(flip(days, i))} />{w}</label>)}</div></fieldset>
        <fieldset className="span-two"><legend>Some Saturdays only</legend><div className="chip-row">{[1, 2, 3, 4, 5].map((n) =>
          <label key={n} className="check-row"><input type="checkbox" disabled={days.includes(6)} checked={satNth.includes(n)} onChange={() => setSatNth(flip(satNth, n))} />{n}{['th', 'st', 'nd', 'rd'][n] ?? 'th'}</label>)}</div></fieldset>
        <label>From<input id="setoff-from" name="from" type="date" required defaultValue={todayIst()} /></label>
        <label>To <span className="optional">optional</span><input id="setoff-to" name="to" type="date" /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button className="primary-btn" disabled={saving}>Save</button></div>
    </form>
  </Modal>;
}
