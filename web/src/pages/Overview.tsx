import { Activity, ArrowRight, BriefcaseBusiness, Users } from 'lucide-react';
import type { ExpenseClaim } from '@ageless/shared';
import type { ReactNode } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useLoad } from '../hooks';
import { ATTENDANCE, DASHBOARD, EXPENSES, PEOPLE } from '../permissions';
import { PageHead } from '../ui';
import { MyDay } from './Attendance';
import { OverviewCharts } from './OverviewCharts';

function Card({ icon, title, text, onClick }: { icon: ReactNode; title: string; text: string; onClick: () => void }) {
  return <button className="area-card" onClick={onClick}><span className="area-icon">{icon}</span><span><b>{title}</b><small>{text}</small></span><ArrowRight size={15} /></button>;
}

export default function Overview({ go }: { go: (page: string) => void }) {
  const { me, can, seesOthers } = useAuth();
  const punch = can(ATTENDANCE.punch);
  const approve = can(EXPENSES.approve);
  const waiting = useLoad(() => (approve ? api<ExpenseClaim[]>('/hrms/expenses/to-approve') : Promise.resolve(null)), [approve]);
  if (!me) return null;
  const roles = me.roles.map((r) => r.name).join(', ') || 'No role yet';

  return <>
    <PageHead eyebrow="OVERVIEW" title={`Hello, ${me.person.displayName}`} subtitle={`Signed in as ${roles}.`} />
    {punch && <MyDay />}
    {can(DASHBOARD.view) && <OverviewCharts />}
    <div className="area-grid">
      {punch && <Card icon={<Activity size={18} />} title="Attendance" text="History, corrections and overtime" onClick={() => go('attendance')} />}
      {!punch && can(ATTENDANCE.view) && <Card icon={<Activity size={18} />} title="Attendance" text="Team register and work hours" onClick={() => go('attendance')} />}
      {(can(EXPENSES.submit) || approve || can(EXPENSES.report)) && <Card icon={<BriefcaseBusiness size={18} />} title="Expenses"
        text={approve && waiting.data ? `${waiting.data.length} claim${waiting.data.length === 1 ? '' : 's'} waiting for you` : 'Claims and approvals'} onClick={() => go('expenses')} />}
      {seesOthers && can(PEOPLE.view) && <Card icon={<Users size={18} />} title="People" text="Directory, roles and employment" onClick={() => go('people')} />}
    </div>
  </>;
}

