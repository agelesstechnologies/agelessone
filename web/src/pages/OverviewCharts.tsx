import type { Dashboard } from '@ageless/shared';
import type { ReactNode } from 'react';
import { api } from '../api';
import { hm, useLoad } from '../hooks';
import { Empty, Loading, Notice, Panel } from '../ui';

/** Charts are drawn with plain SVG/CSS (no chart library). Colours follow the blue theme; status colours stay green / amber / red. */
const C = { present: '#2f9e6e', half: '#8bd0b0', leave: '#b47200', absent: '#d9534f', missed: '#e0a43a', off: '#c9d6ee' };

const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}%`);

function Kpi({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return <div className="kpi"><small>{label}</small><strong>{value}</strong>{hint && <span>{hint}</span>}</div>;
}

function Delta({ now, before }: { now: number | null; before: number | null }) {
  if (now == null || before == null) return null;
  const d = Math.round(now - before);
  return <span className={d >= 0 ? 'delta up' : 'delta down'}>{d >= 0 ? '▲' : '▼'} {Math.abs(d)} pts vs last month</span>;
}

/** One stacked bar per day: attended, leave, absent. */
function DailyBars({ daily }: { daily: Dashboard['attendance']['daily'] }) {
  const rows = daily.filter((d) => d.present + d.halfDay + d.leave + d.absent + d.missedPunch > 0);
  if (!rows.length) return <Empty title="No attendance yet this month" />;
  const max = Math.max(...rows.map((d) => d.present + d.halfDay + d.leave + d.absent + d.missedPunch), 1);
  const W = 560, H = 170, pad = 22, bw = Math.max(4, Math.min(22, (W - pad * 2) / rows.length - 3));
  const step = (W - pad * 2) / rows.length;
  return <svg viewBox={`0 0 ${W} ${H + 18}`} className="chart-svg" role="img" aria-label="Daily attendance for the month">
    <line x1={pad} x2={W - pad} y1={H} y2={H} stroke="#fff0d1" />
    {rows.map((d, i) => {
      const parts: [number, string][] = [[d.present, C.present], [d.halfDay, C.half], [d.leave, C.leave], [d.missedPunch, C.missed], [d.absent, C.absent]];
      let y = H;
      const x = pad + i * step + (step - bw) / 2;
      return <g key={d.date}>
        <title>{`${d.date}: ${d.present} present, ${d.halfDay} half day, ${d.leave} leave, ${d.missedPunch} missed punch, ${d.absent} absent`}</title>
        {parts.map(([v, color], k) => { if (!v) return null; const h = (v / max) * (H - 8); y -= h; return <rect key={k} x={x} y={y} width={bw} height={h} fill={color} rx={1} />; })}
        {(rows.length <= 16 || i % Math.ceil(rows.length / 12) === 0) && <text x={x + bw / 2} y={H + 13} textAnchor="middle" className="chart-tick">{d.date.slice(8)}</text>}
      </g>;
    })}
  </svg>;
}

function Legend({ items }: { items: [string, string][] }) {
  return <div className="legend">{items.map(([name, color]) => <span key={name}><i style={{ background: color }} />{name}</span>)}</div>;
}

/** Donut of the month's job-days by status. */
function Donut({ split }: { split: Dashboard['attendance']['split'] }) {
  const parts: [string, number, string][] = [
    ['Present', split.present, C.present], ['Half day', split.halfDay, C.half], ['Leave', split.leave, C.leave],
    ['Missed punch', split.missedPunch, C.missed], ['Absent', split.absent, C.absent],
  ];
  const total = parts.reduce((s, p) => s + p[1], 0);
  if (!total) return <Empty title="Nothing to show yet" />;
  const R = 52, CIRC = 2 * Math.PI * R;
  let offset = 0;
  return <div className="donut-wrap">
    <svg viewBox="0 0 140 140" className="donut" role="img" aria-label="Attendance split">
      <circle cx="70" cy="70" r={R} fill="none" stroke="#fff8ea" strokeWidth="20" />
      {parts.filter((p) => p[1] > 0).map(([name, v, color]) => {
        const len = (v / total) * CIRC;
        const el = <circle key={name} cx="70" cy="70" r={R} fill="none" stroke={color} strokeWidth="20"
          strokeDasharray={`${len} ${CIRC - len}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)"><title>{`${name}: ${v}`}</title></circle>;
        offset += len; return el;
      })}
      <text x="70" y="68" textAnchor="middle" className="donut-total">{total}</text>
      <text x="70" y="84" textAnchor="middle" className="chart-tick">job-days</text>
    </svg>
    <ul className="donut-list">{parts.map(([name, v, color]) => <li key={name}><i style={{ background: color }} />{name}<b>{v}</b></li>)}</ul>
  </div>;
}

