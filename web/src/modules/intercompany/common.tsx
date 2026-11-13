import { useEffect, useState } from 'react';
import type { Tone } from '../../ui';

/** Shared bits of the Intercompany screens (agreements, statements, reports). */

export const SERVICE_LABEL: Record<string, string> = { design: 'Design', software: 'Software', iot_hardware: 'IoT hardware', cgi: 'CGI' };
export const SERVICES = ['design', 'software', 'iot_hardware', 'cgi'] as const;
export const COMPANIES = [{ code: 'ATPL', name: 'Ageless Technologies' }, { code: 'AE', name: 'Ageless Entertainments' }];

export const AGREEMENT_TONE: Record<string, Tone> = { draft: 'amber', active: 'green', ended: 'gray' };
export const STATEMENT_TONE: Record<string, Tone> = {
  draft: 'amber', approved_by_provider: 'blue', sent: 'blue', partly_disputed: 'red', accepted: 'green', invoiced: 'green', closed: 'gray',
};
export const STATEMENT_LABEL: Record<string, string> = {
  draft: 'Draft', approved_by_provider: 'Approved by provider', sent: 'Sent for review', partly_disputed: 'Partly disputed',
  accepted: 'Accepted', invoiced: 'Invoiced', closed: 'Paid · closed',
};
export const LINE_TONE: Record<string, Tone> = { pending: 'amber', accepted: 'green', disputed: 'red', removed: 'gray' };
export const PRICING_LABEL: Record<string, string> = { rate_card: 'Rate card', cost_plus: 'Cost plus' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Oct 2026" from a year and month, or from "2026-10". */
export const monthName = (year: number | string, month?: number): string => {
  if (typeof year === 'string') return `${MONTHS[Number(year.slice(5, 7)) - 1]} ${year.slice(0, 4)}`;
  return `${MONTHS[(month ?? 1) - 1]} ${year}`;
};
/** The month before this one, as YYYY-MM (statements are for finished months). */
export const lastMonth = (today: string): string => {
  const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** Rupees typed by a person ("1,500" or "1500.50") as paise; null when it is not an amount. */
export function toPaise(text: string): number | null {
  const clean = text.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}
/** Paise as rupees for an input field ("1500.00"). */
export const paiseInput = (paise: number): string => (paise / 100).toFixed(2);
/** Hours from minutes, with two decimals ("2.50 h"). */
export const hoursText = (minutes: number | null): string => (minutes == null ? '—' : `${(minutes / 60).toFixed(2)} h`);
/** A percentage as people write it: 12.5 → "12.5%". */
export const pct = (v: number | null): string => (v == null ? '—' : `${Number(v.toFixed(2))}%`);
export const stampIst = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The part of the address after #intercompany/, e.g. ['statements', '<id>']; follows the browser's back and forward. */
export function useIcRoute(): string[] {
  const read = () => window.location.hash.replace(/^#/, '').split('/').slice(1).filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}
export const goIc = (...parts: string[]) => { window.location.hash = ['intercompany', ...parts].join('/'); };
