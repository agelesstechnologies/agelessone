import { useEffect, useState } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import type { LetterTemplate } from '@ageless/shared';
import { api, errText } from '../api';
import { useLoad } from '../hooks';
import { Loading, Notice, Panel } from '../ui';

const COMPANIES = [{ code: 'ATPL', name: 'Ageless Technologies' }, { code: 'AE', name: 'Ageless Entertainments' }];
const FIELD_HELP: Record<string, string> = {
  name: 'short name', fullName: 'full name', employeeCode: 'employee ID', designation: 'designation', department: 'department',
  company: 'company name', joiningDate: 'joining date', engagementType: 'permanent, contract …', manager: "manager's name", today: "today's date",
};

/** HR and the CEO: each company's joining letter template. Fill-ins like {{name}} are replaced for each person. */
export default function LetterTemplates() {
  const [company, setCompany] = useState('ATPL');
  const t = useLoad(() => api<LetterTemplate>(`/hrms/letter-templates/${company}/joining`), [company]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => { if (t.data) { setTitle(t.data.title); setBody(t.data.body); } }, [t.data]);
  const changed = !!t.data && (title !== t.data.title || body !== t.data.body);

  async function save() {
    setSaving(true); setMessage(null);
    try {
      t.setData(await api<LetterTemplate>(`/hrms/letter-templates/${company}/joining`, { method: 'PUT', json: { title, body } }));
      setMessage({ tone: 'ok', text: 'Template saved. New joining letters for this company use it.' });
    } catch (e) { setMessage({ tone: 'error', text: errText(e) }); }
    finally { setSaving(false); }
  }

  return <Panel title="Joining letter template" note="One per company. HR or the CEO can still adjust the text for each person before downloading."
    action={<button className="primary-btn" disabled={!changed || saving} onClick={() => void save()}>
      {saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}Save template</button>}>
    <div className="panel-body">
      {(t.error || message) && <Notice tone={message?.tone ?? 'error'} onClose={() => setMessage(null)}>{message?.text ?? t.error}</Notice>}
      <div className="form-grid">
        <label>Company<select value={company} onChange={(e) => { setCompany(e.target.value); setMessage(null); }}>
          {COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <p className="muted-text template-state">{t.data?.isDefault ? 'Built-in text — not saved for this company yet.'
          : t.data?.updatedBy ? `Last saved by ${t.data.updatedBy.displayName}.` : ''}</p>
        {t.loading && !t.data ? <div className="span-two"><Loading /></div> : <>
          <label className="span-two">Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>
          <label className="span-two">Letter <span className="optional">blank lines separate paragraphs</span>
            <textarea className="letter-text" value={body} onChange={(e) => setBody(e.target.value)} rows={16} maxLength={20000} /></label>
        </>}
      </div>
      <div className="field-chips"><b>Fill-ins</b>{(t.data?.fields ?? Object.keys(FIELD_HELP)).map((f) =>
        <span key={f} title={FIELD_HELP[f]}><code>{`{{${f}}}`}</code> {FIELD_HELP[f]}</span>)}</div>
    </div>
  </Panel>;
}
