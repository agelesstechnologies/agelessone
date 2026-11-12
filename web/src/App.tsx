import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Activity, Award, Ticket, BriefcaseBusiness, Building2, Network, CalendarDays, CalendarRange, ChevronDown, CircleHelp, ClipboardCheck, Crown, KeyRound, LayoutDashboard, LoaderCircle, Lock, LogOut, Menu, SlidersHorizontal, Users, Wallet, Wrench, X } from 'lucide-react';
import { AuthProvider, useAuth } from './auth';
import { ATTENDANCE, EXPENSES, LEAVE, MANAGEMENT, PAYROLL, PEOPLE, POLICIES, SKILLS, TICKETS, TICKET_TYPES } from './permissions';
import Approvals from './pages/Approvals';
import Attendance from './pages/Attendance';
import CeoDashboard from './pages/CeoDashboard';
import Calendar from './pages/Calendar';
import Expenses from './pages/Expenses';
import Leave from './pages/Leave';
import Login from './pages/Login';
import FirstLogin from './pages/FirstLogin';
import MonthLocks from './pages/MonthLocks';
import Organisation from './pages/Organisation';
import Overview from './pages/Overview';
import Payroll from './pages/Payroll';
import People from './pages/People';
import Policies from './pages/Policies';
import Skills from './pages/Skills';
import Tickets from './pages/Tickets';
import ChangePassword from './ChangePassword';
import { Modal } from './ui';

type PageKey = 'overview' | 'ceo' | 'people' | 'attendance' | 'expenses' | 'leave' | 'calendar' | 'approvals' | 'payroll' | 'skills' | 'tickets' | 'organisation' | 'locks' | 'policies';
type GroupKey = 'hrms' | 'accounts' | 'operations';
interface NavItem { key: PageKey; label: string; icon: ReactNode; section: 'workspace' | GroupKey | 'manage'; show: (can: (p: string) => boolean, others: boolean, scopeOf: (p: string) => string | null) => boolean }

/** Every menu item lists the permission that shows it; the backend still checks each request. */
const NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} />, section: 'workspace', show: () => true },
  { key: 'ceo', label: 'CEO dashboard', icon: <Crown size={18} />, section: 'workspace', show: (_can, _others, scopeOf) => scopeOf(MANAGEMENT) === 'all' },
  { key: 'people', label: 'People', icon: <Users size={18} />, section: 'hrms', show: (_can, others) => others },
  { key: 'attendance', label: 'Attendance', icon: <Activity size={18} />, section: 'hrms', show: (can) => can(ATTENDANCE.punch) || can(ATTENDANCE.view) || can(ATTENDANCE.approve) },
  { key: 'expenses', label: 'Expenses', icon: <BriefcaseBusiness size={18} />, section: 'accounts', show: (can) => can(EXPENSES.submit) || can(EXPENSES.approve) || can(EXPENSES.report) },
  { key: 'leave', label: 'Leave', icon: <CalendarDays size={18} />, section: 'hrms', show: (can) => can(LEAVE.apply) || can(LEAVE.approve) || can(LEAVE.report) },
  { key: 'calendar', label: 'Calendar', icon: <CalendarRange size={18} />, section: 'hrms', show: (can) => can(PEOPLE.view) },
  { key: 'approvals', label: 'Approvals', icon: <ClipboardCheck size={18} />, section: 'workspace', show: (can) => can(LEAVE.approve) || can(EXPENSES.approve) || can(ATTENDANCE.approve) },
  { key: 'payroll', label: 'Payroll', icon: <Wallet size={18} />, section: 'accounts', show: (can) => can(PAYROLL.payslip) || can(PAYROLL.prepare) || can(PAYROLL.approve) },
  { key: 'skills', label: 'Skills', icon: <Award size={18} />, section: 'hrms', show: (can) => can(SKILLS.view) || can(SKILLS.manage) },
  { key: 'tickets', label: 'Tickets', icon: <Ticket size={18} />, section: 'operations', show: (can) => can(TICKETS.view) || can(TICKETS.work) || can(TICKETS.manage) || can(TICKET_TYPES.view) || can(TICKETS.numbering) },
  { key: 'organisation', label: 'Organisation', icon: <Network size={18} />, section: 'workspace', show: (can, others) => others && (can(PEOPLE.manageEmployments) || can(PEOPLE.managePositions) || can(PEOPLE.view)) },
  { key: 'locks', label: 'Month locks', icon: <Lock size={18} />, section: 'manage', show: (can) => can(ATTENDANCE.lockMonth) || can(ATTENDANCE.unlockMonth) },
  { key: 'policies', label: 'Policies', icon: <SlidersHorizontal size={18} />, section: 'manage', show: (can) => can(POLICIES.manage) },
];

/** Drop-down groups in the menu, in this order after Overview and the CEO dashboard. */
const GROUPS: { key: GroupKey; label: string; icon: ReactNode }[] = [
  { key: 'hrms', label: 'HRMS', icon: <Users size={18} /> },
  { key: 'accounts', label: 'Accounts', icon: <Wallet size={18} /> },
  { key: 'operations', label: 'Operations', icon: <Wrench size={18} /> },
];
/** Which menu groups were left open (per browser). */
const GROUPS_OPEN_KEY = 'ageless.nav.groups';
const readOpenGroups = (): Partial<Record<GroupKey, boolean>> => {
  try { return JSON.parse(localStorage.getItem(GROUPS_OPEN_KEY) ?? '{}') as Partial<Record<GroupKey, boolean>>; } catch { return {}; }
};

const pageFromHash = (): PageKey => {
  const h = window.location.hash.replace('#', '').split('/')[0] ?? '';   // #tickets/<id> is the Tickets page
  return NAV.some((n) => n.key === h) ? (h as PageKey) : 'overview';
};

