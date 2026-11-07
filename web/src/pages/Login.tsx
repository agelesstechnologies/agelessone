import { useState, type FormEvent } from 'react';
import { CalendarCheck, Eye, EyeOff, LoaderCircle, ReceiptText, Ticket, Timer } from 'lucide-react';
import { LoginRequest } from '@ageless/shared';
import { errText } from '../api';
import { useAuth } from '../auth';

/** Demo logins from the development seed (backend/scripts/db-seed.mjs). Shown only in `pnpm dev`. */
const DEMO_PASSWORD = 'demo-pass-1';
const DEMO = [
  { role: 'Employee', login: 'demo.engineer@example.com' },
  { role: 'Supervisor', login: 'demo.supervisor@example.com' },
  { role: 'HR', login: 'demo.hr@example.com' },
  { role: 'CEO', login: 'demo.ceo@example.com' },
  { role: 'System admin', login: 'demo.admin@example.com' },
];

const FEATURES = [
  { icon: <Timer size={16} />, text: 'Daily punch in and out, work hours' },
  { icon: <CalendarCheck size={16} />, text: 'Leave requests and approvals' },
  { icon: <ReceiptText size={16} />, text: 'Expense claims with receipts' },
  { icon: <Ticket size={16} />, text: 'Service tickets and time on site' },
];

export default function Login() {
  const { login } = useAuth();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = LoginRequest.safeParse({ login: name, password });
    if (!parsed.success) { setError('Enter your phone number or email, and your password'); return; }
    setBusy(true); setError('');
    try { await login(parsed.data.login, parsed.data.password); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  }

  return <div className="login-page">
    <aside className="login-hero">
      <div className="login-brand"><div className="login-mark">a<span>.</span></div><div><b>ageless</b><small>PEOPLE PLATFORM</small></div></div>
      <div className="login-pitch">
        <h2>Everything your day at work needs, in one place.</h2>
        <ul>{FEATURES.map((f) => <li key={f.text}><span>{f.icon}</span>{f.text}</li>)}</ul>
      </div>
      <small className="login-foot">© 2026 Ageless Universe</small>
    </aside>

    <main className="login-main">
      <form className="login-form" onSubmit={submit} noValidate>
        <h1>Welcome back</h1>
        <p className="login-lead">Sign in with the phone number or email registered for your login.</p>
        {error && <div className="error-banner login-error" role="alert"><span>{error}</span></div>}
        <label htmlFor="login">Phone or email</label>
        <input id="login" autoComplete="username" placeholder="e.g. 98765 43210 or name@ageless.in" value={name}
          onChange={(e) => setName(e.target.value)} autoFocus />
        <label htmlFor="password">Password</label>
        <div className="password-field">
          <input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
          <button type="button" className="reveal" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}
            title={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </div>
        <button className="primary-btn login-submit" disabled={busy}>{busy && <LoaderCircle className="spin" size={16} />}{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="login-help">Forgot your password? Ask HR or your system admin to reset it.</p>

        {import.meta.env.DEV && <div className="demo-box">
          <small>DEVELOPMENT · DEMO LOGINS</small>
          <div>{DEMO.map((d) => <button type="button" key={d.role} className="outline-btn"
            onClick={() => { setName(d.login); setPassword(DEMO_PASSWORD); setError(''); }}>{d.role}</button>)}</div>
        </div>}
      </form>
    </main>
  </div>;
}
