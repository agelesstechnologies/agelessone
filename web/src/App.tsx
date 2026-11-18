import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Activity, Award, Ticket, BriefcaseBusiness, Building2, Network, CalendarDays, CalendarRange, ChevronDown, ClipboardCheck, ClipboardList, Crown, FileStack, KeyRound, LayoutDashboard, Landmark, LoaderCircle, Lock, LogOut, Menu, Package, Boxes, SlidersHorizontal, Tags, Users, Wallet, Warehouse, X } from 'lucide-react';
import { useApi } from './hooks';
import { AuthProvider, useAuth } from './auth';
import { anyInventory, ATTENDANCE, EXPENSES, INVENTORY, LEAVE, MANAGEMENT, PAYROLL, PEOPLE, POLICIES, SKILLS, TICKETS, TICKET_TYPES } from './permissions';
import Accounts from './pages/Accounts';
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
import InventoryDocuments from './pages/inventory/Documents';
import InventoryItems from './pages/inventory/Items';
import InventoryLocations from './pages/inventory/Locations';
import InventoryRequests from './pages/inventory/Requests';
import InventorySetup from './pages/inventory/Setup';
import InventoryStock from './pages/inventory/Stock';
import ChangePassword from './ChangePassword';
import { Modal } from './ui';
import type { AccountsAccess, Grant } from '@ageless/shared';

type PageKey = 'overview' | 'ceo' | 'people' | 'attendance' | 'expenses' | 'leave' | 'calendar' | 'approvals' | 'payroll' | 'skills' | 'tickets' | 'organisation' | 'locks' | 'policies' | 'accounts'
  | 'inv-requests' | 'inv-stock' | 'inv-documents' | 'inv-items' | 'inv-locations' | 'inv-setup';
type GroupKey = 'hrms' | 'accounts' | 'operations' | 'inventory';
/**
 * What the backend says beyond permissions: accountsView — may see the Accounts section (Accounts roles can come from the
 * interim policy); grants — has cross-company access to request parts (without an inventory role).
 */
interface MenuAccess { accountsView: boolean; grants: boolean }
interface NavItem { key: PageKey; label: string; icon: ReactNode; section: 'workspace' | GroupKey | 'manage'; show: (can: (p: string) => boolean, others: boolean, scopeOf: (p: string) => string | null, access: MenuAccess) => boolean }
const invRead = (can: (p: string) => boolean) => can(INVENTORY.view) || can(INVENTORY.items) || can(INVENTORY.locations);
const stockRead = (can: (p: string) => boolean) => can(INVENTORY.view) || can(INVENTORY.stockPost);
import logo from './assets/ageless-logo.webp';

/** Every menu item lists the permission that shows it; the backend still checks each request. */
const NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} />, section: 'workspace', show: () => true },
  { key: 'ceo', label: 'CEO dashboard', icon: <Crown size={18} />, section: 'workspace', show: (_can, _others, scopeOf) => scopeOf(MANAGEMENT) === 'all' },
  { key: 'people', label: 'People', icon: <Users size={18} />, section: 'workspace', show: (_can, others) => others },
  { key: 'attendance', label: 'Attendance', icon: <Activity size={18} />, section: 'workspace', show: (can) => can(ATTENDANCE.punch) || can(ATTENDANCE.view) || can(ATTENDANCE.approve) },
  { key: 'expenses', label: 'Expenses', icon: <BriefcaseBusiness size={18} />, section: 'workspace', show: (can) => can(EXPENSES.submit) || can(EXPENSES.approve) || can(EXPENSES.report) },
  { key: 'leave', label: 'Leave', icon: <CalendarDays size={18} />, section: 'workspace', show: (can) => can(LEAVE.apply) || can(LEAVE.approve) || can(LEAVE.report) },
  { key: 'calendar', label: 'Calendar', icon: <CalendarRange size={18} />, section: 'workspace', show: (can) => can(PEOPLE.view) },
  { key: 'approvals', label: 'Approvals', icon: <ClipboardCheck size={18} />, section: 'workspace', show: (can) => can(LEAVE.approve) || can(EXPENSES.approve) || can(ATTENDANCE.approve) },
  { key: 'payroll', label: 'Payroll', icon: <Wallet size={18} />, section: 'accounts', show: (can) => can(PAYROLL.payslip) || can(PAYROLL.prepare) || can(PAYROLL.approve) },
  // Periods, the journal and the Tally ledger map (the Accounts module), inside the Accounts menu group.
  { key: 'accounts', label: 'Accounts', icon: <Landmark size={18} />, section: 'accounts', show: (_can, _others, _scopeOf, access) => access.accountsView },
  { key: 'skills', label: 'Skills', icon: <Award size={18} />, section: 'hrms', show: (can) => can(SKILLS.view) || can(SKILLS.manage) },
  { key: 'tickets', label: 'Tickets', icon: <Ticket size={18} />, section: 'operations', show: (can) => can(TICKETS.view) || can(TICKETS.work) || can(TICKETS.manage) || can(TICKET_TYPES.view) || can(TICKETS.numbering) },
  { key: 'organisation', label: 'Organisation', icon: <Network size={18} />, section: 'workspace', show: (can, others) => others && (can(PEOPLE.manageEmployments) || can(PEOPLE.managePositions) || can(PEOPLE.view)) },
  { key: 'locks', label: 'Month locks', icon: <Lock size={18} />, section: 'manage', show: (can) => can(ATTENDANCE.lockMonth) || can(ATTENDANCE.unlockMonth) },
  { key: 'policies', label: 'Policies', icon: <SlidersHorizontal size={18} />, section: 'manage', show: (can) => can(POLICIES.manage) },
  // Inventory is need-to-know: shown only to store roles, Accounts, Management, parts requesters, department heads (and cross-company grantees)
  { key: 'inv-requests', label: 'Part requests', icon: <ClipboardList size={18} />, section: 'inventory', show: (can, _o, _s, access) => access.grants || can(INVENTORY.request) || can(INVENTORY.requestsApprove) || can(INVENTORY.departmentView) || stockRead(can) },
  { key: 'inv-stock', label: 'Stock', icon: <Boxes size={18} />, section: 'inventory', show: stockRead },
  { key: 'inv-documents', label: 'Documents', icon: <FileStack size={18} />, section: 'inventory', show: stockRead },
  { key: 'inv-items', label: 'Items', icon: <Package size={18} />, section: 'inventory', show: invRead },
  { key: 'inv-locations', label: 'Locations', icon: <Warehouse size={18} />, section: 'inventory', show: invRead },
  { key: 'inv-setup', label: 'Units & categories', icon: <Tags size={18} />, section: 'inventory', show: invRead },
];

