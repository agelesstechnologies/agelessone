import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Activity, Award, BriefcaseBusiness, Building2, Network, CalendarDays, CalendarRange, ChevronDown, CircleHelp, ClipboardCheck, LayoutDashboard, LoaderCircle, Lock, LogOut, Menu, SlidersHorizontal, Users, Wallet, X } from 'lucide-react';
import { AuthProvider, useAuth } from './auth';
import { ATTENDANCE, EXPENSES, LEAVE, PAYROLL, PEOPLE, POLICIES, SKILLS } from './permissions';
import Approvals from './pages/Approvals';
import Attendance from './pages/Attendance';
import Calendar from './pages/Calendar';
import Expenses from './pages/Expenses';
import Leave from './pages/Leave';
import Login from './pages/Login';
import MonthLocks from './pages/MonthLocks';
import Organisation from './pages/Organisation';
import Overview from './pages/Overview';
import Payroll from './pages/Payroll';
import People from './pages/People';
import Policies from './pages/Policies';
import Skills from './pages/Skills';
import { Modal } from './ui';

type PageKey = 'overview' | 'people' | 'attendance' | 'expenses' | 'leave' | 'calendar' | 'approvals' | 'payroll' | 'skills' | 'organisation' | 'locks' | 'policies';
interface NavItem { key: PageKey; label: string; icon: ReactNode; section: 'workspace' | 'manage'; show: (can: (p: string) => boolean, others: boolean) => boolean }

/** Every menu item lists the permission that shows it; the backend still checks each request. */
const NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} />, section: 'workspace', show: () => true },
  { key: 'people', label: 'People', icon: <Users size={18} />, section: 'workspace', show: (_can, others) => others },
  { key: 'attendance', label: 'Attendance', icon: <Activity size={18} />, section: 'workspace', show: (can) => can(ATTENDANCE.punch) || can(ATTENDANCE.view) || can(ATTENDANCE.approve) },
  { key: 'expenses', label: 'Expenses', icon: <BriefcaseBusiness size={18} />, section: 'workspace', show: (can) => can(EXPENSES.submit) || can(EXPENSES.approve) || can(EXPENSES.report) },
  { key: 'leave', label: 'Leave', icon: <CalendarDays size={18} />, section: 'workspace', show: (can) => can(LEAVE.apply) || can(LEAVE.approve) || can(LEAVE.report) },
  { key: 'calendar', label: 'Calendar', icon: <CalendarRange size={18} />, section: 'workspace', show: (can) => can(PEOPLE.view) },
  { key: 'approvals', label: 'Approvals', icon: <ClipboardCheck size={18} />, section: 'workspace', show: (can) => can(LEAVE.approve) || can(EXPENSES.approve) || can(ATTENDANCE.approve) },
  { key: 'payroll', label: 'Payroll', icon: <Wallet size={18} />, section: 'workspace', show: (can) => can(PAYROLL.payslip) || can(PAYROLL.prepare) || can(PAYROLL.approve) },
  { key: 'skills', label: 'Skills', icon: <Award size={18} />, section: 'workspace', show: (can) => can(SKILLS.view) || can(SKILLS.manage) },
  { key: 'organisation', label: 'Organisation', icon: <Network size={18} />, section: 'workspace', show: (can, others) => others && (can(PEOPLE.manageEmployments) || can(PEOPLE.managePositions) || can(PEOPLE.view)) },
  { key: 'locks', label: 'Month locks', icon: <Lock size={18} />, section: 'manage', show: (can) => can(ATTENDANCE.lockMonth) || can(ATTENDANCE.unlockMonth) },
  { key: 'policies', label: 'Policies', icon: <SlidersHorizontal size={18} />, section: 'manage', show: (can) => can(POLICIES.manage) },
];

const pageFromHash = (): PageKey => {
  const h = window.location.hash.replace('#', '');
  return NAV.some((n) => n.key === h) ? (h as PageKey) : 'overview';
};

function Shell() {
  const { me, can, logout, seesOthers } = useAuth();
  const [page, setPage] = useState<PageKey>(pageFromHash);
  const [mobileNav, setMobileNav] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const go = useCallback((p: string) => { window.location.hash = p; setMobileNav(false); }, []);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (!me) return null;

  const items = NAV.filter((n) => n.show(can, seesOthers));
  // A page the person may not open (typed in the address bar) falls back to the overview.
  const current = items.find((n) => n.key === page) ?? items[0]!;
  const role = me.roles[0]?.name ?? 'No role';
  const initials = me.person.displayName.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  const link = (n: NavItem) => <a key={n.key} href={`#${n.key}`} className={`${n.key === current.key ? 'active' : ''} `} onClick={() => setMobileNav(false)}>
    {n.icon}{n.label}</a>;

  return <div className="app-shell">
    {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'show' : ''}`}>
      <div className="brand"><div className="brand-mark">a<span>.</span></div><div><b>ageless</b><small>PEOPLE PLATFORM</small></div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Close menu"><X size={18} /></button></div>
      <div className="workspace"><div className="workspace-icon"><Building2 size={18} /></div><div><b>Ageless Group</b><small>Organization</small></div><ChevronDown size={15} /></div>
      <div className="nav-label">WORKSPACE</div><nav>{items.filter((n) => n.section === 'workspace').map(link)}</nav>
      <div className="nav-label manage-label">MANAGE</div><nav>{items.filter((n) => n.section === 'manage').map(link)}</nav>
      <div className="sidebar-bottom">
        <div className="help-card"><div className="help-icon"><CircleHelp size={18} /></div><div><b>Need a hand?</b><small>Visit the help center</small></div></div>
        <div className="profile"><div className="avatar avatar-blue">{initials}</div><div><b>{me.person.displayName}</b><small>{role}</small></div>
          <button className="icon-button" onClick={() => setConfirmOut(true)} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar"><button className="icon-button hamburger" onClick={() => setMobileNav(!mobileNav)} aria-label="Open menu"><Menu size={20} /></button>
        {/* <div className="crumb"><b>{current.label}</b></div> */}
        <div className="top-actions"><span className="env"><i />Development</span><div className="avatar avatar-blue top-avatar">{initials}</div></div></header>
      <div className="content">
        {current.key === 'overview' && <Overview go={go} />}
        {current.key === 'people' && <People />}
        {current.key === 'attendance' && <Attendance />}
        {current.key === 'expenses' && <Expenses />}
        {current.key === 'leave' && <Leave />}
        {current.key === 'calendar' && <Calendar />}
        {current.key === 'approvals' && <Approvals />}
        {current.key === 'payroll' && <Payroll />}
        {current.key === 'skills' && <Skills />}
        {current.key === 'organisation' && <Organisation />}
        {current.key === 'locks' && <MonthLocks />}
        {current.key === 'policies' && <Policies />}
        <footer className="footer"><span>© 2026 Ageless Universe</span><span>Built for the people who make it happen <span className="heart">♥</span></span><span>v0.1.0</span></footer>
      </div>
    </main>
    {confirmOut && <Modal title="Sign out?" subtitle="You will need to sign in again to continue." onClose={() => setConfirmOut(false)}>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={() => setConfirmOut(false)} autoFocus>Stay signed in</button>
        <button type="button" className="primary-btn" onClick={() => { setConfirmOut(false); logout(); }}>Sign out</button></div>
    </Modal>}
  </div>;
}

function Gate() {
  const { me, loading } = useAuth();
  if (loading) return <div className="boot"><LoaderCircle className="spin" size={22} />Loading…</div>;
  return me ? <Shell /> : <Login />;
}

export default function App() {
  return <AuthProvider><Gate /></AuthProvider>;
}
