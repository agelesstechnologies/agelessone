import { useState } from 'react';
import type { AwaitingResponseReport, DesignHoursReport, DrawingsReport, QcByDisciplineReport, QcQueueReport } from '@ageless/shared';
import { hm, todayIst, useApi } from '../../hooks';
import { Badge, CsvButton, Empty, Loading, Notice, Panel, Tabs } from '../../ui';
import { disciplineName, goDesign, JOB_STATUS_LABEL, JOB_TONE, PURPOSE_LABEL, REV_LABEL, REV_TONE, stampIst } from './common';

type Kind = 'drawings' | 'qc-queue' | 'awaiting-response' | 'qc-by-discipline' | 'hours';
const KINDS: { key: Kind; label: string }[] = [
  { key: 'drawings', label: 'Drawings by status' }, { key: 'qc-queue', label: 'Waiting for QC' }, { key: 'awaiting-response', label: 'Awaiting the client' },
  { key: 'qc-by-discipline', label: 'QC pass / fail' }, { key: 'hours', label: 'Hours per job' },
];

/** Design reports of one company: on screen, CSV to download. */
export function DesignReports({ company }: { company: string }) {
  const [kind, setKind] = useState<Kind>('drawings');
  const [from, setFrom] = useState(`${todayIst().slice(0, 7)}-01`);
  const [to, setTo] = useState(todayIst());
  const [csvError, setCsvError] = useState('');
  const dated = kind === 'qc-by-discipline' || kind === 'hours';
  const params = new URLSearchParams({ company, ...(dated && { from, to }) }).toString();
  const path = `/design/reports/${kind}?${params}`;
  return <Panel title="Reports" note={kind === 'hours' ? 'Ticket time of each job\'s tickets between the dates (allocations plus the heads\' adjustments).'
    : kind === 'qc-by-discipline' ? 'QC decisions made between the dates (IST).' : 'As of now.'}>
    <div className="panel-body">
      <Tabs tabs={KINDS} value={kind} onChange={setKind} />
      <div className="filters">
        {dated && <>
          <label className="inline-field">From<input id="drp-from" type="date" className="input" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
          <label className="inline-field">To<input id="drp-to" type="date" className="input" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label></>}
        <CsvButton path={path} name={`design-${kind}-${company}.csv`} onError={setCsvError} />
      </div>
      {csvError && <Notice onClose={() => setCsvError('')}>{csvError}</Notice>}
      {kind === 'drawings' && <Drawings path={path} />}
      {kind === 'qc-queue' && <QcQueueRows path={path} />}
      {kind === 'awaiting-response' && <Awaiting path={path} />}
      {kind === 'qc-by-discipline' && <ByDiscipline path={path} />}
      {kind === 'hours' && <Hours path={path} />}
    </div>
  </Panel>;
}

function useReport<T>(path: string) { return useApi<T>(path); }
function State({ q }: { q: { loading: boolean; error: string; data: unknown } }) {
  if (q.error) return <Notice>{q.error}</Notice>;
  return q.loading && !q.data ? <Loading /> : null;
}

function Drawings({ path }: { path: string }) {
  const q = useReport<DrawingsReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  return <>
    <div className="chip-row">{Object.entries(r.byStatus).map(([s, n]) => <span key={s} className="ic-chip"><Badge tone={REV_TONE[s]}>{REV_LABEL[s] ?? s}</Badge> {n}</span>)}</div>
    {!r.rows.length ? <Empty title="No drawings" /> :
      <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>JOB</th><th>DRAWING</th><th>DISCIPLINE</th><th>REVISION</th><th>STATUS</th></tr></thead>
        <tbody>{r.rows.map((x) => <tr key={x.drawing.publicId} className="link-row" onClick={() => goDesign('drawings', x.drawing.publicId)}>
          <td><b>{x.job.number}</b><small className="sub">{x.customer}</small></td>
          <td>{x.drawing.number}<small className="sub">{x.drawing.title}</small></td>
          <td>{disciplineName(x.drawing.discipline)}</td>
          <td>{x.revision ? `Rev ${x.revision.code}` : '—'}</td>
          <td><Badge tone={REV_TONE[x.revision?.status ?? 'no_revision']}>{REV_LABEL[x.revision?.status ?? 'no_revision']}</Badge></td>
        </tr>)}</tbody></table></div>}
  </>;
}

