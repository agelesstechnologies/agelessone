import { useEffect, useRef, useState } from 'react';
import { Bell as BellIcon, CheckCheck } from 'lucide-react';
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

/** The bell in the top bar: unread count (read again every minute and when the tab gets focus) and the latest alerts. */
export default function Bell() {
  const q = useApi<NotificationList>('/core/notifications?limit=8', { refetchInterval: 60_000 });
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

  return <div className="bell" ref={box}>
    <button type="button" className="icon-button bell-btn" onClick={() => setOpen(!open)} aria-label={unread ? `Alerts, ${unread} unread` : 'Alerts'} aria-expanded={open}>
      <BellIcon size={19} />{unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <div className="bell-menu" role="dialog" aria-label="Alerts">
      <div className="bell-head"><b>Alerts</b>
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
    {settings && <AlertSettings onClose={() => setSettings(false)} />}
  </div>;
}
