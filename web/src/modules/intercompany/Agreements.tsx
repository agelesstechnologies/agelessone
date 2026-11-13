import { useState, type FormEvent } from 'react';
import { ArrowLeft, Pencil, Plus } from 'lucide-react';
import {
  AddRateCardRequest, CreateAgreementRequest, UpdateAgreementRequest,
  type IcAgreement, type IcAgreementDetail, type IcRateCard,
} from '@ageless/shared';
import { api, errText, formError } from '../../api';
import { useAuth } from '../../auth';
import { dayLabel, rupees, todayIst, useLoad, uuidv7 } from '../../hooks';
import JobPicker from '../../JobPicker';
import { INTERCOMPANY } from '../../permissions';
import { Badge, Empty, Loading, Modal, Notice, Panel } from '../../ui';
import { AGREEMENT_TONE, COMPANIES, goIc, monthName, paiseInput, pct, PRICING_LABEL, SERVICE_LABEL, SERVICES, stampIst, toPaise } from './common';

const companyName = (code: string) => COMPANIES.find((c) => c.code === code)?.name ?? code;
const item = (c: { serviceType: string | null; grade: string | null }) => (c.serviceType ? SERVICE_LABEL[c.serviceType] ?? c.serviceType : `Grade ${c.grade}`);

/** The rate in force today for each service type and grade: the newest one that has started (rows come newest first). */
export function inForce(cards: IcRateCard[], on: string): Set<string> {
  const seen = new Map<string, IcRateCard>();
  for (const c of cards) {
    const k = c.serviceType ?? `grade:${c.grade}`;
    const best = seen.get(k);
    if (c.effectiveFrom <= on && (!best || c.effectiveFrom > best.effectiveFrom)) seen.set(k, c);
  }
  return new Set([...seen.values()].map((c) => c.publicId));
}

// ---------------- list ----------------

export function AgreementList() {
  const { can } = useAuth();
  const manages = can(INTERCOMPANY.manage);
  const q = useLoad(() => api<IcAgreement[]>('/intercompany/agreements'));
  const [creating, setCreating] = useState(false);
  return <Panel title="Agreements" note="What one company of the group provides to another, and how it is priced. You see the agreements you head; the CEO sees all."
    action={manages ? <button className="primary-btn" onClick={() => setCreating(true)}><Plus size={16} /> New agreement</button> : undefined}>
    <div className="panel-body">
      {q.error && <Notice>{q.error}</Notice>}
      {q.loading && !q.data ? <Loading /> : !q.data?.length ? <Empty title="No agreements" text={manages ? 'Draft the first agreement with New agreement.' : 'Agreements that name you as a company head appear here.'} /> :
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>COMPANIES</th><th>SERVICES</th><th>PRICING</th><th>FROM</th><th>STATUS</th><th>HEADS</th></tr></thead>
          <tbody>{q.data.map((a) => <tr key={a.publicId} className="link-row" onClick={() => goIc('agreements', a.publicId)}>
            <td><b>{a.provider.company} → {a.receiver.company}</b><small className="sub">{a.provider.companyName} for {a.receiver.companyName}</small></td>
            <td>{a.services.map((s) => SERVICE_LABEL[s]).join(', ')}</td>
            <td>{PRICING_LABEL[a.pricingMethod]}{a.pricingMethod === 'cost_plus' && ` + ${pct(a.costPlusPercent)}`}</td>
            <td>{dayLabel(a.startDate)}{a.endDate && <small className="sub">to {dayLabel(a.endDate)}</small>}</td>
            <td><Badge tone={AGREEMENT_TONE[a.status] ?? 'gray'}>{a.status}</Badge></td>
            <td>{a.provider.head.person.displayName}<small className="sub">{a.receiver.head.person.displayName}</small></td>
          </tr>)}</tbody></table></div>}
    </div>
    {creating && <NewAgreement onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); goIc('agreements', id); }} />}
  </Panel>;
}

