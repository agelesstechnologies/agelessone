import { useState } from 'react';
import type { Item, StockList } from '@ageless/shared';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { dayLabel, useLoad } from '../../hooks';
import { INVENTORY } from '../../permissions';
import { CompanyFilter, Empty, Loading, Notice, PageHead, Panel } from '../../ui';
import { ItemSearch, LocationSelect, money, Pager, qty, useLocations } from './common';

const PAGE_SIZE = 50;

/**
 * Stock on hand by item, location and batch: on hand, reserved for part requests, available, the company's average cost
 * and the value. A storekeeper (scope own) sees only the locations they look after.
 */
export default function Stock() {
  const { scopeOf } = useAuth();
  const [company, setCompany] = useState('');
  const [location, setLocation] = useState('');
  const [item, setItem] = useState<Item | null>(null);
  const [empty, setEmpty] = useState(false);
  const [page, setPage] = useState(1);
  const locations = useLocations(company);
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), ...(company && { company }), ...(location && { location }),
    ...(item && { item: item.publicId }), ...(empty && { includeEmpty: 'true' }) });
  const q = useLoad(() => api<StockList>(`/inventory/stock?${params}`), [params.toString()]);
  const pageValue = (q.data?.items ?? []).reduce((s, r) => s + r.valueMinor, 0);

  return <>
    <PageHead eyebrow="INVENTORY • STOCK" title="Stock on hand" subtitle="What is where. Available is on hand less what part requests have reserved; value is at the company's average cost." />
    <Panel>
      <div className="panel-body">
        <div className="filters">
          <CompanyFilter id="st-company" value={company} onChange={(v) => { setCompany(v); setLocation(''); setItem(null); setPage(1); }} />
          {company && <label className="inline-field">Location
            <LocationSelect id="st-location" locations={locations.data ?? []} value={location} onChange={(v) => { setLocation(v); setPage(1); }} empty="All" /></label>}
          <ItemSearch key={company} id="st-item" company={company} className="inline-field" onPick={(i) => { setItem(i); setPage(1); }} />
          <label className="inline-field check-row"><input type="checkbox" checked={empty} onChange={(e) => { setEmpty(e.target.checked); setPage(1); }} /> Show empty rows</label>
        </div>
        {scopeOf(INVENTORY.view) === 'own' && <p className="muted-text">You see the stock of the locations you look after.</p>}
        {q.error && <Notice>{q.error}</Notice>}
        {q.loading && !q.data ? <Loading /> : !q.data?.items.length ? <Empty title="No stock" text="Stock appears here once goods are received." /> : <>
          <div className="table-wrap"><table><thead><tr><th>ITEM</th><th>LOCATION</th><th>BATCH</th><th className="num">ON HAND</th><th className="num">RESERVED</th>
            <th className="num">AVAILABLE</th><th className="num">AVG COST</th><th className="num">VALUE</th></tr></thead>
            <tbody>{q.data.items.map((r) => <tr key={`${r.item.publicId}-${r.location.publicId}-${r.batch?.batchNo ?? ''}`}>
              <td><b>{r.item.code}</b> {r.item.name}<small className="sub">{r.company}</small></td>
              <td>{r.location.code}<small className="sub">{r.location.name}</small></td>
              <td>{r.batch ? <>{r.batch.batchNo}{r.batch.expiryDate && <small className="sub">expires {dayLabel(r.batch.expiryDate)}</small>}</> : '—'}</td>
              <td className="num qty">{qty(r.onHand)} {r.unit.code}</td>
              <td className="num qty">{r.reserved ? `${qty(r.reserved)} ${r.unit.code}` : '—'}</td>
              <td className="num qty"><b>{qty(r.available)} {r.unit.code}</b></td>
              <td className="num">{money(r.avgCostMinor)}</td>
              <td className="num">{money(r.valueMinor)}</td></tr>)}</tbody></table></div>
          <p className="muted-text">Value of the rows on this page: <b>{money(pageValue)}</b></p>
          <Pager page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} /></>}
      </div>
    </Panel>
  </>;
}
