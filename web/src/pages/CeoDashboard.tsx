import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { ApprovalItem, ApprovalsInbox, PayrollRunSummary, TicketDashboard } from '@ageless/shared';
import { api, errText } from '../api';
import { dayLabel, hm, rupees, todayIst, useLoad } from '../hooks';
import { Badge, Empty, Loading, Notice, PageHead, Panel, type Tone } from '../ui';
import { AskReason, BASE, LABEL, SentToCeo, TONE } from './Approvals';
import { HBars, Kpi, OverviewCharts } from './OverviewCharts';
import { STATUS_TONE, statusLabel } from './TicketDetail';
import { openTicket } from './Tickets';
import OverdueAlerts from './OverdueAlerts';
import { IcCards } from '../modules/intercompany/Reports';

/**
 * The CEO's dashboard for one company. First version: Ageless Technologies only. When the other companies come,
 * replace COMPANY with a company picker; every section already takes the company code.
 */
const COMPANY = { code: 'ATPL', name: 'Ageless Technologies' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
/** The six months ending with `ym` (YYYY-MM), oldest first. */
function lastSixMonths(ym: string): string[] {
  const [y, m] = ym.split('-').map(Number);
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (5 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}
const hours = (h: number | null) => (h == null ? '—' : h < 48 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} days`);
const RUN_TONE: Record<string, Tone> = { draft: 'amber', approved: 'blue', paid: 'green' };

export default function CeoDashboard() {
  const [month, setMonth] = useState(todayIst().slice(0, 7));
  return <>
    <PageHead eyebrow="CEO DASHBOARD" title={COMPANY.name} subtitle="People, payroll, tickets and the decisions waiting for you."
      action={<label className="month-pick">Month <input type="month" value={month} max={todayIst().slice(0, 7)}
        onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>} />
    <WaitingForYou company={COMPANY.code} />
    <OverdueAlerts company={COMPANY.code} title="Overdue tickets sent to you" showEmpty
      note="Unfinished tickets overdue for a few days (after their department head was alerted). Open one to act on it." />
    <h2 className="section-title">People &amp; attendance</h2>
    <OverviewCharts company={COMPANY.code} month={month} />
    <h2 className="section-title">Payroll</h2>
    <PayrollSection company={COMPANY.code} month={month} />
    <h2 className="section-title">Tickets</h2>
    <TicketsSection company={COMPANY.code} month={month} />
    <h2 className="section-title">Intercompany <a className="text-btn" href="#intercompany">Open</a></h2>
    <IcCards />
  </>;
}

/** Requests sent to the CEO (forwarded, or waiting too long), with approve / reject; and how many are pending overall. */
function WaitingForYou({ company }: { company: string }) {
  const sent = useLoad(() => api<ApprovalsInbox>(`/hrms/approvals/mine?escalated=true&company=${company}`), [company]);
  const all = useLoad(() => api<ApprovalsInbox>(`/hrms/approvals/mine?company=${company}`), [company]);
  const [rejecting, setRejecting] = useState<ApprovalItem | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const reload = () => { sent.reload(); all.reload(); };
  async function approve(i: ApprovalItem) {
    setBusy(i.publicId); setError('');
    try { await api(`${BASE[i.type]}/${i.publicId}/approve`, { method: 'POST', json: {} }); reload(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(''); }
  }
  const items = sent.data?.items ?? [];
  const pending = all.data?.counts.total;
  return <Panel title="Waiting for you" note={pending == null ? undefined : `${items.length} sent to you · ${pending} pending in ${company} overall (see Approvals)`}>
    <div className="panel-body">
      {(sent.error || error) && <Notice onClose={() => setError('')}>{sent.error || error}</Notice>}
      {sent.loading && !sent.data ? <Loading /> : !items.length ? <Empty title="Nothing sent to you" text="Requests forwarded to you, or waiting too long, appear here." /> :
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>TYPE</th><th>PERSON</th><th>DETAILS</th><th>WHEN</th><th>WAITING</th><th /></tr></thead>
          <tbody>{items.map((i) => <tr key={`${i.type}-${i.publicId}`}>
            <td><Badge tone={TONE[i.type]}>{LABEL[i.type]}</Badge></td>
            <td>{i.person.displayName}</td>
            <td>{i.summary}{i.amountPaise !== null && <small className="sub">{rupees(i.amountPaise)}</small>}<SentToCeo item={i} /></td>
            <td>{i.fromDate ? dayLabel(i.fromDate) : '—'}{i.toDate && i.toDate !== i.fromDate ? ` – ${dayLabel(i.toDate)}` : ''}</td>
            <td>{i.ageDays === 0 ? 'Today' : `${i.ageDays}d`}</td>
            <td><div className="row-actions">
              <button className="primary-btn" disabled={busy === i.publicId} onClick={() => approve(i)}><Check size={13} /> Approve</button>
              <button className="danger-btn" disabled={busy === i.publicId} onClick={() => setRejecting(i)}><X size={13} /> Reject</button></div></td>
          </tr>)}</tbody></table></div>}
    </div>
    {rejecting && <AskReason item={rejecting} action="reject" onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); reload(); }} />}
  </Panel>;
}

/** The month's payroll run (status, people, net pay) and net pay over the last six months. */
function PayrollSection({ company, month }: { company: string; month: string }) {
  const months = lastSixMonths(month);
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  const runs = useLoad(async () => (await Promise.all(years.map((y) => api<PayrollRunSummary[]>(`/payroll/runs?company=${company}&year=${y}`)))).flat(), [company, month]);
  if (runs.loading && !runs.data) return <Loading />;
  if (runs.error) return <Notice>{runs.error}</Notice>;
  const runOf = (ym: string) => runs.data?.find((r) => r.year === Number(ym.slice(0, 4)) && r.month === Number(ym.slice(5, 7)));
  const run = runOf(month);
  return <>
    <div className="kpi-row">
      <Kpi label={`PAYROLL · ${monthLabel(month).toUpperCase()}`} value={run ? run.status[0].toUpperCase() + run.status.slice(1) : 'Not prepared'}
        hint={run ? <Badge tone={RUN_TONE[run.status] ?? 'gray'}>{run.approvedBy ? `Approved by ${run.approvedBy.displayName}` : `Prepared by ${run.preparedBy.displayName}`}</Badge> : 'No run for this month yet'} />
      <Kpi label="PEOPLE PAID" value={run ? String(run.totals.people) : '—'} />
      <Kpi label="NET PAY" value={run ? rupees(run.totals.netPaise) : '—'} hint={run ? `${rupees(run.totals.additionsPaise)} additions · ${rupees(run.totals.deductionsPaise)} deductions` : undefined} />
    </div>
    <Panel title="Net pay, last six months" note="From the monthly payroll runs">
      <div className="panel-body"><HBars rows={months.map((m) => {
        const r = runOf(m);
        return { label: monthLabel(m), value: r ? r.totals.netPaise : 0, text: r ? `${rupees(r.totals.netPaise)} · ${r.status}` : 'no run' };
      })} /></div>
    </Panel>
  </>;
}

/** Open tickets, overdue, completed this month vs last, how long completed tickets took, and the oldest open ones. */
function TicketsSection({ company, month }: { company: string; month: string }) {
  const d = useLoad(() => api<TicketDashboard>(`/tickets/dashboard?company=${company}&month=${month}`), [company, month]);
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <Notice>{d.error}</Notice>;
  const t = d.data;
  if (!t) return null;
  const c = t.completion;
  const change = t.completedThisMonth - t.completedLastMonth;
  return <>
    <div className="kpi-row">
      <Kpi label="OPEN TICKETS" value={String(t.open)} hint={`${t.overdue} overdue`} />
      <Kpi label={`COMPLETED · ${monthLabel(t.month).toUpperCase()}`} value={String(t.completedThisMonth)}
        hint={<span className={change >= 0 ? 'delta up' : 'delta down'}>{change >= 0 ? '▲' : '▼'} {Math.abs(change)} vs {monthLabel(t.lastMonth)}</span>} />
      <Kpi label="AVERAGE TIME TO COMPLETE" value={hours(c.avgHours)} hint={c.medianHours == null ? 'Nothing completed this month' : `Median ${hours(c.medianHours)}`} />
      <Kpi label="AVERAGE WORK PER TICKET" value={c.avgWorkedMinutes == null ? '—' : hm(c.avgWorkedMinutes)} hint="Time logged on the ticket" />
    </div>
    <div className="chart-grid">
      <Panel title="Oldest open tickets" note="Not completed or cancelled, oldest first">
        <div className="panel-body">{!t.oldestOpen.length ? <Empty title="No open tickets" /> :
          <div className="table-wrap"><table><thead><tr><th>TICKET</th><th>TYPE</th><th>STATUS</th><th>PRIORITY</th><th>AGE</th><th>DUE</th></tr></thead>
            <tbody>{t.oldestOpen.map((o) => <tr key={o.ticket.publicId} className="link-row" onClick={() => openTicket(o.ticket.publicId)}>
              <td>{o.ticket.number}<small className="sub">{o.ticket.title}</small></td>
              <td>{o.type.name}</td>
              <td><Badge tone={STATUS_TONE[o.status]}>{statusLabel(o.status)}</Badge></td>
              <td>P{o.priority}</td>
              <td>{o.ageDays === 0 ? 'Today' : `${o.ageDays}d`}</td>
              <td>{o.dueDate ? <>{dayLabel(o.dueDate)}{o.overdue && <> <Badge tone="red">Overdue</Badge></>}</> : '—'}</td>
            </tr>)}</tbody></table></div>}
        </div>
      </Panel>
      <Panel title="Open by type"><div className="panel-body"><HBars rows={t.openByType.map((x) => ({ label: x.type.name, value: x.count }))} /></div></Panel>
      <Panel title="Time to complete by type" note={`Completed in ${monthLabel(t.month)} · average`}>
        <div className="panel-body"><HBars rows={c.byType.map((x) => ({ label: `${x.type.name} (${x.completed})`, value: x.avgHours ?? 0, text: hours(x.avgHours) }))} /></div>
      </Panel>
    </div>
  </>;
}
