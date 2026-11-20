import { useState } from 'react';
import { CheckCheck, Settings } from 'lucide-react';
import type { NotificationList } from '@ageless/shared';
import { ago, openAlert, readAll } from '../Bell';
import { errText } from '../api';
import { useApi } from '../hooks';
import AlertSettings from './AlertSettings';
import { Badge, Empty, Loading, Notice, Panel, Tabs } from '../ui';

type Filter = 'all' | 'unread';
const SHOWN = 8;

/**
 * Everything the system has told this person, newest first, on the Overview. Opening an alert marks it read and goes to the
 * record. The top bar's bell shows the same alerts; Settings chooses which ones are also emailed.
 */
export default function AlertsPanel() {
  const [filter, setFilter] = useState<Filter>('all');
  const [all, setAll] = useState(false);
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState('');
  const q = useApi<NotificationList>(`/core/notifications?limit=100${filter === 'unread' ? '&unread=true' : ''}`);
  const unread = q.data?.unreadCount ?? 0;
  const items = q.data?.items ?? [];
  const shown = all ? items : items.slice(0, SHOWN);

  return <div className="alerts-block">
    <Panel title="Alerts" note={unread ? `${unread} unread` : 'You are all caught up'} action={<div className="head-actions">
      {unread > 0 && <button type="button" className="outline-btn" onClick={() => { setError(''); readAll().catch((e) => setError(errText(e))); }}>
        <CheckCheck size={14} />Mark all read</button>}
      <button type="button" className="outline-btn" onClick={() => setSettings(true)}><Settings size={14} />Settings</button>
    </div>}>
      <div className="alerts-panel">
      {error && <Notice onClose={() => setError('')}>{error}</Notice>}
      <Tabs tabs={[{ key: 'all', label: 'All' }, { key: 'unread', label: `Unread (${unread})` }]} value={filter} onChange={(k) => { setFilter(k); setAll(false); }} />
      {q.loading && !q.data ? <Loading /> : !items.length
        ? <Empty title={filter === 'unread' ? 'Nothing unread' : 'No alerts yet'} text="New alerts from every part of the system appear here." />
        : <ul className="alert-list alert-page">
          {shown.map((n) => <li key={n.publicId}>
            <button type="button" className={`alert-item${n.readAt ? '' : ' unread'}${n.urgency === 'urgent' ? ' urgent' : ''}`} onClick={() => void openAlert(n)}>
              <b>{n.title}{n.urgency === 'urgent' && <> <Badge tone="red">Urgent</Badge></>}</b>
              {n.body && <span>{n.body}</span>}<small>{ago(n.createdAt)}</small>
            </button></li>)}
        </ul>}
      {items.length > SHOWN && <button type="button" className="bell-all alerts-more" onClick={() => setAll(!all)}>
        {all ? 'Show fewer' : `Show all ${items.length}`}</button>}
      </div>
    </Panel>
    {settings && <AlertSettings onClose={() => setSettings(false)} />}
  </div>;
}
