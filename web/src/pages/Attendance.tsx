import { useEffect, useRef, useState } from 'react';
import { Clock, LogIn, LogOut } from 'lucide-react';
import {
  PunchRequest, type AttendanceRegister, type HistoryRow, type RebuildResult, type TodayAttendance, type WorkHours,
} from '@ageless/shared';
import { api, errText } from '../api';
import { useAuth } from '../auth';
import { addDays, dayLabel, hm, timeIst, todayIst, useLoad, useMyEmployments, uuidv7, words } from '../hooks';
import { ATTENDANCE } from '../permissions';
import { Badge, DAY_TONE, Empty, Loading, Notice, PageHead, Panel, Tabs, CsvButton } from '../ui';
import { CorrectionModal, MyRequests, OvertimeModal, RequestApprovals } from './AttendanceRequests';

type TabKey = 'today' | 'history' | 'requests' | 'approve' | 'register' | 'hours';

export default function Attendance() {
  const { can } = useAuth();
  const tabs: { key: TabKey; label: string }[] = [
    ...(can(ATTENDANCE.punch) ? [{ key: 'today' as const, label: 'My day' }, { key: 'history' as const, label: 'My history' }, { key: 'requests' as const, label: 'My requests' }] : []),
    ...(can(ATTENDANCE.approve) ? [{ key: 'approve' as const, label: 'To approve' }] : []),
    ...(can(ATTENDANCE.view) ? [{ key: 'register' as const, label: 'Team register' }, { key: 'hours' as const, label: 'Work hours' }] : []),
  ];
  const [tab, setTab] = useState<TabKey>(tabs[0]?.key ?? 'today');
  return <>
    <PageHead eyebrow="HRMS • ATTENDANCE" title="Attendance" subtitle="Daily punch, work hours history, corrections, overtime and the team register." />
    <Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'today' && <MyDay />}
    {tab === 'history' && <MyHistory />}
    {tab === 'requests' && <MyRequests />}
    {tab === 'approve' && <RequestApprovals />}
    {tab === 'register' && <Register />}
    {tab === 'hours' && <Hours />}
  </>;
}

/** Device location is optional: a punch is accepted without it. */
function position(): Promise<{ latitude?: number; longitude?: number; accuracyM?: number }> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({}); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      () => resolve({}),
      { timeout: 4000, maximumAge: 60_000 },
    );
  });
}

