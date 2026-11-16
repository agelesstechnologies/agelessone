import type { OverdueAlert } from '@ageless/shared';
import { api } from '../api';
import { dayLabel, useLoad } from '../hooks';
import { Badge, Empty, Loading, Notice, Panel } from '../ui';
import { openTicket } from './Tickets';

/**
 * Overdue tickets the signed-in person is alerted about, most overdue first: a department head or supervisor the tickets
 * of their departments (the day after the due date); the CEO the ones sent to them after a few more days overdue
 * (policy tickets.overdue.ceo_after_days). The daily job takes these steps. Hidden when empty, unless `showEmpty`.
 */
export default function OverdueAlerts({ company, title = 'Overdue tickets', note, showEmpty = false }: {
  company?: string; title?: string; note?: string; showEmpty?: boolean;
}) {
  const q = useLoad(() => api<OverdueAlert[]>(`/tickets/overdue-alerts${company ? `?company=${company}` : ''}`), [company]);
  const items = q.data ?? [];
  if (!showEmpty && !q.error && !items.length) return null;
  return <Panel title={title} note={note ?? (items.length ? `${items.length} past the due date` : undefined)}>
    <div className="panel-body">
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !items.length ? <Empty title="Nothing overdue" text="Tickets overdue long enough to reach you appear here." /> :
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>TICKET</th><th>DEPARTMENT</th><th>ASSIGNED TO</th><th>DUE</th><th>OVERDUE</th></tr></thead>
          <tbody>{items.map((a) => <tr key={a.ticket.publicId} className="link-row" onClick={() => openTicket(a.ticket.publicId)}>
            <td><b>{a.ticket.number}</b><small className="sub">{a.ticket.title}</small></td>
            <td>{a.department.name}<small className="sub">Supervisor {a.supervisor.displayName}</small></td>
            <td>{a.primaryAssignee?.displayName ?? <span className="muted-text">Nobody</span>}</td>
            <td>{dayLabel(a.dueDate)}</td>
            <td><Badge tone={a.sentToCeoAt ? 'red' : 'amber'}>{a.daysOverdue} day{a.daysOverdue === 1 ? '' : 's'}</Badge>
              {a.sentToCeoAt && <small className="sub">Sent to the CEO</small>}</td>
          </tr>)}</tbody></table></div>}
    </div>
  </Panel>;
}