function QcQueueRows({ path }: { path: string }) {
  const q = useReport<QcQueueReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  return !r.rows.length ? <Empty title="Nothing waiting for QC" /> :
    <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>DRAWING</th><th>REV</th><th>JOB</th><th>SUBMITTED</th><th>DAYS</th></tr></thead>
      <tbody>{r.rows.map((x) => <tr key={x.revision.publicId} className="link-row" onClick={() => goDesign('qc', x.revision.publicId)}>
        <td><b>{x.drawing.number}</b><small className="sub">{x.drawing.title}</small></td><td>{x.revision.code}</td><td>{x.job.number}</td>
        <td>{x.submittedBy.displayName}<small className="sub">{stampIst(x.submittedAt)}</small></td><td>{x.waitingDays}</td>
      </tr>)}</tbody></table></div>;
}

function Awaiting({ path }: { path: string }) {
  const q = useReport<AwaitingResponseReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  return !r.rows.length ? <Empty title="Nothing awaiting the client" /> :
    <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>DRAWING</th><th>REV</th><th>TRANSMITTAL</th><th>TO</th><th>ISSUED</th><th>DAYS</th></tr></thead>
      <tbody>{r.rows.map((x) => <tr key={x.revision.publicId} className="link-row" onClick={() => goDesign('transmittals', x.transmittal.publicId)}>
        <td><b>{x.drawing.number}</b><small className="sub">{x.job.number} · {x.drawing.title}</small></td><td>{x.revision.code}</td>
        <td>{x.transmittal.number}<small className="sub">{PURPOSE_LABEL[x.transmittal.purpose]}</small></td><td>{x.recipient}</td>
        <td>{stampIst(x.issuedAt)}</td><td>{x.waitingDays > 7 ? <Badge tone="red">{x.waitingDays}</Badge> : x.waitingDays}</td>
      </tr>)}</tbody></table></div>;
}

function ByDiscipline({ path }: { path: string }) {
  const q = useReport<QcByDisciplineReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  return !r.rows.length ? <Empty title="No QC decisions in these dates" /> :
    <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>DISCIPLINE</th><th>REVIEWS</th><th>APPROVED</th><th>CHANGES NEEDED</th><th>PASS</th></tr></thead>
      <tbody>{r.rows.map((x) => <tr key={x.discipline}>
        <td><b>{x.discipline}</b><small className="sub">{disciplineName(x.discipline)}</small></td><td>{x.reviews}</td><td>{x.approved}</td><td>{x.changesNeeded}</td>
        <td><div className="dz-bar"><i style={{ width: `${x.passPercent}%` }} /></div>{x.passPercent}%</td>
      </tr>)}</tbody></table></div>;
}

function Hours({ path }: { path: string }) {
  const q = useReport<DesignHoursReport>(path);
  const r = q.data;
  if (!r) return <State q={q} />;
  return <>
    <div className="chip-row"><span className="ic-chip"><b>Total</b> {hm(r.totalMinutes)}</span></div>
    {!r.rows.length ? <Empty title="No design jobs" /> :
      <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>JOB</th><th>CLIENT</th><th>STATUS</th><th>TICKETS</th><th>HOURS</th></tr></thead>
        <tbody>{r.rows.map((x) => <tr key={x.job.publicId} className="link-row" onClick={() => goDesign('jobs', x.job.publicId)}>
          <td><b>{x.job.number}</b></td><td>{x.customer}</td><td><Badge tone={JOB_TONE[x.status]}>{JOB_STATUS_LABEL[x.status]}</Badge></td>
          <td>{x.tickets}</td><td>{hm(x.minutes)}</td>
        </tr>)}</tbody></table></div>}
  </>;
}
