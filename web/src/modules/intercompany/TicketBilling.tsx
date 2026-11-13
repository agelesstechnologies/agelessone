import { useState, type FormEvent } from 'react';
import { Building2 } from 'lucide-react';
import { LinkTicketToWorkRequest, SetBillableRequest, type TicketBilling } from '@ageless/shared';
import { api, ApiFailure, errText, formError } from '../../api';
import { useAuth } from '../../auth';
import { useLoad, uuidv7 } from '../../hooks';
import { INTERCOMPANY } from '../../permissions';
import { Badge, Modal, Notice } from '../../ui';
import { COMPANIES, SERVICE_LABEL, SERVICES, stampIst } from './common';

/**
 * A ticket's billing to another company of the group. Answered only to the head of the ticket's department and the CEO;
 * for anyone else (403) there is nothing to show.
 */
export function useTicketBilling(ticketId: string) {
  return useLoad(() => api<TicketBilling>(`/intercompany/tickets/${ticketId}/billing`)
    .catch((e) => { if (e instanceof ApiFailure && (e.status === 403 || e.status === 404)) return null; throw e; }), [ticketId]);
}

/** The badge on the ticket card: "Billable to AE", or "Not billable to AE". */
export function BillingBadge({ billing }: { billing: TicketBilling | null | undefined }) {
  if (!billing?.billableTo) return null;
  return billing.billable ? <Badge tone="green">Billable to {billing.billableTo}</Badge> : <Badge tone="gray">Not billable to {billing.billableTo}</Badge>;
}

/**
 * The ticket's billing box for its department head (and the CEO): the link to the other company's project or design
 * request, billable or not (with the reason), and the actions. Changes are audited by the server.
 */
export function TicketBillingBox({ ticketId, billing, onChange }: { ticketId: string; billing: TicketBilling; onChange: (b: TicketBilling) => void }) {
  const { can } = useAuth();
  // the answer came: the caller heads the ticket's department or is the CEO; the CEO acts with intercompany.manage
  const acts = can(INTERCOMPANY.manage) || !can(INTERCOMPANY.view);
  const [dialog, setDialog] = useState<'link' | 'not-billable' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function billable() {
    setBusy(true); setError('');
    try { onChange(await api<TicketBilling>(`/intercompany/tickets/${ticketId}/billable`, { method: 'POST', json: { billable: true } })); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }
  return <section className="tp-card ic-billing">
    <div className="ic-billing-head"><Building2 size={17} /><b>Intercompany billing</b><BillingBadge billing={billing} /></div>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {!billing.link ? <p className="muted-text">Not billed to another company. Link it when the work is for the other company's project or design request: it then becomes billable by default.</p>
      : <dl className="kv-grid">
        <span>For</span><b>{billing.billableTo}'s {billing.link.kind === 'project' ? 'project' : 'design request'} <span className="mono">{billing.link.publicId.slice(0, 8)}</span></b>
        <span>Billed as</span><b>{billing.serviceType ? SERVICE_LABEL[billing.serviceType] : 'No service type: link it again'}</b>
        {!billing.billable && <><span>Not billable because</span><b>{billing.notBillableReason}</b></>}
        {billing.changedBy && <><span>Last change</span><b>{billing.changedBy.displayName}, {stampIst(billing.changedAt!)}</b></>}
      </dl>}
    {acts && <div className="row-actions">
      <button className="outline-btn" onClick={() => setDialog('link')}>{billing.link ? 'Change link' : 'Bill to the other company'}</button>
      {billing.link && billing.billable && <button className="danger-btn" onClick={() => setDialog('not-billable')}>Not billable</button>}
      {billing.link && !billing.billable && <button className="outline-btn" disabled={busy} onClick={() => void billable()}>Make billable</button>}
    </div>}
    {dialog === 'link' && <LinkDialog ticketId={ticketId} ticketCompany={billing.ticket.company} billing={billing} onClose={() => setDialog(null)} onSaved={(b) => { setDialog(null); onChange(b); }} />}
    {dialog === 'not-billable' && <NotBillable ticketId={ticketId} billing={billing} onClose={() => setDialog(null)} onSaved={(b) => { setDialog(null); onChange(b); }} />}
  </section>;
}

function LinkDialog({ ticketId, ticketCompany, billing, onClose, onSaved }: { ticketId: string; ticketCompany: string; billing: TicketBilling;
  onClose: () => void; onSaved: (b: TicketBilling) => void }) {
  const others = COMPANIES.filter((c) => c.code !== ticketCompany);
  const [company, setCompany] = useState(billing.billableTo ?? others[0]?.code ?? '');
  const [kind, setKind] = useState<'project' | 'design_request'>(billing.link?.kind ?? 'project');
  const [publicId, setPublicId] = useState(billing.link?.publicId ?? '');
  const [serviceType, setServiceType] = useState<string>(billing.serviceType ?? 'design');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = LinkTicketToWorkRequest.safeParse({ company, kind, publicId: publicId.trim(), serviceType });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setSaving(true); setError('');
    try { onSaved(await api<TicketBilling>(`/intercompany/tickets/${ticketId}/link`, { method: 'PUT', json: parsed.data })); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title="Bill to the other company" subtitle="Work for another company's project or design request is billable to it by default." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Company<select id="icb-company" value={company} onChange={(e) => setCompany(e.target.value)}>{others.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <label>For their<select id="icb-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="project">Project</option><option value="design_request">Design request</option></select></label>
        <label className="span-two">{kind === 'project' ? 'Project' : 'Design request'} ID<span className="optional">tickets of the same {kind === 'project' ? 'project' : 'request'} share it</span>
          <span className="chip-row"><input id="icb-id" value={publicId} onChange={(e) => setPublicId(e.target.value)} placeholder="Paste the ID" autoComplete="off" />
            <button type="button" className="outline-btn" onClick={() => setPublicId(uuidv7())}>New ID</button></span></label>
        <label className="span-two">Billed as<select id="icb-service" value={serviceType} onChange={(e) => setServiceType(e.target.value)}>
          {SERVICES.map((s) => <option key={s} value={s}>{SERVICE_LABEL[s]}</option>)}</select></label>
        {billing.billableTo === company && !billing.billable && <p className="span-two muted-text">It stays not billable: the same company keeps the decision.</p>}
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Save link'}</button></div>
    </form>
  </Modal>;
}

function NotBillable({ ticketId, billing, onClose, onSaved }: { ticketId: string; billing: TicketBilling; onClose: () => void; onSaved: (b: TicketBilling) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = SetBillableRequest.safeParse({ billable: false, reason });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setSaving(true); setError('');
    try { onSaved(await api<TicketBilling>(`/intercompany/tickets/${ticketId}/billable`, { method: 'POST', json: parsed.data })); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }
  return <Modal title={`Not billable to ${billing.billableTo}?`} subtitle="Its time is left out of the statements. The reason is kept with who decided." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid"><label className="span-two">Reason<input id="icb-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Warranty rework, our mistake" autoFocus /></label></div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="danger-btn" disabled={saving}>{saving ? 'Saving…' : 'Not billable'}</button></div>
    </form>
  </Modal>;
}
