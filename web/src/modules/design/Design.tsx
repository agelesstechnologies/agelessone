import { useState } from 'react';
import type { DesignAccessInfo } from '@ageless/shared';
import { useApi } from '../../hooks';
import { Empty, Loading, Notice, PageHead, Panel, Tabs } from '../../ui';
import { goDesign, useDesignRoute, viewedCompanies } from './common';
import { JobList, JobPage } from './Jobs';
import { DrawingPage, DrawingRegister } from './Drawings';
import { QcQueue, ReviewScreen } from './Qc';
import { TransmittalList, TransmittalPage } from './Transmittals';
import { DesignReports } from './Reports';

type TabKey = 'jobs' | 'drawings' | 'qc' | 'transmittals' | 'reports';

/**
 * Design (#design/...): ATPL's design jobs from clients, the drawing register, QC, transmittals and reports. Lists are
 * tabs; a record opens on its own address (#design/jobs/<id>, #design/drawings/<id>, #design/qc/<revision id>,
 * #design/transmittals/<id>) for whoever may see it (the API decides). Who sees which tabs comes from GET /design/access:
 * the Designing head and the job's ticket assignees hold no permission.
 */
export default function Design() {
  const access = useApi<DesignAccessInfo>('/design/access');
  const [section, id] = useDesignRoute();
  const [picked, setPicked] = useState('');
  const a = access.data;
  if (!a) return <Panel title="Design"><div className="panel-body">{access.error ? <Notice>{access.error}</Notice> : <Loading />}</div></Panel>;

  const companies = viewedCompanies(a);
  const company = companies.find((c) => c.company === picked)?.company ?? companies[0]?.company;
  const views = companies.some((c) => c.view);
  const reviews = companies.some((c) => c.qc);
  const tabs: { key: TabKey; label: string }[] = [
    { key: 'jobs', label: 'Jobs' },
    ...(views ? [{ key: 'drawings' as const, label: 'Drawing register' }] : []),
    ...(reviews ? [{ key: 'qc' as const, label: 'QC' }] : []),
    { key: 'transmittals', label: 'Transmittals' },
    ...(views ? [{ key: 'reports' as const, label: 'Reports' }] : []),
  ];
  const head = <PageHead eyebrow="OPERATIONS • DESIGN" title="Design" subtitle="Design jobs from clients: drawings and revisions, QC, transmittals and the client's response."
    action={companies.length > 1 ? <label className="month-pick">Company <select value={company} onChange={(e) => setPicked(e.target.value)}>
      {companies.map((c) => <option key={c.company} value={c.company}>{c.name}</option>)}</select></label> : undefined} />;

  // one record, opened from a list or a link
  if (id) {
    return <>{head}
      {section === 'jobs' && <JobPage key={id} id={id} access={a} />}
      {section === 'drawings' && <DrawingPage key={id} id={id} />}
      {section === 'qc' && <ReviewScreen key={id} revisionId={id} />}
      {section === 'transmittals' && <TransmittalPage key={id} id={id} access={a} />}
    </>;
  }

  if (!companies.length && a.assignedJobs === 0) {
    return <>{head}<Panel><div className="panel-body"><Empty title="Nothing for you here"
      text="Design jobs are run by the Designing head and Admin users, reviewed by Design QC and worked on by the people assigned to their tickets." /></div></Panel></>;
  }
  const tab = tabs.find((t) => t.key === section)?.key ?? 'jobs';
  return <>{head}
    <Tabs tabs={tabs} value={tab} onChange={(k) => goDesign(k)} />
    {tab === 'jobs' && <JobList access={a} />}
    {tab === 'drawings' && company && <DrawingRegister company={company} />}
    {tab === 'qc' && company && <QcQueue company={company} />}
    {tab === 'transmittals' && <TransmittalList company={company} />}
    {tab === 'reports' && company && <DesignReports company={company} />}
  </>;
}
