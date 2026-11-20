import { useEffect, useRef, useState } from 'react';
import { Bell as BellIcon, CheckCheck, Volume2, VolumeX } from 'lucide-react';
import type { Notification, NotificationList, NotificationsMarked } from '@ageless/shared';
import { api } from './api';
import { useApi } from './hooks';
import { invalidate } from './query';
import AlertSettings from './pages/AlertSettings';

/** "just now", "5 min ago", "3 h ago", "2 days ago"; older than a week shows the date. */
export function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  if (min < 7 * 24 * 60) { const d = Math.round(min / 1440); return `${d} day${d === 1 ? '' : 's'} ago`; }
  return new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
}

/** Marks one alert read (if unread) and opens the record it is about. Failing to mark it read never stops the opening. */
export async function openAlert(n: Notification): Promise<void> {
  if (!n.readAt) {
    try { await api<NotificationsMarked>(`/core/notifications/${n.publicId}/read`, { method: 'POST', json: {} }); } catch { /* the link still opens */ }
    void invalidate('/core/notifications');
  }
  if (n.link) window.location.hash = n.link;
}

export async function readAll(): Promise<void> {
  await api<NotificationsMarked>('/core/notifications/read-all', { method: 'POST', json: {} });
  await invalidate('/core/notifications');
}

const MUTE_KEY = 'ageless.alertSoundMuted';
const isMuted = () => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } };

const CLOSED_KEY = 'ageless.closedAlertToasts';
function closedIds(): Set<string> {
  try { return new Set<string>(JSON.parse(sessionStorage.getItem(CLOSED_KEY) ?? '[]')); } catch { return new Set(); }
}

let audio: AudioContext | undefined;
/** Two short beeps made in the browser (no sound file). Silent if the browser has not allowed audio yet. */
function beep(): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const t0 = audio.currentTime;
    [0, 0.22].forEach((offset) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = 'sine'; osc.frequency.value = 1000;
      const t = t0 + offset;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(audio!.destination);
      osc.start(t); osc.stop(t + 0.18);
    });
  } catch { /* no sound is fine */ }
}

/** The bell in the top bar: unread count (read again every 20 seconds and when the tab gets focus) and the latest alerts. */
export default function Bell() {
  const q = useApi<NotificationList>('/core/notifications?limit=8', { refetchInterval: 20_000 });
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const unread = q.data?.unreadCount ?? 0;
  const items = q.data?.items ?? [];
  const [muted, setMuted] = useState(isMuted);
  const [toasts, setToasts] = useState<Notification[]>([]);
  const [leaving, setLeaving] = useState<string[]>([]);
  const announced = useRef<Set<string>>(new Set());
  const waitingBeep = useRef(false);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Browsers only allow sound after the person has interacted with the page: unlock it on the first click or key press,
  // and play the beep that was waiting.
  useEffect(() => {
    const unlock = () => {
      try { audio ??= new AudioContext(); void audio.resume(); } catch { /* ignore */ }
      if (waitingBeep.current) { waitingBeep.current = false; if (!mutedRef.current) beep(); }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);

  // Every unread alert shows as a toast (without opening the bell) until it is closed or read, with a beep when a new one appears.
  // Closed toasts stay closed for this browser session.
  useEffect(() => {
    if (!q.data) return;
    const unreadItems = q.data.items.filter((n) => !n.readAt);
    const unreadIds = new Set(unreadItems.map((n) => n.publicId));
    const closed = closedIds();
    const fresh = unreadItems.filter((n) => !closed.has(n.publicId) && !announced.current.has(n.publicId)).slice(0, 3);
    fresh.forEach((n) => announced.current.add(n.publicId));
    setToasts((t) => [...t.filter((n) => unreadIds.has(n.publicId)), ...fresh].slice(-3));
    if (fresh.length && !mutedRef.current) {
      if (audio?.state === 'running') beep(); else waitingBeep.current = true;
    }
  }, [q.data]);

  const closeToast = (id: string) => {
    const closed = closedIds(); closed.add(id);
    try { sessionStorage.setItem(CLOSED_KEY, JSON.stringify([...closed])); } catch { /* ignore */ }
    setLeaving((l) => [...l, id]);
    window.setTimeout(() => { setToasts((t) => t.filter((n) => n.publicId !== id)); setLeaving((l) => l.filter((x) => x !== id)); }, 250);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    try { localStorage.setItem(MUTE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    if (!next) beep();
  };

  return <div className="bell" ref={box}>
    <button type="button" className={`icon-button bell-btn${toasts.length ? ' ringing' : ''}`} onClick={() => setOpen(!open)} aria-label={unread ? `Alerts, ${unread} unread` : 'Alerts'} aria-expanded={open}>
      <BellIcon size={19} />{unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <div className="bell-menu" role="dialog" aria-label="Alerts">
      <div className="bell-head"><b>Alerts</b>
        <button type="button" className="text-btn" onClick={toggleMute} aria-label={muted ? 'Turn alert sound on' : 'Turn alert sound off'}>
          {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}{muted ? 'Sound off' : 'Sound on'}</button>
        {unread > 0 && <button type="button" className="text-btn" onClick={() => void readAll()}><CheckCheck size={13} />Mark all read</button>}</div>
      {!items.length ? <p className="bell-empty">You are all caught up.</p> : <ul className="alert-list">
        {items.map((n) => <li key={n.publicId}>
          <button type="button" className={`alert-item${n.readAt ? '' : ' unread'}${n.urgency === 'urgent' ? ' urgent' : ''}`}
            onClick={() => { setOpen(false); void openAlert(n); }}>
            <b>{n.title}</b>{n.body && <span>{n.body}</span>}<small>{ago(n.createdAt)}</small>
          </button></li>)}
      </ul>}
      <button type="button" className="bell-all" onClick={() => { setOpen(false); setSettings(true); }}>Alert settings</button>
    </div>}
    {toasts.length > 0 && <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((n) => <div key={n.publicId} className={`toast${n.urgency === 'urgent' ? ' urgent' : ''}${leaving.includes(n.publicId) ? ' leaving' : ''}`}>
        <button type="button" className="toast-body" onClick={() => { closeToast(n.publicId); void openAlert(n); }}>
          <b>{n.title}</b>{n.body && <span>{n.body}</span>}</button>
        <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => closeToast(n.publicId)}>×</button>
      </div>)}
    </div>}
    {settings && <AlertSettings onClose={() => setSettings(false)} />}
  </div>;
}
