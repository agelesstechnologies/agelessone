import { useState } from 'react';
import type { NotificationPreferences } from '@ageless/shared';
import { api } from '../api';
import { useApi } from '../hooks';
import { invalidate } from '../query';
import { FormModal, Loading, Modal } from '../ui';

/**
 * My alert emails. The bell always shows every alert; these choices are only for email: urgent alerts at once (outside quiet
 * hours), the 8 AM summary of the rest, and which types of alert I want emailed at all.
 */
export default function AlertSettings({ onClose }: { onClose: () => void }) {
  const q = useApi<NotificationPreferences>('/core/notifications/preferences', { staleTime: 0 });
  const [quiet, setQuiet] = useState<boolean | null>(null);
  if (!q.data) return <Modal title="Alert settings" onClose={onClose}>{q.error ? <p role="alert">{q.error}</p> : <Loading />}</Modal>;
  const p = q.data;
  const quietOn = quiet ?? p.quietHours !== null;
  const modules = [...new Set(p.types.map((t) => t.module))];

  return <FormModal title="Alert settings" subtitle="The bell always shows every alert. These choices are for email only." submitLabel="Save" onClose={onClose} wide
    run={async (f) => {
      const types: Record<string, boolean> = {};
      for (const t of p.types) types[t.code] = f.get(`type:${t.code}`) === 'on';
      await api('/core/notifications/preferences', { method: 'PUT', json: {
        emailUrgent: f.get('emailUrgent') === 'on', emailDigest: f.get('emailDigest') === 'on', types,
        quietHours: quietOn ? { start: String(f.get('quietStart') ?? ''), end: String(f.get('quietEnd') ?? '') } : null,
      } });
      await invalidate('/core/notifications/preferences');
      onClose();
    }}>
    <label className="span-two check-label"><input type="checkbox" name="emailUrgent" defaultChecked={p.emailUrgent} /> Email me urgent alerts at once</label>
    <label className="span-two check-label"><input type="checkbox" name="emailDigest" defaultChecked={p.emailDigest} /> Email me a summary of the rest every morning (8 AM)</label>
    <label className="span-two check-label"><input type="checkbox" checked={quietOn} onChange={(e) => setQuiet(e.target.checked)} /> Quiet hours: hold urgent emails (India time)</label>
    {quietOn && <>
      <label>From<input type="time" name="quietStart" defaultValue={p.quietHours?.start ?? '22:00'} required /></label>
      <label>Until<input type="time" name="quietEnd" defaultValue={p.quietHours?.end ?? '07:00'} required /></label>
    </>}
    <div className="span-two divider" />
    {modules.map((m) => <fieldset key={m} className="span-two alert-types">
      <legend>{m}</legend>
      {p.types.filter((t) => t.module === m).map((t) =>
        <label key={t.code} className="check-label"><input type="checkbox" name={`type:${t.code}`} defaultChecked={t.email} /> {t.label}{t.urgent && <em> · urgent</em>}</label>)}
    </fieldset>)}
  </FormModal>;
}