// ---------------- one agreement ----------------

export function AgreementPage({ id }: { id: string }) {
  const { can } = useAuth();
  const manages = can(INTERCOMPANY.manage);
  const q = useLoad(() => api<IcAgreementDetail>(`/intercompany/agreements/${id}`), [id]);
  const [dialog, setDialog] = useState<'edit' | 'end' | 'rate' | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const a = q.data;

  async function patch(json: unknown, done: string) {
    setBusy(true); setError(''); setNote('');
    try { q.setData(await api<IcAgreementDetail>(`/intercompany/agreements/${id}`, { method: 'PATCH', json })); setDialog(null); setNote(done); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  }

  const back = <button className="outline-btn" onClick={() => goIc('agreements')}><ArrowLeft size={14} /> Agreements</button>;
  if (!a) return <Panel title="Agreement" action={back}><div className="panel-body">{q.error ? <Notice>{q.error}</Notice> : <Loading />}</div></Panel>;
  const live = a.status !== 'ended';
  const today = todayIst();
  const current = inForce(a.rateCards, today);

  return <>
    <Panel title={`${a.provider.company} → ${a.receiver.company}`} note={`${a.provider.companyName} provides to ${a.receiver.companyName}`}
      action={<div className="row-actions">{back}
        {manages && live && <button className="outline-btn" onClick={() => setDialog('edit')}><Pencil size={13} /> Edit terms</button>}
        {manages && a.status === 'draft' && <button className="primary-btn" disabled={busy} onClick={() => void patch({ status: 'active' }, 'The agreement is active.')}>Activate</button>}
        {manages && live && <button className="danger-btn" onClick={() => setDialog('end')}>{a.status === 'draft' ? 'Drop draft' : 'End agreement'}</button>}
      </div>}>
      <div className="panel-body">
        {error && <Notice onClose={() => setError('')}>{error}</Notice>}
        {note && <Notice tone="ok" onClose={() => setNote('')}>{note}</Notice>}
        <div className="kv-grid">
          <span>Status</span><b><Badge tone={AGREEMENT_TONE[a.status] ?? 'gray'}>{a.status}</Badge></b>
          <span>Dates</span><b>{dayLabel(a.startDate)}{a.endDate ? ` to ${dayLabel(a.endDate)}` : ' onwards'}</b>
          <span>Services</span><b>{a.services.map((s) => SERVICE_LABEL[s]).join(', ')}</b>
          <span>Pricing</span><b>{a.pricingMethod === 'cost_plus' ? `Cost plus ${pct(a.costPlusPercent)} (cost per hour from payroll)` : 'Rate card (hourly rates below)'}</b>
          <span>Costs passed on</span><b>{a.passedCostHandling === 'percent' ? `At cost plus ${pct(a.passedCostPercent)}` : 'At cost'} · counted only with the bill attached</b>
          <span>Review</span><b>{a.reviewDays} days for the receiver to accept or dispute a statement</b>
          <span>Payment</span><b>Within {a.paymentTermsDays} days of the invoice</b>
          <span>Billed months</span><b>{a.billedMonths.length ? a.billedMonths.map((m) => monthName(m.year, m.month)).join(', ') : 'None yet'}</b>
        </div>
      </div>
    </Panel>

    <Panel title="Approvers and heads" note="The two company heads see this agreement; the approvers (with the heads) review statements.">
      <div className="panel-body">
        <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>SIDE</th><th>COMPANY</th><th>HEAD</th><th>APPROVER</th></tr></thead>
          <tbody>{(['provider', 'receiver'] as const).map((side) => <tr key={side}>
            <td><Badge tone={side === 'provider' ? 'blue' : 'amber'}>{side === 'provider' ? 'Provider (bills)' : 'Receiver (pays)'}</Badge></td>
            <td>{a[side].companyName}</td><td>{a[side].head.person.displayName}</td><td>{a[side].approver.person.displayName}</td></tr>)}</tbody></table></div>
        <p className="muted-text">Changed {a.updatedAt ? `${stampIst(a.updatedAt)} by ${a.updatedBy?.displayName}` : 'never'} · drafted {stampIst(a.createdAt)} by {a.createdBy.displayName}</p>
      </div>
    </Panel>

    <Panel title="Rate card" note="Hourly rates by service type or grade. A new rate is a new row from its date; past months keep the rate in force then. CA to confirm."
      action={manages && live ? <button className="primary-btn" onClick={() => setDialog('rate')}><Plus size={16} /> New rate</button> : undefined}>
      <div className="panel-body">
        {!a.rateCards.length ? <Empty title="No rates yet" text={a.pricingMethod === 'rate_card' ? 'Statements need a rate in force for every service billed.' : 'Cost plus prices from payroll; rates are optional.'} /> : <>
          <div className="mini-h">In force today</div>
          <div className="chip-row">{a.rateCards.filter((c) => current.has(c.publicId)).map((c) =>
            <span key={c.publicId} className="ic-chip"><b>{item(c)}</b> {rupees(c.rateMinor)}/h <small>since {dayLabel(c.effectiveFrom)}</small></span>)}</div>
          <div className="mini-h">History</div>
          <div className="table-wrap"><table className="stack-mobile"><thead><tr><th>FOR</th><th>RATE PER HOUR</th><th>FROM</th><th>STATE</th><th>ADDED</th></tr></thead>
            <tbody>{a.rateCards.map((c) => <tr key={c.publicId}>
              <td>{item(c)}</td><td><b>{rupees(c.rateMinor)}</b></td><td>{dayLabel(c.effectiveFrom)}</td>
              <td>{current.has(c.publicId) ? <Badge tone="green">In force</Badge> : c.effectiveFrom > today ? <Badge tone="blue">From {dayLabel(c.effectiveFrom)}</Badge> : <Badge tone="gray">Replaced</Badge>}</td>
              <td>{c.createdBy.displayName}<small className="sub">{stampIst(c.createdAt)}</small></td></tr>)}</tbody></table></div></>}
      </div>
    </Panel>

    {dialog === 'edit' && <EditTerms a={a} onClose={() => setDialog(null)} onSaved={(d) => { q.setData(d); setDialog(null); setNote('Terms saved.'); }} />}
    {dialog === 'end' && <EndAgreement a={a} busy={busy} error={error} onClose={() => setDialog(null)} onEnd={(endDate) => void patch({ status: 'ended', endDate }, 'The agreement has ended.')} />}
    {dialog === 'rate' && <AddRate a={a} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setNote('Rate added.'); q.reload(); }} />}
  </>;
}