function Shell() {
  const { me, can, scopeOf, logout, seesOthers } = useAuth();
  const [page, setPage] = useState<PageKey>(pageFromHash);
  const [mobileNav, setMobileNav] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [openGroups, setOpenGroups] = useState(readOpenGroups);
  const go = useCallback((p: string) => { window.location.hash = p; setMobileNav(false); }, []);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (!me) return null;

  const items = NAV.filter((n) => n.show(can, seesOthers, scopeOf));
  // A page the person may not open (typed in the address bar) falls back to the overview.
  const current = items.find((n) => n.key === page) ?? items[0]!;
  const role = me.roles[0]?.name ?? 'No role';
  const initials = me.person.displayName.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  const link = (n: NavItem) => <a key={n.key} href={`#${n.key}`} className={`${n.key === current.key ? 'active' : ''} `} onClick={() => setMobileNav(false)}>
    {n.icon}{n.label}</a>;
  /** A drop-down group: always open while one of its pages is shown; otherwise as the person left it. */
  const group = (g: (typeof GROUPS)[number]) => {
    const pages = items.filter((n) => n.section === g.key);
    if (!pages.length) return null;
    const holdsCurrent = current.section === g.key;
    const shown = holdsCurrent || !!openGroups[g.key];
    const toggle = () => {
      if (holdsCurrent) return;
      const next = { ...openGroups, [g.key]: !shown };
      setOpenGroups(next);
      try { localStorage.setItem(GROUPS_OPEN_KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
    };
    return <div key={g.key} className="nav-group-wrap">
      <button type="button" className={`nav-group ${holdsCurrent ? 'has-active' : ''}`} aria-expanded={shown} onClick={toggle}>
        {g.icon}{g.label}<ChevronDown size={15} className={`nav-chevron ${shown ? 'open' : ''}`} /></button>
      {shown && <div className="nav-sub">{pages.map(link)}</div>}
    </div>;
  };
  const workspace = items.filter((n) => n.section === 'workspace');
  const before = workspace.filter((n) => n.key === 'overview' || n.key === 'ceo');
  const after = workspace.filter((n) => n.key !== 'overview' && n.key !== 'ceo');

  return <div className="app-shell">
    {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'show' : ''}`}>
      <div className="brand"><div className="brand-mark">a<span>.</span></div><div><b>ageless</b><small>PEOPLE PLATFORM</small></div><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Close menu"><X size={18} /></button></div>
      <div className="workspace"><div className="workspace-icon"><Building2 size={18} /></div><div><b>Ageless Group</b><small>Organization</small></div><ChevronDown size={15} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>
        {before.map(link)}
        {GROUPS.map(group)}
        {after.map(link)}
      </nav>
      {items.some((n) => n.section === 'manage') && <><div className="nav-label manage-label">MANAGE</div><nav>{items.filter((n) => n.section === 'manage').map(link)}</nav></>}
      <div className="sidebar-bottom">
        <div className="help-card"><div className="help-icon"><CircleHelp size={18} /></div><div><b>Need a hand?</b><small>Visit the help center</small></div></div>
        <div className="profile"><div className="avatar avatar-blue">{initials}</div><div><b>{me.person.displayName}</b><small>{role}</small></div>
          <button className="icon-button" onClick={() => setChangingPassword(true)} aria-label="Change password" title="Change password"><KeyRound size={17} /></button>
          <button className="icon-button" onClick={() => setConfirmOut(true)} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar"><button className="icon-button hamburger" onClick={() => setMobileNav(!mobileNav)} aria-label="Open menu"><Menu size={20} /></button>
        {/* <div className="crumb"><b>{current.label}</b></div> */}
        <div className="top-actions"><span className="env"><i />Development</span><div className="avatar avatar-blue top-avatar">{initials}</div></div></header>
      <div className="content">
        {current.key === 'overview' && <Overview go={go} />}
        {current.key === 'ceo' && <CeoDashboard />}
        {current.key === 'people' && <People />}
        {current.key === 'attendance' && <Attendance />}
        {current.key === 'expenses' && <Expenses />}
        {current.key === 'leave' && <Leave />}
        {current.key === 'calendar' && <Calendar />}
        {current.key === 'approvals' && <Approvals />}
        {current.key === 'payroll' && <Payroll />}
        {current.key === 'skills' && <Skills />}
        {current.key === 'organisation' && <Organisation />}
        {current.key === 'tickets' && <Tickets />}
        {current.key === 'locks' && <MonthLocks />}
        {current.key === 'policies' && <Policies />}
        <footer className="footer"><span>© 2026 Ageless Universe</span><span>Built for the people who make it happen <span className="heart">♥</span></span><span>v0.1.0</span></footer>
      </div>
    </main>
    {changingPassword && <ChangePassword onClose={() => setChangingPassword(false)} />}
    {confirmOut && <Modal title="Sign out?" subtitle="You will need to sign in again to continue." onClose={() => setConfirmOut(false)}>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={() => setConfirmOut(false)} autoFocus>Stay signed in</button>
        <button type="button" className="primary-btn" onClick={() => { setConfirmOut(false); logout(); }}>Sign out</button></div>
    </Modal>}
  </div>;
}

function Gate() {
  const { me, loading } = useAuth();
  if (loading) return <div className="boot"><LoaderCircle className="spin" size={22} />Loading…</div>;
  if (!me) return <Login />;
  // a temporary password (new login, admin reset): set your own before anything else
  return me.user.mustChangePassword ? <FirstLogin /> : <Shell />;
}

export default function App() {
  return <AuthProvider><Gate /></AuthProvider>;
}
