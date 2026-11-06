import type { ReactNode } from 'react';
import { useState } from 'react';
import { Download, LoaderCircle, X } from 'lucide-react';
import { downloadFile, errText } from './api';

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gray';

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

export function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  return <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal">
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