// ---------------- forms ----------------

function Services({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return <fieldset className="span-two check-row"><legend>Services covered</legend>
    {SERVICES.map((s) => <label key={s}><input type="checkbox" checked={value.includes(s)}
      onChange={(e) => onChange(e.target.checked ? [...value, s] : value.filter((x) => x !== s))} /> {SERVICE_LABEL[s]}</label>)}</fieldset>;
}

/** Pricing and passed-cost terms, shared by the new and edit forms. */
function Pricing({ f, set }: { f: TermsForm; set: (patch: Partial<TermsForm>) => void }) {
  return <>
    <label>Pricing<select id="ic-pricing" value={f.pricingMethod} onChange={(e) => set({ pricingMethod: e.target.value as TermsForm['pricingMethod'] })}>
      <option value="rate_card">Rate card (hourly rates)</option><option value="cost_plus">Cost plus (payroll cost + %)</option></select></label>
    {f.pricingMethod === 'cost_plus' ? <label>Cost plus %<input id="ic-cost-plus" inputMode="decimal" value={f.costPlusPercent} onChange={(e) => set({ costPlusPercent: e.target.value })} placeholder="e.g. 12.5" /></label> : <span />}
    <label>Costs passed on<select id="ic-passed" value={f.passedCostHandling} onChange={(e) => set({ passedCostHandling: e.target.value as TermsForm['passedCostHandling'] })}>
      <option value="at_cost">At cost</option><option value="percent">At cost plus %</option></select></label>
    {f.passedCostHandling === 'percent' ? <label>Plus %<input id="ic-passed-pct" inputMode="decimal" value={f.passedCostPercent} onChange={(e) => set({ passedCostPercent: e.target.value })} /></label> : <span />}
    <label>Review days<span className="optional">receiver accepts or disputes</span><input id="ic-review" inputMode="numeric" value={f.reviewDays} onChange={(e) => set({ reviewDays: e.target.value })} placeholder="5 (policy)" /></label>
    <label>Payment days<span className="optional">after the invoice</span><input id="ic-payment" inputMode="numeric" value={f.paymentTermsDays} onChange={(e) => set({ paymentTermsDays: e.target.value })} placeholder="30 (policy)" /></label>
  </>;
}

interface TermsForm {
  services: string[]; pricingMethod: 'rate_card' | 'cost_plus'; costPlusPercent: string; passedCostHandling: 'at_cost' | 'percent'; passedCostPercent: string;
  reviewDays: string; paymentTermsDays: string;
}
const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

function NewAgreement({ onClose, onSaved }: { onClose: () => void; onSaved: (publicId: string) => void }) {
  const [provider, setProvider] = useState('ATPL');
  const [receiver, setReceiver] = useState('AE');
  const [jobs, setJobs] = useState({ providerHead: '', providerApprover: '', receiverHead: '', receiverApprover: '' });
  const [f, setF] = useState<TermsForm>({ services: ['design'], pricingMethod: 'rate_card', costPlusPercent: '', passedCostHandling: 'at_cost', passedCostPercent: '', reviewDays: '', paymentTermsDays: '' });
  const [startDate, setStartDate] = useState(todayIst());
  const [publicId] = useState(uuidv7);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const job = (k: keyof typeof jobs) => (v: string) => setJobs((j) => ({ ...j, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = CreateAgreementRequest.safeParse({
      publicId, startDate, services: f.services, pricingMethod: f.pricingMethod, passedCostHandling: f.passedCostHandling,
      provider: { company: provider, headEmploymentPublicId: jobs.providerHead, approverEmploymentPublicId: jobs.providerApprover },
      receiver: { company: receiver, headEmploymentPublicId: jobs.receiverHead, approverEmploymentPublicId: jobs.receiverApprover },
      ...(f.pricingMethod === 'cost_plus' && { costPlusPercent: num(f.costPlusPercent) }),
      ...(f.passedCostHandling === 'percent' && { passedCostPercent: num(f.passedCostPercent) }),
      reviewDays: num(f.reviewDays), paymentTermsDays: num(f.paymentTermsDays),
    });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setSaving(true); setError('');
    try { onSaved((await api<IcAgreementDetail>('/intercompany/agreements', { method: 'POST', json: parsed.data })).publicId); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }

  return <Modal title="New agreement" subtitle="Drafted first; activate it when the rates are in." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>Provider (bills)<select id="ic-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <label>Receiver (pays)<select id="ic-receiver" value={receiver} onChange={(e) => setReceiver(e.target.value)}>{COMPANIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></label>
        <div key={`p-${provider}`} className="span-two form-grid">
          <JobPicker idPrefix="ic-ph" label={`${companyName(provider)}: head`} hint="sees the agreement" company={provider} onChange={job('providerHead')} />
          <JobPicker idPrefix="ic-pa" label={`${companyName(provider)}: approver`} company={provider} onChange={job('providerApprover')} />
        </div>
        <div key={`r-${receiver}`} className="span-two form-grid">
          <JobPicker idPrefix="ic-rh" label={`${companyName(receiver)}: head`} hint="sees the agreement" company={receiver} onChange={job('receiverHead')} />
          <JobPicker idPrefix="ic-ra" label={`${companyName(receiver)}: approver`} hint="accepts or disputes statements" company={receiver} onChange={job('receiverApprover')} />
        </div>
        <Services value={f.services} onChange={(services) => setF({ ...f, services })} />
        <Pricing f={f} set={(p) => setF({ ...f, ...p })} />
        <label className="span-two">Start date<input id="ic-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Draft agreement'}</button></div>
    </form>
  </Modal>;
}

function EditTerms({ a, onClose, onSaved }: { a: IcAgreementDetail; onClose: () => void; onSaved: (d: IcAgreementDetail) => void }) {
  const [f, setF] = useState<TermsForm>({ services: a.services, pricingMethod: a.pricingMethod, costPlusPercent: a.costPlusPercent?.toString() ?? '',
    passedCostHandling: a.passedCostHandling, passedCostPercent: a.passedCostPercent?.toString() ?? '', reviewDays: String(a.reviewDays), paymentTermsDays: String(a.paymentTermsDays) });
  const [jobs, setJobs] = useState({ providerHead: '', providerApprover: '', receiverHead: '', receiverApprover: '' });
  const [startDate, setStartDate] = useState(a.startDate);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const job = (k: keyof typeof jobs) => (v: string) => setJobs((j) => ({ ...j, [k]: v }));
  const billed = a.billedMonths.length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const terms = billed ? {} : {
      services: f.services, pricingMethod: f.pricingMethod, passedCostHandling: f.passedCostHandling,
      costPlusPercent: f.pricingMethod === 'cost_plus' ? num(f.costPlusPercent) : null,
      passedCostPercent: f.passedCostHandling === 'percent' ? num(f.passedCostPercent) : null,
    };
    const parsed = UpdateAgreementRequest.safeParse({
      ...terms, reviewDays: num(f.reviewDays), paymentTermsDays: num(f.paymentTermsDays),
      ...(a.status === 'draft' && startDate !== a.startDate && { startDate }),
      ...(jobs.providerHead && { providerHeadEmploymentPublicId: jobs.providerHead }), ...(jobs.providerApprover && { providerApproverEmploymentPublicId: jobs.providerApprover }),
      ...(jobs.receiverHead && { receiverHeadEmploymentPublicId: jobs.receiverHead }), ...(jobs.receiverApprover && { receiverApproverEmploymentPublicId: jobs.receiverApprover }),
    });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setSaving(true); setError('');
    try { onSaved(await api<IcAgreementDetail>(`/intercompany/agreements/${a.publicId}`, { method: 'PATCH', json: parsed.data })); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }

  return <Modal title="Edit terms" subtitle={billed ? 'Months are billed: the pricing stays as it is. End this agreement and start a new one to change it.' : 'Changes are audited.'} onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        {!billed && <><Services value={f.services} onChange={(services) => setF({ ...f, services })} /></>}
        {billed ? <>
          <label>Review days<input id="ic-review" inputMode="numeric" value={f.reviewDays} onChange={(e) => setF({ ...f, reviewDays: e.target.value })} /></label>
          <label>Payment days<input id="ic-payment" inputMode="numeric" value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: e.target.value })} /></label>
        </> : <Pricing f={f} set={(p) => setF({ ...f, ...p })} />}
        {a.status === 'draft' && <label className="span-two">Start date<input id="ic-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>}
        <p className="span-two muted-text">Leave a person empty to keep who is named now.</p>
        <JobPicker idPrefix="ic-eph" label={`${a.provider.company} head`} hint={`now ${a.provider.head.person.displayName}`} company={a.provider.company} onChange={job('providerHead')} />
        <JobPicker idPrefix="ic-epa" label={`${a.provider.company} approver`} hint={`now ${a.provider.approver.person.displayName}`} company={a.provider.company} onChange={job('providerApprover')} />
        <JobPicker idPrefix="ic-erh" label={`${a.receiver.company} head`} hint={`now ${a.receiver.head.person.displayName}`} company={a.receiver.company} onChange={job('receiverHead')} />
        <JobPicker idPrefix="ic-era" label={`${a.receiver.company} approver`} hint={`now ${a.receiver.approver.person.displayName}`} company={a.receiver.company} onChange={job('receiverApprover')} />
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></div>
    </form>
  </Modal>;
}

function EndAgreement({ a, busy, error, onClose, onEnd }: { a: IcAgreementDetail; busy: boolean; error: string; onClose: () => void; onEnd: (endDate: string) => void }) {
  const [endDate, setEndDate] = useState(todayIst() < a.startDate ? a.startDate : todayIst());
  return <Modal title={a.status === 'draft' ? 'Drop this draft?' : 'End this agreement?'} subtitle="An ended agreement no longer changes. Billed months stay as billed." onClose={onClose}>
    {error && <Notice>{error}</Notice>}
    <div className="form-grid"><label className="span-two">Last day<input id="ic-end" type="date" min={a.startDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label></div>
    <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Keep it</button>
      <button className="danger-btn" disabled={busy} onClick={() => onEnd(endDate)}>{a.status === 'draft' ? 'Drop draft' : 'End agreement'}</button></div>
  </Modal>;
}

function AddRate({ a, onClose, onSaved }: { a: IcAgreementDetail; onClose: () => void; onSaved: () => void }) {
  const [by, setBy] = useState<'service' | 'grade'>('service');
  const [serviceType, setServiceType] = useState(a.services[0] ?? 'design');
  const [grade, setGrade] = useState('');
  const [rate, setRate] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayIst());
  const [publicId] = useState(uuidv7);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const previous = a.rateCards.find((c) => (by === 'service' ? c.serviceType === serviceType : c.grade?.toLowerCase() === grade.trim().toLowerCase()));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const rateMinor = toPaise(rate);
    if (rateMinor === null) { setError('Enter the rate in rupees, e.g. 1500 or 1,500.50'); return; }
    const parsed = AddRateCardRequest.safeParse({ publicId, rateMinor, effectiveFrom, ...(by === 'service' ? { serviceType } : { grade }) });
    if (!parsed.success) { setError(formError(parsed.error)); return; }
    setSaving(true); setError('');
    try { await api<IcRateCard>(`/intercompany/agreements/${a.publicId}/rate-cards`, { method: 'POST', json: parsed.data }); onSaved(); }
    catch (err) { setError(errText(err)); }
    finally { setSaving(false); }
  }

  return <Modal title="New rate" subtitle="From its date on; earlier dates keep the rate in force then. A billed month is never reached back into." onClose={onClose}>
    <form onSubmit={submit}>
      {error && <Notice>{error}</Notice>}
      <div className="form-grid">
        <label>For<select id="ic-rate-by" value={by} onChange={(e) => setBy(e.target.value as 'service' | 'grade')}><option value="service">A service type</option><option value="grade">A grade (designation)</option></select></label>
        {by === 'service' ? <label>Service<select id="ic-rate-service" value={serviceType} onChange={(e) => setServiceType(e.target.value as typeof serviceType)}>
          {a.services.map((s) => <option key={s} value={s}>{SERVICE_LABEL[s]}</option>)}</select></label>
          : <label>Grade<span className="optional">the job's designation</span><input id="ic-rate-grade" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="e.g. Senior Designer" /></label>}
        <label>Rate per hour (₹)<input id="ic-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder={previous ? paiseInput(previous.rateMinor) : 'e.g. 1500'} /></label>
        <label>From<input id="ic-rate-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></label>
        {previous && <p className="span-two muted-text">Latest rate: {rupees(previous.rateMinor)}/h from {dayLabel(previous.effectiveFrom)}.</p>}
      </div>
      <div className="modal-foot"><button type="button" className="outline-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" disabled={saving}>{saving ? 'Saving…' : 'Add rate'}</button></div>
    </form>
  </Modal>;
}