export function MyDay() {
  const { jobs, error: jobsError } = useMyEmployments();
  const today = useLoad(() => api<TodayAttendance>('/hrms/attendance/today'));
  const [jobId, setJobId] = useState('');
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState('');
  const [error, setError] = useState('');
  const pending = useRef<string | null>(null); // same id on a retry, so a double click or resend is stored once

  useEffect(() => { if (!jobId && jobs[0]) setJobId((jobs.find((j) => j.isPrimary) ?? jobs[0]).publicId); }, [jobs, jobId]);
  useEffect(() => { const t = setInterval(today.reload, 60_000); return () => clearInterval(t); }, [today.reload]);

  const t = today.data;
  async function punch() {
    if (!t) return;
    const kind = t.punchedIn ? 'out' : 'in';
    const employmentPublicId = t.punchedIn && t.employment ? t.employment.publicId : jobId;
    setBusy(true); setError(''); setOk('');
    try {
      pending.current ??= uuidv7();
      const parsed = PunchRequest.safeParse({ publicId: pending.current, employmentPublicId, kind, occurredAt: new Date().toISOString(), ...(await position()) });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check the punch');
      await api('/hrms/attendance/punches', { method: 'POST', json: parsed.data });
      pending.current = null;
      setOk(kind === 'in' ? 'You are punched in.' : 'You are punched out.');
      today.reload();
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  return <Panel title="Today" note={t ? dayLabel(t.date) : undefined}>
    <div className="panel-body">
      {(error || jobsError || today.error) && <Notice onClose={() => setError('')}>{error || jobsError || today.error}</Notice>}
      {ok && <Notice tone="ok" onClose={() => setOk('')}>{ok}</Notice>}
      {today.loading && !t ? <Loading /> : t && <div className="punch-card">
        <div className="punch-state">
          <Clock size={22} />
          <div><b>{t.punchedIn ? 'Working' : 'Not punched in'}</b>
            <small>{t.punchedIn ? `Since ${timeIst(t.since)}${t.employment ? ` · ${t.employment.company}` : ''}` : 'Punch in to start your day'}</small></div>
        </div>
        <div className="punch-worked"><small>WORKED TODAY</small><strong>{hm(t.workedMinutes)}</strong></div>
        {!t.punchedIn && jobs.length > 1 && <label className="inline-field">Job
          <select id="punch-job" className="input" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            {jobs.map((j) => <option key={j.publicId} value={j.publicId}>{j.company.code} · {j.employeeCode}</option>)}</select></label>}
        <button className="primary-btn big" disabled={busy || (!t.punchedIn && !jobId)} onClick={() => void punch()}>
          {t.punchedIn ? <LogOut size={16} /> : <LogIn size={16} />}{t.punchedIn ? 'Punch out' : 'Punch in'}</button>
      </div>}
    </div>
  </Panel>;
}

function RangeFilter({ from, to, setFrom, setTo, children }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; children?: React.ReactNode }) {
  return <div className="filters">
    <label className="inline-field">From<input id="from" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
    <label className="inline-field">To<input id="to" type="date" className="input" value={to} min={from} max={todayIst()} onChange={(e) => setTo(e.target.value)} /></label>
    {children}
  </div>;
}

const CompanySelect = ({ value, onChange }: { value: string; onChange: (v: string) => void }) =>
  <label className="inline-field">Company
    <select id="company" className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All companies</option><option value="AE">Ageless Entertainments</option><option value="ATPL">Ageless Technologies</option></select></label>;

function MyHistory() {
  const [to, setTo] = useState(todayIst());
  const [from, setFrom] = useState(addDays(todayIst(), -13));
  const [fixing, setFixing] = useState<HistoryRow | null>(null);
  const [overtime, setOvertime] = useState<HistoryRow | null>(null);
  const [ok, setOk] = useState('');
  const q = useLoad(() => api<HistoryRow[]>(`/hrms/attendance/history?from=${from}&to=${to}`), [from, to]);
  return <Panel title="Work Hours History" note="Your own days, newest first. Fix a punch or ask for overtime on any day.">
    <div className="panel-body">
      <RangeFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />
      {ok && <Notice tone="ok" onClose={() => setOk('')}>{ok}</Notice>}
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading ? <Loading /> : !q.data?.length ? <Empty title="No days in this range" text="Pick other dates." /> :
        <div className="table-wrap"><table><thead><tr><th>DATE</th><th>COMPANY</th><th>FIRST IN</th><th>LAST OUT</th><th>WORKED</th><th>EXTRA</th><th>OVERTIME</th><th>STATUS</th><th /></tr></thead>
          <tbody>{q.data.map((r) => <tr key={`${r.date}-${r.employment.publicId}`}>
            <td>{dayLabel(r.date)}</td><td>{r.employment.company}</td><td>{timeIst(r.firstIn)}</td><td>{r.running ? 'Working…' : timeIst(r.lastOut)}</td>
            <td>{hm(r.workedMinutes)}</td><td>{r.extraMinutes ? hm(r.extraMinutes) : '—'}</td><td>{r.approvedOvertimeMinutes ? hm(r.approvedOvertimeMinutes) : '—'}</td>
            <td><Badge tone={DAY_TONE[r.status] ?? 'gray'}>{words(r.status)}</Badge></td>
            <td className="row-actions">
              {!r.locked && !r.running && <button className="outline-btn" onClick={() => setFixing(r)}>Fix punch</button>}
              {r.extraMinutes > r.approvedOvertimeMinutes && <button className="outline-btn" onClick={() => setOvertime(r)}>Request overtime</button>}</td></tr>)}</tbody></table></div>}
    </div>
    {fixing && <CorrectionModal day={fixing} onClose={() => setFixing(null)} onSaved={() => { setFixing(null); setOk('Correction sent for approval. Track it in My requests.'); q.reload(); }} />}
    {overtime && <OvertimeModal day={overtime} onClose={() => setOvertime(null)} onSaved={() => { setOvertime(null); setOk('Overtime request sent. Track it in My requests.'); q.reload(); }} />}
  </Panel>;
}

