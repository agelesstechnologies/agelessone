import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { PartRequest, TicketParts as Parts } from '@ageless/shared';
import { api } from '../../api';
import { dayLabel, useLoad } from '../../hooks';
import { Badge, Empty, Loading, Notice } from '../../ui';
import { money, qty, REQUEST_TONE } from './common';
import { NewRequestForm, RequestDetail } from './Requests';

/**
 * A ticket's parts (the Parts tile, like Froid's "Parts required"): its part requests with what is reserved and issued,
 * "Request parts" for the people who may ask, and the parts issued to it and returned. Values only for those who see them
 * (the store, the ticket's department head); requesters never do.
 */
export default function TicketPartsView({ ticketId }: { ticketId: string }) {
  const q = useLoad(() => api<Parts>(`/inventory/tickets/${ticketId}/parts`), [ticketId]);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<PartRequest | null>(null);
  const [note, setNote] = useState('');
  const p = q.data;
  if (!p) return <section className="tp-card">{q.error ? <Notice>{q.error}</Notice> : <Loading />}</section>;

  return <section className="tp-card">
    {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
    {p.canRequest && <div className="chip-row"><button className="primary-btn" onClick={() => setAsking(true)}><Plus size={14} /> Request parts</button></div>}
    <h3 className="tp-sub-head">Part requests</h3>
    {!p.requests.length ? <Empty title="No parts requested" text={p.canRequest ? 'Ask the store for the parts this ticket needs.' : undefined} /> :
      p.requests.map((r) => <div className="parts-request" key={r.publicId}>
        <div className="parts-request-head">
          <span><b>{r.number}</b> · {r.requestedBy.displayName} · {dayLabel(r.createdAt.slice(0, 10))}</span>
          <span className="chip-row"><Badge tone={REQUEST_TONE[r.status]}>{r.status}</Badge>
            {r.status === 'approved' && r.reserveUntil && <small className="muted-text">kept until {dayLabel(r.reserveUntil)}</small>}
            {p.showsValues && r.estimatedValueMinor != null && <small className="muted-text">{money(r.estimatedValueMinor)}</small>}
            <button className="text-btn" onClick={() => setOpen(r)}>Details</button></span>
        </div>
        <ul className="parts-lines">{r.lines.map((l) => <li key={l.lineNo}><span><b>{l.item.code}</b> {l.item.name}</span>
          <span className="qty">{qty(l.quantity)} {l.unit.code}{l.reserved > 0 ? ` · ${qty(l.reserved)} kept` : ''}{l.issued > 0 ? ` · ${qty(l.issued)} handed out` : ''}</span></li>)}</ul>
        {r.decisionReason && <small className="muted-text">{r.status}: {r.decisionReason}</small>}
      </div>)}
    <h3 className="tp-sub-head">Parts issued and returned</h3>
    {!p.documents.length ? <p className="muted-text">No parts issued to this ticket yet.</p> :
      p.documents.map((d) => <div className="parts-request" key={d.publicId}>
        <div className="parts-request-head"><span><b>{d.number}</b> · {d.type === 'issue' ? 'issued' : 'returned'} · {dayLabel(d.documentDate)}</span>
          {d.status === 'reversed' && <Badge tone="gray">reversed</Badge>}</div>
        <ul className="parts-lines">{d.lines.map((l) => <li key={l.lineNo}><span><b>{l.item.code}</b> {l.item.name}{l.batchNo ? ` · batch ${l.batchNo}` : ''}{l.serialNo ? ` · ${l.serialNo}` : ''}</span>
          <span className="qty">{qty(l.quantity)} {l.unit.code}{p.showsValues && l.valueMinor != null ? ` · ${money(l.valueMinor)}` : ''}</span></li>)}</ul>
      </div>)}
    {asking && <NewRequestForm ticket={p.ticket} onClose={() => setAsking(false)} onSaved={(r) => { setAsking(false); setNote(`${r.number} sent to the store.`); q.reload(); }} />}
    {open && <RequestDetail request={open} onClose={() => setOpen(null)} onChanged={() => q.reload()} />}
  </section>;
}
