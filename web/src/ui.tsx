import type { FormEvent, ReactNode } from 'react';
import { createContext, useContext, useState } from 'react';
import { Download, LoaderCircle, X } from 'lucide-react';
import { ApiFailure, downloadFile, errText, formError } from './api';

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gray';

/** The group's companies (codes as the API uses them). */
export const COMPANIES = [{ code: 'AE', name: 'Ageless Entertainments' }, { code: 'ATPL', name: 'Ageless Technologies' }];

/** A filter for list pages: one company, or all ('' ). */
export const CompanyFilter = ({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) =>
  <label className="inline-field">Company
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All</option>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>;

/** What is wrong with each field, by path ('name', 'lines.0.quantity'). */
export type FieldErrors = Record<string, string>;
type Issues = { issues: { path: (string | number)[]; message: string }[] };

/**
 * The field messages of a form's own Zod check, or of an API refusal (VALIDATION details carry `path` and `message`), so
 * each can be shown next to its field. The first message per field wins.
 */
export function fieldErrors(e: unknown): FieldErrors {
  const out: FieldErrors = {};
  const add = (path: string, message: string) => { if (path && !(path in out)) out[path] = message; };
  if (e && typeof e === 'object' && Array.isArray((e as Issues).issues)) for (const i of (e as Issues).issues) add(i.path.join('.'), i.message);
  else if (e instanceof ApiFailure && Array.isArray(e.api.details)) {
    for (const d of e.api.details as { path?: unknown; message?: unknown }[]) if (typeof d?.path === 'string' && typeof d.message === 'string') add(d.path, d.message);
  }
  return out;
}

const FieldErrorsContext = createContext<FieldErrors>({});
/** The message for one field (from `errors`, or from the FormModal around it), shown under the field. */
export function FieldError({ name, errors }: { name: string; errors?: FieldErrors }) {
  const fromForm = useContext(FieldErrorsContext);
  const message = (errors ?? fromForm)[name];
  return message ? <small className="field-error">{message}</small> : null;
}

/**
 * A form in a modal: `run` checks the form and either answers what is wrong (a sentence, or a failed Zod parse whose
 * messages also go next to their fields through FieldError) or sends it. A refusal from the API shows its message, and its
 * VALIDATION details next to the fields.
 */
export function FormModal({ title, subtitle, submitLabel, onClose, run, wide, children }: {
  title: string; subtitle?: string; submitLabel: string; onClose: () => void; wide?: boolean;
  run: (f: FormData) => Promise<unknown> | string | Issues; children: ReactNode;
}) {
  const [error, setError] = useState('');
  const [fields, setFields] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const result = run(new FormData(e.currentTarget));
    if (typeof result === 'string') { setError(result); setFields({}); return; }
    if (!(result instanceof Promise)) { setError(formError(result)); setFields(fieldErrors(result)); return; }
    setBusy(true); setError(''); setFields({});
    try { await result; } catch (err) { setError(errText(err)); setFields(fieldErrors(err)); } finally { setBusy(false); }
  }
  return <Modal title={title} subtitle={subtitle} onClose={onClose} wide={wide}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <FieldErrorsContext.Provider value={fields}><div className="form-grid">{children}</div></FieldErrorsContext.Provider>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button><button className="primary-btn" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button></div>
    </form>
  </Modal>;
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

export const DAY_TONE: Record<string, Tone> = {
  present: 'green', working: 'blue', half_day: 'amber', missed_punch: 'amber', absent: 'red', leave: 'blue', holiday: 'gray', weekly_off: 'gray',
};
export const EXPENSE_TONE: Record<string, Tone> = { submitted: 'amber', approved: 'blue', rejected: 'red', paid: 'green' };

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: { key: K; label: string }[]; value: K; onChange: (k: K) => void }) {
  return <div className="tabs" role="tablist">{tabs.map((t) =>
    <button key={t.key} role="tab" aria-selected={t.key === value} className={`tab ${t.key === value ? 'on' : ''}`} onClick={() => onChange(t.key)}>{t.label}</button>)}</div>;
}

export function PageHead({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="heading-row"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;
}

export function Panel({ title, note, action, children }: { title?: string; note?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="directory panel">
    {(title || action) && <div className="directory-head"><div>{title && <h2>{title}</h2>}{note && <p>{note}</p>}</div>{action}</div>}
    {children}
  </section>;
}

export function Notice({ tone = 'error', onClose, children }: { tone?: 'error' | 'ok'; onClose?: () => void; children: ReactNode }) {
  return <div className={`error-banner ${tone === 'ok' ? 'notice-ok' : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
    <span>{children}</span>{onClose && <button onClick={onClose} aria-label="Dismiss"><X size={15} /></button>}
  </div>;
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return <div className="loading-line"><LoaderCircle className="spin" size={18} />{text}</div>;
}

export function Empty({ title, text }: { title: string; text?: string }) {
  return <div className="empty-line"><b>{title}</b>{text && <span>{text}</span>}</div>;
}

export function Modal({ title, subtitle, onClose, wide, children }: { title: string; subtitle?: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  return <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`modal${wide ? ' wide' : ''}`}>
      <div className="modal-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></div>
      {children}
    </div>
  </div>;
}

/** Downloads a report as CSV: the same request with `format=csv` added. */
export function CsvButton({ path, name, onError }: { path: string; name: string; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await downloadFile(`${path}${path.includes('?') ? '&' : '?'}format=csv`, name); } catch (e) { onError(errText(e)); } finally { setBusy(false); }
  }
  return <button type="button" className="outline-btn" disabled={busy} onClick={() => void go()}><Download size={13} /> {busy ? 'Preparing…' : 'CSV'}</button>;
}