function Register() {
  const [date, setDate] = useState(todayIst());
  const [company, setCompany] = useState('');
  const q = useLoad(() => api<AttendanceRegister>(`/hrms/attendance/register?date=${date}${company ? `&company=${company}` : ''}`), [date, company]);
  return <Panel title="Team register" note="Everyone you can see, for one day.">
    <div className="panel-body">
      <div className="filters">
        <label className="inline-field">Date<input id="reg-date" type="date" className="input" value={date} max={todayIst()} onChange={(e) => setDate(e.target.value)} /></label>
        <CompanySelect value={company} onChange={setCompany} />
      </div>
      {q.data && <div className="chip-row">{Object.entries(q.data.summary).map(([s, n]) => <Badge key={s} tone={DAY_TONE[s] ?? 'gray'}>{words(s)} · {n}</Badge>)}</div>}
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading ? <Loading /> : !q.data?.rows.length ? <Empty title="Nobody to show" text="No attendance rows for this day." /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>COMPANY</th><th>FIRST IN</th><th>LAST OUT</th><th>WORKED</th><th>STATUS</th></tr></thead>
          <tbody>{q.data.rows.map((r) => <tr key={r.employment.publicId}>
            <td><b>{r.person.displayName}</b><small className="sub">{r.employment.employeeCode}</small></td><td>{r.employment.company}</td>
            <td>{timeIst(r.firstIn)}</td><td>{r.running ? 'Working…' : timeIst(r.lastOut)}</td><td>{hm(r.workedMinutes)}</td>
            <td><Badge tone={DAY_TONE[r.status] ?? 'gray'}>{words(r.status)}</Badge></td></tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}

function Hours() {
  const { can } = useAuth();
  const [to, setTo] = useState(todayIst());
  const [from, setFrom] = useState(addDays(todayIst(), -29));
  const [company, setCompany] = useState('');
  const [ok, setOk] = useState('');
  const [error, setError] = useState('');
  const q = useLoad(() => api<WorkHours>(`/hrms/attendance/work-hours?from=${from}&to=${to}${company ? `&company=${company}` : ''}`), [from, to, company]);

  async function rebuild(employmentPublicId: string) {
    setError(''); setOk('');
    try {
      const r = await api<RebuildResult>('/hrms/attendance/rebuild', { method: 'POST', json: { employmentPublicId, from, to } });
      setOk(`Recalculated ${r.rebuilt} days${r.skippedLocked ? `, ${r.skippedLocked} locked days skipped` : ''}.`);
      q.reload();
    } catch (e) { setError(errText(e)); }
  }

  return <Panel title="Work hours" note="Days and hours per person over a date range (up to 93 days).">
    <div className="panel-body">
      <RangeFilter from={from} to={to} setFrom={setFrom} setTo={setTo}><CompanySelect value={company} onChange={setCompany} />
        <CsvButton path={`/hrms/attendance/work-hours?from=${from}&to=${to}${company ? `&company=${company}` : ''}`} name="work-hours.csv" onError={setError} /></RangeFilter>
      {(q.error || error) && <Notice onClose={() => setError('')}>{q.error || error}</Notice>}
      {ok && <Notice tone="ok" onClose={() => setOk('')}>{ok}</Notice>}
      {q.loading ? <Loading /> : !q.data?.rows.length ? <Empty title="No work hours" text="Nothing recorded in this range." /> :
        <div className="table-wrap"><table><thead><tr><th>PERSON</th><th>COMPANY</th><th>PRESENT</th><th>HALF DAY</th><th>MISSED PUNCH</th><th>ABSENT</th><th>WORKED</th><th>EXTRA</th><th>OVERTIME</th>{can(ATTENDANCE.rebuild) && <th />}</tr></thead>
          <tbody>{q.data.rows.map((r) => <tr key={r.employment.publicId}>
            <td><b>{r.person.displayName}</b><small className="sub">{r.employment.employeeCode}</small></td><td>{r.employment.company}</td>
            <td>{r.days.present}</td><td>{r.days.halfDay}</td><td>{r.days.missedPunch}</td><td>{r.days.absent}</td>
            <td>{hm(r.workedMinutes)}</td><td>{r.extraMinutes ? hm(r.extraMinutes) : '—'}</td><td>{r.approvedOvertimeMinutes ? hm(r.approvedOvertimeMinutes) : '—'}</td>
            {can(ATTENDANCE.rebuild) && <td><button className="text-btn" onClick={() => void rebuild(r.employment.publicId)}>Recalculate</button></td>}</tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}
