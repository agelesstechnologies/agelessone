import type { IcAccess } from '@ageless/shared';
import { api } from '../../api';
import { useLoad } from '../../hooks';
import { Empty, Loading, Notice, PageHead, Panel, Tabs } from '../../ui';
import { AgreementList, AgreementPage } from './Agreements';
import { StatementList, StatementPage } from './Statements';
import { IcCards, IcReports } from './Reports';
import { goIc, useIcRoute } from './common';

type TabKey = 'statements' | 'agreements' | 'reports';

/**
 * Intercompany (#intercompany/...): what one company of the group bills another. Agreements and their rate cards
 * (#intercompany/agreements/<id>), monthly statements (#intercompany/statements/<id>), reports and, for the CEO, the cards.
 * Who sees what comes from GET /intercompany/access: company heads and approvers hold no permission, they are named.
 */
export default function Intercompany() {
  const access = useLoad(() => api<IcAccess>('/intercompany/access'));
  const [section, routeId] = useIcRoute();
  const a = access.data;
  if (!a) return <Panel title="Intercompany"><div className="panel-body">{access.error ? <Notice>{access.error}</Notice> : <Loading />}</div></Panel>;

  const seesAgreements = a.seesAll || a.agreements > 0;
  const tabs: { key: TabKey; label: string }[] = [
    ...(a.statements ? [{ key: 'statements' as const, label: 'Statements' }] : []),
    ...(seesAgreements ? [{ key: 'agreements' as const, label: 'Agreements' }, { key: 'reports' as const, label: 'Reports' }] : []),
  ];
  const tab: TabKey | undefined = tabs.find((t) => t.key === section)?.key ?? tabs[0]?.key;
  // a record id counts only under its own section (an approver opening an agreement link lands on the statements)
  const id = tab === section ? routeId : undefined;

  return <>
    <PageHead eyebrow="ACCOUNTS • INTERCOMPANY" title="Intercompany"
      subtitle="What ATPL bills AE (and the other way round): agreements, monthly statements, invoices and what is owed." />
    {a.seesAll && !id && <IcCards />}
    {!tab ? <Panel><div className="panel-body"><Empty title="Nothing for you here" text="Agreements name the company heads and approvers who see them." /></div></Panel> : <>
      {!id && <Tabs tabs={tabs} value={tab} onChange={(k) => goIc(k)} />}
      {tab === 'statements' && (id ? <StatementPage key={id} id={id} /> : <StatementList access={a} />)}
      {tab === 'agreements' && (id ? <AgreementPage key={id} id={id} /> : <AgreementList />)}
      {tab === 'reports' && <IcReports access={a} />}
    </>}
  </>;
}