/** Menu order: Overview first, then Attendance and Tickets, then everything else in the order of NAV. */
const MENU_FIRST: PageKey[] = ['overview', 'ceo', 'attendance', 'tickets'];

const pageFromHash = (): PageKey => {
  const h = window.location.hash.replace('#', '').split('/')[0] ?? '';   // #tickets/<id> is the Tickets page, #inv-documents/<id> the Documents page
  return NAV.some((n) => n.key === h) ? (h as PageKey) : 'overview';
};

function Shell() {
  const { me, can, scopeOf, logout, seesOthers } = useAuth();
  const [page, setPage] = useState<PageKey>(pageFromHash);
  const [mobileNav, setMobileNav] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  // Accounts roles can come from the interim policy (HR, CEO), so the backend says who may see the section.
  const accountsView = useApi<AccountsAccess>('/accounts/access').data?.view ?? false;
  const go = useCallback((p: string) => { window.location.hash = p; setMobileNav(false); }, []);
  // people without an inventory role may still have cross-company access to request parts for a ticket
  const noInventory = !!me && !anyInventory(can);
  const grants = useApi<Grant[]>(noInventory ? '/inventory/grants/mine' : null);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Every page: the browser tab names the page, a new page starts at the top, Escape closes the phone menu.
  useEffect(() => {
    const label = NAV.find((n) => n.key === page)?.label;
    document.title = label ? `${label} · Ageless` : 'Ageless';
    window.scrollTo(0, 0);
    document.querySelector('.content')?.scrollTo?.(0, 0);
  }, [page]);
  useEffect(() => {
    if (!mobileNav) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileNav(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNav]);
  if (!me) return null;

  const items = NAV.filter((n) => n.show(can, seesOthers, scopeOf, { accountsView, grants: (grants.data ?? []).some((g) => g.active) }));
  // A page the person may not open (typed in the address bar) falls back to the overview.
  const current = items.find((n) => n.key === page) ?? items[0]!;
  const role = me.roles[0]?.name ?? 'No role';
  const initials = me.person.displayName.split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  const link = (n: NavItem) => <a key={n.key} href={`#${n.key}`} className={`${n.key === current.key ? 'active' : ''} `} onClick={() => setMobileNav(false)}>
    {n.icon}{n.label}</a>;
  const menu = [...MENU_FIRST.flatMap((k) => items.filter((n) => n.key === k)), ...items.filter((n) => n.section !== 'manage' && !MENU_FIRST.includes(n.key))];

  return <div className="app-shell">
    {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'show' : ''}`}>
      <div className="brand"><img className="brand-logo" src={logo} alt="Ageless Entertainments" /><button className="icon-button mobile-close" onClick={() => setMobileNav(false)} aria-label="Close menu"><X size={18} /></button></div>
      <div className="workspace"><div className="workspace-icon"><Building2 size={18} /></div><div><b>Ageless Group</b><small>Organization</small></div><ChevronDown size={15} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>
        {menu.map(link)}
      </nav>
      {items.some((n) => n.section === 'manage') && <><div className="nav-label manage-label">MANAGE</div><nav>{items.filter((n) => n.section === 'manage').map(link)}</nav></>}
      <div className="sidebar-bottom">
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
        {current.key === 'accounts' && <Accounts />}
        {current.key === 'skills' && <Skills />}
        {current.key === 'organisation' && <Organisation />}
        {current.key === 'tickets' && <Tickets />}
        {current.key === 'locks' && <MonthLocks />}
        {current.key === 'policies' && <Policies />}
        {current.key === 'inv-requests' && <InventoryRequests />}
        {current.key === 'inv-stock' && <InventoryStock />}
        {current.key === 'inv-documents' && <InventoryDocuments />}
        {current.key === 'inv-items' && <InventoryItems />}
        {current.key === 'inv-locations' && <InventoryLocations />}
        {current.key === 'inv-setup' && <InventorySetup />}
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
  // keyed by the person, so a screen never keeps what it showed the last person
  return me.user.mustChangePassword ? <FirstLogin /> : <Shell key={me.person.publicId} />;
}

export default function App() {
  return <AuthProvider><Gate /></AuthProvider>;
}
