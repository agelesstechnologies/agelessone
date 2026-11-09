import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Eye, EyeOff, LoaderCircle, MailCheck } from 'lucide-react';
import { CompleteFirstLoginRequest, type CodeSent, type LoginResponse } from '@ageless/shared';
import { api, errText } from '../api';
import { useAuth } from '../auth';

/**
 * First sign-in with a temporary password: a 6-digit code goes to the login email; the person enters it and chooses
 * their own password. Nothing else in the app opens until this is done.
 */
export default function FirstLogin() {
  const { me, adopt, logout } = useAuth();
  const hasEmail = !!(me?.user.loginEmail || me?.user.loginPhone);   // a code goes to the login email and/or phone
  const [sent, setSent] = useState<CodeSent | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const asked = useRef(false);

  async function sendCode() {
    setBusy('send'); setError('');
    try { setSent(await api<CodeSent>('/auth/first-login/code', { method: 'POST' })); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(''); }
  }
  // the first code goes out as soon as the page opens
  useEffect(() => { if (hasEmail && !asked.current) { asked.current = true; void sendCode(); } }, [hasEmail]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== again) { setError('The two passwords are not the same'); return; }
    const parsed = CompleteFirstLoginRequest.safeParse({ code: hasEmail ? code : undefined, newPassword: password });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the form'); return; }
    setBusy('save'); setError('');
    try { await adopt((await api<LoginResponse>('/auth/first-login', { method: 'POST', json: parsed.data })).token); }
    catch (err) { setError(errText(err)); setBusy(''); }
  }

  return <div className="login-page">
    <aside className="login-hero">
      <div className="login-brand"><div className="login-mark">a<span>.</span></div><div><b>ageless</b><small>PEOPLE PLATFORM</small></div></div>
      <div className="login-pitch"><h2>Welcome, {me?.person.displayName}.</h2>
        <ul><li><span><MailCheck size={16} /></span>Confirm the code we emailed you</li><li><span><Eye size={16} /></span>Choose a password only you know</li></ul></div>
      <small className="login-foot">© 2026 Ageless Universe</small>
    </aside>
    <main className="login-main">
      <form className="login-form" onSubmit={submit} noValidate>
        <h1>Set your password</h1>
        <p className="login-lead">{hasEmail
          ? sent ? <>We sent a 6-digit code to <b>{sent.sentTo}</b>. It works for 10 minutes.</> : 'Sending a code to your email…'
          : 'Your login was set up by someone else. Choose your own password to continue.'}</p>
        {sent?.devCode && <p className="dev-code">Testing mode: your code is <b>{sent.devCode}</b></p>}
        {error && <div className="error-banner login-error" role="alert"><span>{error}</span></div>}
        {hasEmail && <>
          <label htmlFor="code">Code from the email or SMS</label>
          <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="6 digits" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
        </>}
        <label htmlFor="new-password">New password <span className="login-hint">at least 8 characters</span></label>
        <div className="password-field">
          <input id="new-password" type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="button" className="reveal" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </div>
        <label htmlFor="again">Type it again</label>
        <input id="again" type={show ? 'text' : 'password'} autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        <button className="primary-btn login-submit" disabled={busy !== ''}>{busy === 'save' && <LoaderCircle className="spin" size={16} />}Save and continue</button>
        <div className="login-links">
          {hasEmail && <button type="button" className="link-btn" disabled={busy !== ''} onClick={() => void sendCode()}>{busy === 'send' ? 'Sending…' : 'Send a new code'}</button>}
          <button type="button" className="link-btn" onClick={logout}>Sign out</button>
        </div>
      </form>
    </main>
  </div>;
}
