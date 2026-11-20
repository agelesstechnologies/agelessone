import type { Dashboard } from '@ageless/shared';
import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { hm, useLoad } from '../hooks';
import { Empty, Loading, Notice, Panel } from '../ui';

/** Charts are drawn with plain SVG/CSS (no chart library). Colours follow the blue theme; status colours stay green / amber / red. */
const C = { present: '#2f9e6e', half: '#8bd0b0', leave: '#b47200', absent: '#d9534f', missed: '#e0a43a', off: '#c9d6ee' };

const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}%`);

export function Kpi({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return <div className="kpi"><small>{label}</small><strong>{value}</strong>{hint && <span>{hint}</span>}</div>;
}

function Delta({ now, before }: { now: number | null; before: number | null }) {
  if (now == null || before == null) return null;
  const d = Math.round(now - before);
  return <span className={d >= 0 ? 'delta up' : 'delta down'}>{d >= 0 ? '▲' : '▼'} {Math.abs(d)} pts vs last month</span>;
}

/** Glowing orange bars on a black panel: people attended per day, with a rising trend arrow over the bar tops. */
function DailyBars({ daily }: { daily: Dashboard['attendance']['daily'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = daily.filter((d) => d.present + d.halfDay + d.leave + d.absent + d.missedPunch > 0);
  if (!rows.length) return <Empty title="No attendance yet this month" />;
  const W = 800, H = 210, L = 12, R = 24, T = 28, B = 24;
  const attended = (d: (typeof rows)[number]) => d.present + d.halfDay;
  const total = (d: (typeof rows)[number]) => d.present + d.halfDay + d.leave + d.absent + d.missedPunch;
  const max = Math.max(...rows.map(total), 1);
  const slot = (W - L - R) / rows.length;
  const bw = Math.min(44, slot * 0.7);
  const cx = (i: number) => L + slot * (i + 0.5);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const every = rows.length <= 16 ? 1 : Math.ceil(rows.length / 12);
  const pts = rows.map((d, i) => [cx(i), y(total(d)) - 8] as [number, number]);
  const last = pts[pts.length - 1], prev = pts[Math.max(0, pts.length - 2)];
  const ang = (Math.atan2(last[1] - prev[1], last[0] - prev[0]) * 180) / Math.PI;
  const zig = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join(' ');
  const grid = [0.25, 0.5, 0.75, 1];
  const h = hover == null ? null : rows[hover];
  return <div className="areachart" role="img" aria-label="Daily attendance for the month">
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
      <defs>
        <linearGradient id="barg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ffc94d" /><stop offset="100%" stopColor="#d68c00" /></linearGradient>
        <linearGradient id="trendg" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#ffd98a" /><stop offset="100%" stopColor="#d68c00" /></linearGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {grid.map((g) => <line key={g} x1={L} x2={W - R} y1={y(max * g)} y2={y(max * g)} stroke="#e2e8f0" />)}
      {rows.map((d, i) => <line key={d.date} x1={cx(i)} x2={cx(i)} y1={T} y2={H - B} stroke="#f1f5f9" />)}
      <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="#cbd5e1" />
      {rows.map((d, i) => {
        const bh = H - B - y(total(d)), ah = Math.min(bh, H - B - y(attended(d)));
        const on = hover == null || hover === i;
        return <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} opacity={on ? 1 : 0.55}>
          <rect x={cx(i) - slot / 2} y={T - 20} width={slot} height={H - T - B + 20} fill="transparent" />
          <rect x={cx(i) - bw / 2} y={H - B - bh} width={bw} height={Math.max(4, bh)} rx="4" fill="#f5a100" fillOpacity="0.16" stroke="#f5a100" strokeOpacity="0.4" />
          <rect x={cx(i) - bw / 2} y={H - B - ah} width={bw} height={Math.max(4, ah)} rx="4" fill="url(#barg)" filter="url(#glow)" />
        </g>;
      })}
      <g pointerEvents="none" strokeLinejoin="round" strokeLinecap="round" fill="none">
        <path d={zig} stroke="#ff9a1f" strokeWidth="10" opacity="0.45" filter="url(#glow)" />
        <path d={zig} stroke="#ff9a1f" strokeWidth="4" />
        <path d={zig} stroke="#ffe2b0" strokeWidth="1.4" />
      </g>
      <polygon points="0,0 -18,-10 -13,0 -18,10" transform={`translate(${last[0] + 8},${last[1]}) rotate(${ang}) scale(1.1)`} fill="#ff9a1f" stroke="#ffe2b0" strokeWidth="1" filter="url(#glow)" pointerEvents="none" />
      {rows.map((d, i) => i % every === 0 ? <text key={d.date} x={cx(i)} y={H - 8} textAnchor="middle" className="chart-tick">{Number(d.date.slice(8))}</text> : null)}
    </svg>
    {hover != null && h && <div className="chart-tip" style={{ left: `${(cx(hover) / W) * 100}%`, transform: `translateX(${hover > rows.length / 2 ? '-105%' : '5%'})` }}>
      <b>{h.date}</b>
      {[['Present', C.present, h.present], ['Half day', C.half, h.halfDay], ['Leave', C.leave, h.leave], ['Missed punch', C.missed, h.missedPunch], ['Absent', C.absent, h.absent]].map(([n, c, v]) =>
        <span key={n as string}><i style={{ background: c as string }} />{n}<em>{v}</em></span>)}
    </div>}
  </div>;
}

function Legend({ items }: { items: [string, string][] }) {
  return <div className="legend">{items.map(([name, color]) => <span key={name}><i style={{ background: color }} />{name}</span>)}</div>;
}

/** Donut of the month's job-days by status. */
function Donut({ split }: { split: Dashboard['attendance']['split'] }) {
  const parts: [string, number, string][] = [
    ['Present', split.present, '#f5a100'], ['Half day', split.halfDay, '#ffd98a'], ['Leave', split.leave, '#a86a00'],
    ['Missed punch', split.missedPunch, '#64748b'], ['Absent', split.absent, '#b3261e'],
  ];
  const total = parts.reduce((s, p) => s + p[1], 0);
  if (!total) return <Empty title="Nothing to show yet" />;
  const R = 52, CIRC = 2 * Math.PI * R;
  let offset = 0;
  return <div className="donut-wrap">
    <svg viewBox="0 0 140 140" className="donut" role="img" aria-label="Attendance split">
      <circle cx="70" cy="70" r={R} fill="none" stroke="#fff6e0" strokeWidth="16" />
      {parts.filter((p) => p[1] > 0).map(([name, v, color]) => {
        const len = (v / total) * CIRC;
        const el = <circle key={name} cx="70" cy="70" r={R} fill="none" stroke={color} strokeWidth="16"
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
export function HBars({ rows, unit = '', max }: { rows: { label: string; value: number; text?: string }[]; unit?: string; max?: number }) {
  if (!rows.length) return <Empty title="Nothing to show yet" />;
  const top = max ?? Math.max(...rows.map((r) => r.value), 1);
  return <div className="hbars">{rows.map((r) => <div key={r.label} className="hbar">
    <span className="hbar-label" title={r.label}>{r.label}</span>
    <span className="hbar-track"><span style={{ width: `${Math.max(2, (r.value / top) * 100)}%` }} /></span>
    <b>{r.text ?? `${r.value}${unit}`}</b>
  </div>)}</div>;
}

/** Dashboard graphs for people who may see the HRMS dashboard (manager: own team; HR / Management: everyone). */
export function OverviewCharts({ company, month }: { company?: string; month?: string } = {}) {
  const query = new URLSearchParams({ ...(company ? { company } : {}), ...(month ? { month } : {}) }).toString();
  const d = useLoad(() => api<Dashboard>(`/hrms/dashboard${query ? `?${query}` : ''}`), [query]);
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
          <Legend items={[['Attended (solid)', '#f5a100'], ['Everyone else (light)', '#fbd990']]} />
        </div>
      </Panel>
      <Panel title="Month split" note="Job-days by status"><div className="panel-body"><Donut split={data.attendance.split} /></div></Panel>
      <Panel title="Leave by type" note={`${data.leave.approved} approved · ${data.leave.leaveDays} days this month`}>
        <div className="panel-body"><HBars rows={data.leave.byType.map((t) => ({ label: t.name, value: t.requests }))} /></div>
      </Panel>
      <Panel title="Departments" note="Attendance % this month">
        <div className="panel-body"><HBars max={100} rows={data.departments.filter((x) => x.attendancePercent != null).map((x) => ({
          // with several companies, say which one ("No department · AE" twice would look like a mistake)
          label: `${x.name}${new Set(data.departments.map((y) => y.company)).size > 1 ? ` · ${x.company}` : ''} (${x.headcount})`,
          value: x.attendancePercent ?? 0, text: pct(x.attendancePercent) }))} /></div>
      </Panel>
    </div>
  </>;
}
