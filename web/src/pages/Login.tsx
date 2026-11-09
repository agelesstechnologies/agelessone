import { useState, type FormEvent } from 'react';
import { CalendarCheck, Eye, EyeOff, LoaderCircle, ReceiptText, Ticket, Timer } from 'lucide-react';
import { ForgotPasswordRequest, LoginRequest, ResetWithCodeRequest, type ForgotPasswordResponse, type LoginResponse } from '@ageless/shared';
import { api, errText, formError } from '../api';
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
  const [forgot, setForgot] = useState(false);

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
      {forgot ? <ForgotPassword initialLogin={name} onBack={() => setForgot(false)} /> : <form className="login-form" onSubmit={submit} noValidate>
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
        <p className="login-help"><button type="button" className="link-btn" onClick={() => { setForgot(true); setError(''); }}>First time or forgot your password?</button></p>

        {import.meta.env.DEV && <div className="demo-box">
          <small>DEVELOPMENT · DEMO LOGINS</small>
          <div>{DEMO.map((d) => <button type="button" key={d.role} className="outline-btn"
            onClick={() => { setName(d.login); setPassword(DEMO_PASSWORD); setError(''); }}>{d.role}</button>)}</div>
        </div>}
      </form>}
    </main>
  </div>;
}

/** Forgot password: a 6-digit code goes to the login's email; with it, a new password signs the person in. */
function ForgotPassword({ initialLogin, onBack }: { initialLogin: string; onBack: () => void }) {
  const { adopt } = useAuth();
  const [login, setLogin] = useState(initialLogin);
  const [sentNote, setSentNote] = useState('');
  const [devCode, setDevCode] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const parsed = ForgotPasswordRequest.safeParse({ login });
    if (!parsed.success) { setError('Enter your phone number or email'); return; }
    setBusy('send'); setError('');
    try { const r = await api<ForgotPasswordResponse>('/auth/forgot-password', { method: 'POST', json: parsed.data }); setSentNote(r.message); setDevCode(r.devCode ?? ''); }
    catch (err) { setError(errText(err)); }
    finally { setBusy(''); }
  }
  async function reset(e: FormEvent) {
    e.preventDefault();
    if (password !== again) { setError('The two passwords are not the same'); return; }
    const parsed = ResetWithCodeRequest.safeParse({ login, code, newPassword: password });
    if (!parsed.success) { setError(formError(parsed.error, 'Check the form')); return; }
    setBusy('reset'); setError('');
    try { await adopt((await api<LoginResponse>('/auth/reset-password', { method: 'POST', json: parsed.data })).token); }
    catch (err) { setError(errText(err)); setBusy(''); }
  }

  return <form className="login-form" onSubmit={sentNote ? reset : send} noValidate>
    <h1>Set your password</h1>
    <p className="login-lead">{sentNote || 'New here or forgot your password? Enter the email or phone number of your login. We will send a 6-digit code to its email and phone.'}</p>
    {devCode && <p className="dev-code">Testing mode: your code is <b>{devCode}</b></p>}
    {error && <div className="error-banner login-error" role="alert"><span>{error}</span></div>}
    <label htmlFor="fp-login">Phone or email</label>
    <input id="fp-login" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} disabled={!!sentNote} autoFocus={!sentNote} />
    {sentNote && <>
      <label htmlFor="fp-code">Code from the email or SMS</label>
      <input id="fp-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6 digits" value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
      <label htmlFor="fp-new">New password <span className="login-hint">at least 8 characters</span></label>
      <input id="fp-new" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <label htmlFor="fp-again">Type it again</label>
      <input id="fp-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
    </>}
    <button className="primary-btn login-submit" disabled={busy !== ''}>{busy && <LoaderCircle className="spin" size={16} />}
      {sentNote ? 'Set password and sign in' : 'Email me a code'}</button>
    <div className="login-links">
      {sentNote && <button type="button" className="link-btn" disabled={busy !== ''} onClick={() => void send()}>Send a new code</button>}
      <button type="button" className="link-btn" onClick={onBack}>Back to sign in</button>
    </div>
    <p className="login-help">No login yet? Ask your supervisor or HR to create one for you.</p>
  </form>;
}
