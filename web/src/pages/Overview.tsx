import { Activity, ArrowRight, BriefcaseBusiness, ShieldCheck, Users } from 'lucide-react';
import type { ExpenseClaim, TodayAttendance } from '@ageless/shared';
import type { ReactNode } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { hm, timeIst, useLoad } from '../hooks';
import { ATTENDANCE, EXPENSES, PEOPLE } from '../permissions';
import { PageHead } from '../ui';

function Card({ icon, title, text, onClick }: { icon: ReactNode; title: string; text: string; onClick: () => void }) {
  return <button className="area-card" onClick={onClick}><span className="area-icon">{icon}</span><span><b>{title}</b><small>{text}</small></span><ArrowRight size={15} /></button>;
}

export default function Overview({ go }: { go: (page: string) => void }) {
  const { me, can } = useAuth();
  const punch = can(ATTENDANCE.punch);
  const approve = can(EXPENSES.approve);
  const today = useLoad(() => (punch ? api<TodayAttendance>('/hrms/attendance/today') : Promise.resolve(null)), [punch]);
  const waiting = useLoad(() => (approve ? api<ExpenseClaim[]>('/hrms/expenses/to-approve') : Promise.resolve(null)), [approve]);
  if (!me) return null;
  const t = today.data;
  const roles = me.roles.map((r) => r.name).join(', ') || 'No role yet';

  return <>
    <PageHead eyebrow="WORKSPACE • OVERVIEW" title={`Hello, ${me.person.displayName}`} subtitle={`Signed in as ${roles}.`} />
    <div className="area-grid">
      {punch && <Card icon={<Activity size={18} />} title="Attendance"
        text={t ? (t.punchedIn ? `Working since ${timeIst(t.since)}` : t.workedMinutes ? `${hm(t.workedMinutes)} worked today` : 'Not punched in yet') : 'Punch in and out'} onClick={() => go('attendance')} />}
      {!punch && can(ATTENDANCE.view) && <Card icon={<Activity size={18} />} title="Attendance" text="Team register and work hours" onClick={() => go('attendance')} />}
      {(can(EXPENSES.submit) || approve || can(EXPENSES.report)) && <Card icon={<BriefcaseBusiness size={18} />} title="Expenses"
        text={approve && waiting.data ? `${waiting.data.length} claim${waiting.data.length === 1 ? '' : 's'} waiting for you` : 'Claims and approvals'} onClick={() => go('expenses')} />}
      {can(PEOPLE.view) && <Card icon={<Users size={18} />} title="People" text="Directory, roles and employment" onClick={() => go('people')} />}
      <Card icon={<ShieldCheck size={18} />} title="Roles & access" text="See what your roles allow" onClick={() => go('access')} />
    </div>
  </>;
}
