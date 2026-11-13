import { useState } from 'react';
import type {
  IcAccess, IcBalanceReport, IcBilledReport, IcDashboard, IcDisputesReport, IcMarginReport, IcReceiverCostReport, IcUnbilledReport,
} from '@ageless/shared';
import { api } from '../../api';
import { dayLabel, hm, rupees, todayIst, useLoad } from '../../hooks';
import { Kpi } from '../../pages/OverviewCharts';
import { openTicket } from '../../pages/Tickets';
import { Badge, CsvButton, Empty, Loading, Notice, Panel, Tabs } from '../../ui';
import { COMPANIES, goIc, lastMonth, monthName, SERVICE_LABEL, STATEMENT_LABEL, STATEMENT_TONE } from './common';

type Kind = 'billed' | 'unbilled' | 'disputes' | 'receiver-cost' | 'balance' | 'margin';
const project = (p: { kind: string; publicId: string } | null) => (p ? `${p.kind === 'project' ? 'Project' : 'Design request'} ${p.publicId.slice(0, 8)}` : '—');
/** YYYY-MM, `n` months before `ym`. */
const monthsBack = (ym: string, n: number) => {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Intercompany reports: JSON on screen, CSV to download. Rows of the agreements the person sees; margin for the CEO only. */
export function IcReports({ access }: { access: IcAccess }) {
  const kinds: { key: Kind; label: string }[] = [
    { key: 'billed', label: 'Billed' }, { key: 'unbilled', label: 'Unbilled hours' }, { key: 'disputes', label: 'Disputes' },
    { key: 'receiver-cost', label: 'Receiver\'s cost' }, { key: 'balance', label: 'Balance' },
    ...(access.seesAll ? [{ key: 'margin' as const, label: 'Margin (CEO)' }] : []),
  ];
  const [kind, setKind] = useState<Kind>('billed');
  const [to, setTo] = useState(lastMonth(todayIst()));
  const [from, setFrom] = useState(monthsBack(lastMonth(todayIst()), 2));
  const [company, setCompany] = useState('');
  const [csvError, setCsvError] = useState('');
  const ranged = kind !== 'balance';
  const params = new URLSearchParams({ ...(ranged && { from, to }), ...(company && { company }) }).toString();
  const path = `/intercompany/reports/${kind}${params ? `?${params}` : ''}`;
  return <Panel title="Reports" note="Statements past draft. Amounts in rupees; CSV opens in Excel.">
    <div className="panel-body">
      <Tabs tabs={kinds} value={kind} onChange={setKind} />
      <div className="filters">
        {ranged && <>
          <label className="inline-field">From<input id="icr-from" type="month" className="input" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
          <label className="inline-field">To<input id="icr-to" type="month" className="input" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label></>}
        <label className="inline-field">Company<select id="icr-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
          <option value="">Both</option>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <CsvButton path={path} name={`intercompany-${kind}.csv`} onError={setCsvError} />
      </div>
      {csvError && <Notice onClose={() => setCsvError('')}>{csvError}</Notice>}
      {kind === 'billed' && <Billed path={path} />}
      {kind === 'unbilled' && <Unbilled path={path} />}
      {kind === 'disputes' && <Disputes path={path} />}
      {kind === 'receiver-cost' && <ReceiverCost path={path} />}
      {kind === 'balance' && <Balance path={path} />}
      {kind === 'margin' && <Margin path={path} />}
    </div>
  </Panel>;
}

function useReport<T>(path: string) { return useLoad(() => api<T>(path), [path]); }
function State({ q }: { q: { loading: boolean; error: string; data: unknown } }) {
  if (q.error) return <Notice>{q.error}</Notice>;
  return q.loading && !q.data ? <Loading /> : null;
}

function Billed({ path }: { path: string }) {
  const q = useReport<IcBilledReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  if (!r.rows.length) return <Empty title="Nothing billed in these months" />;
  return <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>MONTH</th><th>COMPANIES</th><th>LINE</th><th>PROJECT</th><th>HOURS × RATE</th><th>AMOUNT</th></tr></thead>
    <tbody>{r.rows.map((x, i) => <tr key={i} className="link-row" onClick={() => goIc('statements', x.statementPublicId)}>
      <td>{monthName(x.month)}<small className="sub"><Badge tone={STATEMENT_TONE[x.status] ?? 'gray'}>{STATEMENT_LABEL[x.status]}</Badge></small></td>
      <td>{x.provider} → {x.receiver}</td>
      <td>{x.kind === 'labour' ? `${SERVICE_LABEL[x.serviceType ?? ''] ?? ''} · ${x.person ?? ''}${x.grade ? ` (${x.grade})` : ''}` : x.kind === 'passed_cost' ? 'Cost passed on' : 'Credit'}</td>
      <td>{project(x.project)}</td>
      <td>{x.minutes !== null && x.rateMinor !== null ? `${hm(x.minutes)} × ${rupees(x.rateMinor)}/h` : '—'}</td>
      <td><b>{rupees(x.amountMinor)}</b></td></tr>)}
      <tr className="ic-total"><td>Total</td><td /><td /><td /><td>{hm(r.totalMinutes)}</td><td>{rupees(r.totalMinor)}</td></tr></tbody></table></div>;
}

function Unbilled({ path }: { path: string }) {
  const q = useReport<IcUnbilledReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  if (!r.rows.length) return <Empty title="No unbilled billable hours" text="Every month with billable ticket time is billed." />;
  return <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>MONTH</th><th>COMPANIES</th><th>TICKET</th><th>PERSON</th><th>SERVICE</th><th>HOURS</th></tr></thead>
    <tbody>{r.rows.map((x, i) => <tr key={i} className="link-row" onClick={() => openTicket(x.ticket.publicId)}>
      <td>{monthName(x.month)}</td><td>{x.provider} → {x.receiver}</td>
      <td>{x.ticket.number}<small className="sub">{x.ticket.title}</small></td><td>{x.person.displayName}</td>
      <td>{SERVICE_LABEL[x.serviceType ?? ''] ?? '—'}<small className="sub">{project(x.project)}</small></td><td><b>{hm(x.minutes)}</b></td></tr>)}
      <tr className="ic-total"><td>Total</td><td /><td /><td /><td /><td>{hm(r.totalMinutes)}</td></tr></tbody></table></div>;
}

function Disputes({ path }: { path: string }) {
  const q = useReport<IcDisputesReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  if (!r.rows.length) return <Empty title="No disputes in these months" />;
  return <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>MONTH</th><th>LINE</th><th>DISPUTE</th><th>ANSWER</th><th>AMOUNT</th></tr></thead>
    <tbody>{r.rows.map((x) => <tr key={x.linePublicId} className="link-row" onClick={() => goIc('statements', x.statementPublicId)}>
      <td>{monthName(x.month)}<small className="sub">{x.provider} → {x.receiver}</small></td><td>{x.description}</td>
      <td>{x.reason}<small className="sub">{x.disputedBy.displayName}, {dayLabel(x.disputedAt.slice(0, 10))}</small></td>
      <td>{x.resolution ? <>{x.resolution}: {x.resolutionReason}<small className="sub">{x.resolvedBy?.displayName}</small></> : <Badge tone="red">waiting</Badge>}</td>
      <td>{rupees(x.amountMinor)}{x.originalAmountMinor !== null && x.originalAmountMinor !== x.amountMinor && <small className="sub ic-was">was {rupees(x.originalAmountMinor)}</small>}</td></tr>)}</tbody></table></div>;
}

function ReceiverCost({ path }: { path: string }) {
  const q = useReport<IcReceiverCostReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  if (!r.rows.length) return <Empty title="Nothing billed in these months" />;
  return <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>RECEIVER</th><th>PROJECT</th><th>HOURS</th><th>LABOUR</th><th>COSTS PASSED ON</th><th>CREDITS</th><th>TOTAL</th></tr></thead>
    <tbody>{r.rows.map((x, i) => <tr key={i}>
      <td>{x.receiver}<small className="sub">from {x.provider}</small></td><td>{project(x.project)}</td><td>{hm(x.minutes)}</td>
      <td>{rupees(x.labourMinor)}</td><td>{rupees(x.passedCostsMinor)}</td><td>{rupees(x.creditsMinor)}</td><td><b>{rupees(x.totalMinor)}</b></td></tr>)}
      <tr className="ic-total"><td>Total</td><td /><td /><td /><td /><td /><td>{rupees(r.totalMinor)}</td></tr></tbody></table></div>;
}

/** Invoices not yet paid: due dates, days overdue, and what each receiver owes each provider. */
function Balance({ path }: { path: string }) {
  const q = useReport<IcBalanceReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  return <>
    <div className="kpi-row">
      <Kpi label="OWED IN ALL" value={rupees(r.totalMinor)} hint={`as of ${dayLabel(r.asOf)}`} />
      {r.pairs.map((p) => <Kpi key={`${p.provider}${p.receiver}`} label={`${p.receiver} OWES ${p.provider}`} value={rupees(p.amountMinor)}
        hint={p.overdueMinor ? `${rupees(p.overdueMinor)} overdue` : 'nothing overdue'} />)}
    </div>
    {!r.rows.length ? <Empty title="Nothing owed" text="Every invoice is paid." /> :
      <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>INVOICE</th><th>COMPANIES</th><th>MONTH</th><th>DUE</th><th>AMOUNT</th></tr></thead>
        <tbody>{r.rows.map((x) => <tr key={x.statementPublicId} className="link-row" onClick={() => goIc('statements', x.statementPublicId)}>
          <td><b>{x.invoiceNumber}</b><small className="sub">{dayLabel(x.invoicedOn)}</small></td><td>{x.receiver} owes {x.provider}</td><td>{monthName(x.month)}</td>
          <td>{dayLabel(x.dueOn)}{x.overdueDays > 0 && <small className="sub"><Badge tone="red">{x.overdueDays} days overdue</Badge></small>}</td>
          <td><b>{rupees(x.amountMinor)}</b></td></tr>)}
          <tr className="ic-total"><td>Total</td><td /><td /><td /><td>{rupees(r.totalMinor)}</td></tr></tbody></table></div>}
  </>;
}

function Margin({ path }: { path: string }) {
  const q = useReport<IcMarginReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  if (!r.rows.length) return <Empty title="Nothing billed in these months" />;
  return <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>MONTH</th><th>COMPANIES</th><th>BILLED</th><th>COST</th><th>MARGIN</th></tr></thead>
    <tbody>{r.rows.map((x) => <tr key={x.statementPublicId} className="link-row" onClick={() => goIc('statements', x.statementPublicId)}>
      <td>{monthName(x.month)}</td><td>{x.provider} → {x.receiver}</td><td>{rupees(x.billedMinor)}</td>
      <td>{rupees(x.costMinor)}{x.costMissing && <small className="sub"><Badge tone="amber">someone has no salary</Badge></small>}</td>
      <td><b>{rupees(x.marginMinor)}</b>{x.marginPercent !== null && <small className="sub">{x.marginPercent}%</small>}</td></tr>)}
      <tr className="ic-total"><td>Total</td><td /><td>{rupees(r.billedMinor)}</td><td>{rupees(r.costMinor)}</td><td>{rupees(r.marginMinor)}</td></tr></tbody></table></div>;
}

/** The CEO's intercompany cards: billed this month, unbilled hours, intercompany balance. */
export function IcCards() {
  const q = useLoad(() => api<IcDashboard>('/intercompany/dashboard'));
  const d = q.data;
  if (!d) return q.error ? <Notice>{q.error}</Notice> : <Loading />;
  return <div className="kpi-row">
    <Kpi label={`BILLED · ${monthName(d.month).toUpperCase()}`} value={rupees(d.billedThisMonthMinor)} hint="Statements sent this month" />
    <Kpi label="UNBILLED HOURS" value={hm(d.unbilledMinutes)} hint="Billable ticket time in months not billed yet" />
    <Kpi label="INTERCOMPANY BALANCE" value={rupees(d.balanceMinor)}
      hint={d.balances.length ? d.balances.map((b) => `${b.receiver} owes ${b.provider} ${rupees(b.amountMinor)}`).join(' · ') : 'Every invoice is paid'} />
  </div>;
}