/** Horizontal bars with a label and value each. */
function HBars({ rows, unit = '', max }: { rows: { label: string; value: number; text?: string }[]; unit?: string; max?: number }) {
  if (!rows.length) return <Empty title="Nothing to show yet" />;
  const top = max ?? Math.max(...rows.map((r) => r.value), 1);
  return <div className="hbars">{rows.map((r) => <div key={r.label} className="hbar">
    <span className="hbar-label" title={r.label}>{r.label}</span>
    <span className="hbar-track"><span style={{ width: `${Math.max(2, (r.value / top) * 100)}%` }} /></span>
    <b>{r.text ?? `${r.value}${unit}`}</b>
  </div>)}</div>;
}

/** Dashboard graphs for people who may see the HRMS dashboard (supervisor: own team; HR / Management: everyone). */
export function OverviewCharts() {
  const d = useLoad(() => api<Dashboard>('/hrms/dashboard'));
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <Notice>{d.error}</Notice>;
  const data = d.data;
  if (!data) return null;
  const cur = data.comparison.thisMonth, prev = data.comparison.lastMonth;
  return <>
    <div className="kpi-row">
      <Kpi label="EMPLOYEES" value={String(data.totals.employees)} hint={`${data.totals.joinersThisMonth} joined this month`} />
      <Kpi label="ON LEAVE TODAY" value={String(data.totals.onLeaveToday)} hint={`${data.leave.submitted} request${data.leave.submitted === 1 ? '' : 's'} waiting`} />
      <Kpi label="ATTENDANCE THIS MONTH" value={pct(cur.attendancePercent)} hint={<Delta now={cur.attendancePercent} before={prev.attendancePercent} />} />
      <Kpi label="WORKED · OVERTIME" value={hm(cur.workedMinutes)} hint={`${hm(cur.approvedOvertimeMinutes)} approved overtime`} />
    </div>
    <div className="chart-grid">
      <Panel title="Daily attendance" note={`${data.attendance.from} to ${data.attendance.to}`}>
        <div className="panel-body">
          <DailyBars daily={data.attendance.daily} />
          <Legend items={[['Present', C.present], ['Half day', C.half], ['Leave', C.leave], ['Missed punch', C.missed], ['Absent', C.absent]]} />
        </div>
      </Panel>
      <Panel title="Month split" note="Job-days by status"><div className="panel-body"><Donut split={data.attendance.split} /></div></Panel>
      <Panel title="Leave by type" note={`${data.leave.approved} approved · ${data.leave.leaveDays} days this month`}>
        <div className="panel-body"><HBars rows={data.leave.byType.map((t) => ({ label: t.name, value: t.requests }))} /></div>
      </Panel>
      <Panel title="Departments" note="Attendance % this month">
        <div className="panel-body"><HBars max={100} rows={data.departments.filter((x) => x.attendancePercent != null).map((x) => ({
          label: `${x.name} (${x.headcount})`, value: x.attendancePercent ?? 0, text: pct(x.attendancePercent) }))} /></div>
      </Panel>
    </div>
  </>;
}
