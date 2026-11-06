import { useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import { LoginRequest } from '@ageless/shared';
import { errText } from '../api';
import { useAuth } from '../auth';

/** Demo logins from the development seed (backend/scripts/db-seed.mjs). Shown only in `pnpm dev`. */
const DEMO_PASSWORD = 'demo-pass-1';
const DEMO = [
  { role: 'Employee', login: 'demo.engineer@example.com' },
  { role: 'Supervisor', login: 'demo.supervisor@example.com' },
  { role: 'HR', login: 'demo.hr@example.com' },
  { role: 'System admin', login: 'demo.admin@example.com' },
];

export default function Login() {
  const { login } = useAuth();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
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
    <form className="login-card" onSubmit={submit}>
      <div className="brand"><div className="brand-mark">a<span>.</span></div><div><b>ageless</b><small>PEOPLE PLATFORM</small></div></div>
      <h1>Sign in</h1>
      <p>Use the phone number or email registered for your login.</p>
      {error && <div className="error-banner login-error" role="alert"><span>{error}</span></div>}
      <label>Phone or email<input id="login" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label>Password<input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button className="primary-btn wide" disabled={busy}>{busy && <LoaderCircle className="spin" size={15} />}Sign in</button>
      {import.meta.env.DEV && <div className="demo-box">
        <small>DEVELOPMENT DEMO LOGINS</small>
        <div>{DEMO.map((d) => <button type="button" key={d.role} className="outline-btn" onClick={() => { setName(d.login); setPassword(DEMO_PASSWORD); setError(''); }}>{d.role}</button>)}</div>
      </div>}
    </form>
  </div>;
}
