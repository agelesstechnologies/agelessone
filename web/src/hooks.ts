import { useCallback, useEffect, useState } from 'react';
import type { PersonDetail } from '@ageless/shared';
import { api, errText } from './api';
import { useAuth } from './auth';

export type Employment = PersonDetail['employments'][number];

/** Run a request on mount and whenever `deps` change; `reload()` runs it again. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    fn().then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(errText(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, setData, loading, error, reload };
}

/** The signed-in person's jobs that have not ended (a punch or claim belongs to one job). */
export function useMyEmployments() {
  const { me } = useAuth();
  const id = me?.person.publicId;
  const { data, error } = useLoad(() => (id ? api<PersonDetail>(`/hrms/people/${id}`) : Promise.reject(new Error('Not signed in'))), [id]);
  const jobs = (data?.employments ?? []).filter((j) => j.status !== 'exited');
  return { jobs, primary: jobs.find((j) => j.isPrimary) ?? jobs[0], error };
}

/** UUIDv7 made in the browser, so a retried request is stored once. */
export function uuidv7(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) { b[i] = ms % 256; ms = Math.floor(ms / 256); }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Work dates are IST calendar dates ('YYYY-MM-DD'). */
export const todayIst = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const timeIst = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—';
/** "Mon, 25 Oct"; the year is added when it is not this year ("Mon, 25 Oct 2027"), so dates are never ambiguous. */
export const dayLabel = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short',
    ...(date.slice(0, 4) !== todayIst().slice(0, 4) ? { year: 'numeric' } : {}) });
export const hm = (minutes: number): string => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
export const rupees = (paise: number): string => (paise / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });
export const words = (s: string): string => s.replace(/_/g, ' ');
