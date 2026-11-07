import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AccountsAccess, DraftLedgerMapRequest, JournalEntriesQuery, JournalEntry, JournalEntryPage, LedgerMapEntry, LedgerMapQuery, NewPostingRuleRequest,
  Period, PeriodRequest, PeriodsQuery, PostingEvent, PostingRule, PostingRulesQuery, ReopenRequest, ReverseEntryRequest,
} from '@ageless/shared';
import { DB, Db, Tx, databaseMessage, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext, isManagement } from '../../../platform/http/request-context';
import { todayIst } from '../../../platform/time';
import { CoreFacade } from '../../core/core.facade';
import { AccountsRepository, EntryRow, NewEntry } from '../infrastructure/accounts.repository';
import { DEFAULT_RULES, Line, ruleInForce, isFixedKey, reverseLines, unbalanced } from '../domain/ledger';
import { ACCOUNTS } from '../domain/permissions';

const EVENTS = Object.keys(DEFAULT_RULES) as PostingEvent[];
const person = (publicId: string | null, displayName: string | null) => (publicId && displayName ? { publicId, displayName } : null);

/** What the other modules hand over to be posted as one journal entry. */
export interface PostEntry {
  tenantId: number; legalEntityId: number; sourceType: PostingEvent; sourcePublicId: string;
  entryDate: string; lines: Line[]; description?: string; createdBy: number | null;
}

/**
 * Use cases live here. The books: months that can be closed, the rules that say which ledgers an event touches, the
 * append-only journal (one balanced entry per source document) and the map from ledger keys to Tally ledger names.
 * Maker (executive) drafts, checker (manager) approves; until they exist the policy accounts.interim_roles lets HR make
 * and the CEO check. Nobody approves their own draft.
 */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AccountsRepository) private readonly repo: AccountsRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  health() { return { module: 'accounts', ok: true }; }

  // ---- who may do what ----

  /** The caller's role in Accounts for a company (null: the group). MFA is not enforced yet: the platform has no second factor. */
  async access(ctx: RequestContext, companyId: number | null): Promise<AccountsAccess> {
    const interim = await this.core.getPolicy(ctx.tenantId, 'accounts.interim_roles', companyId, todayIst());
    const roles = await this.core.rolesOf(ctx.tenantId, ctx.personId);
    const maker = ctx.permissions[ACCOUNTS.make] === 'all' || roles.some((r) => interim.maker.includes(r));
    const checker = ctx.permissions[ACCOUNTS.check] === 'all' || roles.some((r) => interim.checker.includes(r));
    const ceo = isManagement(ctx);
    return { maker, checker, ceo, view: maker || checker || ceo || ctx.permissions[ACCOUNTS.view] === 'all' };
  }

  async myAccess(ctx: RequestContext, companyCode?: string): Promise<AccountsAccess> {
    return this.access(ctx, companyCode ? (await this.company(ctx, companyCode)).id : null);
  }

  private async require(ctx: RequestContext, companyId: number | null, who: keyof AccountsAccess | 'makerOrChecker'): Promise<AccountsAccess> {
    const a = await this.access(ctx, companyId);
    const ok = who === 'makerOrChecker' ? a.maker || a.checker : a[who];
    if (!ok) {
      const need = { maker: 'an Accounts maker', checker: 'an Accounts checker', makerOrChecker: 'an Accounts maker or checker', ceo: 'the CEO', view: 'an Accounts role' }[who];
      throw new AppError('FORBIDDEN', 403, `This needs ${need}`);
    }
    return a;
  }

  private async company(ctx: RequestContext, code: string) {
    const c = await this.repo.findCompany(ctx.tenantId, code);
    if (!c) throw new AppError('NOT_FOUND', 404, `No company ${code}`);
    return c;
  }

  /** Runs a use case in one transaction; turns the database's own accounting rules into clear errors. */
  private async atomic<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(fn);
    } catch (err) {
      const msg = databaseMessage(err) ?? '';
      if (msg.startsWith('ACCOUNTS_PERIOD_CLOSED')) throw new AppError('ACCOUNTS_PERIOD_CLOSED', 409, 'That month is closed; nothing can be posted into it');
      if (msg.startsWith('ACCOUNTS_UNBALANCED')) throw new AppError('ACCOUNTS_UNBALANCED', 400, 'Debits and credits of the entry differ');
      throw err;
    }
  }

  // ---- periods ----

  async periods(ctx: RequestContext, q: PeriodsQuery): Promise<Period[]> {
    const c = await this.company(ctx, q.company);
    await this.require(ctx, c.id, 'view');
    const stored = new Map((await this.repo.periodsOf(c.id, q.year)).map((p) => [p.month, p]));
    return Array.from({ length: 12 }, (_, i) => {
      const p = stored.get(i + 1);
      return {
        publicId: p?.publicId ?? null, company: c.code, year: q.year, month: i + 1, state: (p?.state ?? 'open') as Period['state'],
        closedBy: person(p?.closedByPublicId ?? null, p?.closedByName ?? null), closedAt: p?.closedAt?.toISOString() ?? null,
        reopenRequestedBy: person(p?.reopenByPublicId ?? null, p?.reopenByName ?? null), reopenRequestedAt: p?.reopenRequestedAt?.toISOString() ?? null,
        reopenReason: p?.reopenReason ?? null,
      };
    });
  }

  private async onePeriod(ctx: RequestContext, c: { id: number; code: string }, year: number, month: number): Promise<Period> {
    return (await this.periods(ctx, { company: c.code, year })).find((p) => p.month === month)!;
  }

  /** Checker: no more routine postings are expected; a soft-closed month still accepts entries. Asking again changes nothing. */
  async softClose(ctx: RequestContext, req: PeriodRequest): Promise<Period> {
    const c = await this.company(ctx, req.company);
    await this.require(ctx, c.id, 'checker');
    await this.atomic(async (tx) => {
      const p = await this.repo.createPeriod(tx, { tenantId: ctx.tenantId, legalEntityId: c.id, year: req.year, month: req.month });
      if (p.state === 'closed') throw new AppError('ACCOUNTS_PERIOD_CLOSED', 409, 'That month is already closed');
      if (p.state === 'soft_closed') return;
      await this.repo.updatePeriod(tx, p.id, { state: 'soft_closed' });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.period_soft_closed', entity: 'accounts_period',
        entityPublicId: p.publicId, legalEntityId: c.id, summary: `Soft-closed ${monthLabel(req.year, req.month)} for ${c.code}` });
    });
    return this.onePeriod(ctx, c, req.year, req.month);
  }

  /** Checker: nothing more can be posted into the month. Asking again changes nothing. */
  async close(ctx: RequestContext, req: PeriodRequest): Promise<Period> {
    const c = await this.company(ctx, req.company);
    await this.require(ctx, c.id, 'checker');
    await this.atomic(async (tx) => {
      const p = await this.repo.createPeriod(tx, { tenantId: ctx.tenantId, legalEntityId: c.id, year: req.year, month: req.month });
      if (p.state === 'closed') return;
      await this.repo.updatePeriod(tx, p.id, { state: 'closed', closedBy: ctx.personId, closedAt: new Date(),
        reopenRequestedBy: null, reopenRequestedAt: null, reopenReason: null });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.period_closed', entity: 'accounts_period',
        entityPublicId: p.publicId, legalEntityId: c.id, summary: `Closed ${monthLabel(req.year, req.month)} for ${c.code}` });
    });
    return this.onePeriod(ctx, c, req.year, req.month);
  }

  /** Reopening takes two people: the accounts manager (or maker) asks with a reason, then the CEO approves (never the same person). */
  async requestReopen(ctx: RequestContext, req: ReopenRequest): Promise<Period> {
    const c = await this.company(ctx, req.company);
    await this.require(ctx, c.id, 'makerOrChecker');
    await this.atomic(async (tx) => {
      const p = await this.repo.lockPeriod(tx, c.id, req.year, req.month);
      if (!p || p.state !== 'closed') throw new AppError('ACCOUNTS_PERIOD_NOT_CLOSED', 409, 'Only a closed month can be reopened');
      await this.repo.updatePeriod(tx, p.id, { reopenRequestedBy: ctx.personId, reopenRequestedAt: new Date(), reopenReason: req.reason });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.period_reopen_requested', entity: 'accounts_period',
        entityPublicId: p.publicId, legalEntityId: c.id, summary: `Asked to reopen ${monthLabel(req.year, req.month)} for ${c.code}`, details: { reason: req.reason } });
    });
    return this.onePeriod(ctx, c, req.year, req.month);
  }

  async approveReopen(ctx: RequestContext, req: PeriodRequest): Promise<Period> {
    const c = await this.company(ctx, req.company);
    await this.require(ctx, c.id, 'ceo');
    await this.atomic(async (tx) => {
      const p = await this.repo.lockPeriod(tx, c.id, req.year, req.month);
      if (!p || p.state !== 'closed') throw new AppError('ACCOUNTS_PERIOD_NOT_CLOSED', 409, 'Only a closed month can be reopened');
      if (!p.reopenRequestedBy) throw new AppError('ACCOUNTS_REOPEN_NOT_REQUESTED', 409, 'Nobody has asked to reopen this month yet');
      if (p.reopenRequestedBy === ctx.personId) throw new AppError('ACCOUNTS_SELF_APPROVAL', 403, 'Someone else must approve your request');
      await this.repo.updatePeriod(tx, p.id, { state: 'open', closedBy: null, closedAt: null, reopenRequestedBy: null, reopenRequestedAt: null, reopenReason: null });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.period_reopened', entity: 'accounts_period',
        entityPublicId: p.publicId, legalEntityId: c.id, summary: `Reopened ${monthLabel(req.year, req.month)} for ${c.code}`, details: { reason: p.reopenReason } });
    });
    return this.onePeriod(ctx, c, req.year, req.month);
  }

  // ---- posting rules ----

  /** The rule in force today for each event (a stored version, or the built-in default). */
  async postingRules(ctx: RequestContext, q: PostingRulesQuery): Promise<PostingRule[]> {
    const c = q.company ? await this.company(ctx, q.company) : null;
    await this.require(ctx, c?.id ?? null, 'view');
    const stored = await this.repo.storedRules(ctx.tenantId);
    const today = todayIst();
    const out: PostingRule[] = [];
    for (const event of EVENTS) {
      const { rule, stored: s } = ruleInForce(stored, c?.id ?? -1, event, today);
      const publicId = s ? await this.repo.publicIdOfRule(ctx.tenantId, s.companyId, event, s.version) : undefined;
      out.push({ publicId: publicId ?? null, company: s ? (s.companyId === null ? null : c?.code ?? null) : null, eventType: event, debitLedgerKey: rule.debitLedgerKey,
        creditLedgerKey: rule.creditLedgerKey, deductionLedgerKey: rule.deductionLedgerKey, version: s?.version ?? 0, effectiveFrom: s?.effectiveFrom ?? null,
        source: s ? 'stored' : 'default' });
    }
    return out;
  }

  /** A new version of a rule (never an edit). Checker only. The same publicId again: nothing new. */
  async addPostingRule(ctx: RequestContext, req: NewPostingRuleRequest): Promise<{ rule: PostingRule; created: boolean }> {
    const c = req.company ? await this.company(ctx, req.company) : null;
    await this.require(ctx, c?.id ?? null, 'checker');
    if (req.debitLedgerKey === req.creditLedgerKey) throw new AppError('ACCOUNTS_RULE_INVALID', 400, 'Debit and credit ledgers must differ');
    if (req.deductionLedgerKey && req.eventType !== 'payroll_approved') throw new AppError('ACCOUNTS_RULE_INVALID', 400, 'Only payroll_approved has a deduction ledger');
    const publicId = req.publicId ?? randomUUID();
    if (req.publicId) {
      const found = await this.repo.findRule(req.publicId);
      if (found && found.tenantId !== ctx.tenantId) throw new AppError('ACCOUNTS_DUPLICATE_ID', 409, 'This publicId is already used');
      if (found) return { rule: await this.ruleByPublicId(ctx, publicId, c?.code), created: false };
    }
    await this.atomic(async (tx) => {
      const version = await this.repo.nextRuleVersion(tx, ctx.tenantId, c?.id ?? null, req.eventType);
      await this.repo.insertRule(tx, { tenantId: ctx.tenantId, publicId, legalEntityId: c?.id ?? null, eventType: req.eventType, debitLedgerKey: req.debitLedgerKey,
        creditLedgerKey: req.creditLedgerKey, deductionLedgerKey: req.deductionLedgerKey ?? null, version, effectiveFrom: req.effectiveFrom, createdBy: ctx.personId });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.posting_rule_added', entity: 'accounts_posting_rule',
        entityPublicId: publicId, legalEntityId: c?.id ?? null, summary: `New posting rule version for ${req.eventType}` });
    });
    return { rule: await this.ruleByPublicId(ctx, publicId, c?.code), created: true };
  }

  private async ruleByPublicId(ctx: RequestContext, publicId: string, company?: string): Promise<PostingRule> {
    const r = (await this.repo.storedRulesWithIds(ctx.tenantId)).find((x) => x.publicId === publicId)!;
    return { publicId: r.publicId, company: company ?? null, eventType: r.eventType as PostingEvent, debitLedgerKey: r.debitLedgerKey, creditLedgerKey: r.creditLedgerKey,
      deductionLedgerKey: r.deductionLedgerKey, version: r.version, effectiveFrom: r.effectiveFrom, source: 'stored' };
  }

  // ---- journal entries ----

  async entries(ctx: RequestContext, q: JournalEntriesQuery): Promise<JournalEntryPage> {
    const c = q.company ? await this.company(ctx, q.company) : null;
    await this.require(ctx, c?.id ?? null, 'view');
    const { rows, total } = await this.repo.entries(ctx.tenantId, { legalEntityId: c?.id, from: q.from, to: q.to, sourceType: q.sourceType, ledgerKey: q.ledgerKey }, q.page, q.pageSize);
    const lines = await this.repo.linesOf(this.db, rows.map((r) => r.id));
    return { items: rows.map((r) => toEntry(r, lines.get(r.id) ?? [])), total, page: q.page, pageSize: q.pageSize };
  }

  async entry(ctx: RequestContext, publicId: string): Promise<JournalEntry> {
    await this.require(ctx, null, 'view');
    return this.oneEntry(ctx.tenantId, { publicId });
  }

  async entryBySource(ctx: RequestContext, sourceType: string, sourcePublicId: string): Promise<JournalEntry> {
    await this.require(ctx, null, 'view');
    return this.oneEntry(ctx.tenantId, { source: { type: sourceType, publicId: sourcePublicId } });
  }

  private async oneEntry(tenantId: number, where: Parameters<AccountsRepository['entryBy']>[2], conn: Db | Tx = this.db): Promise<JournalEntry> {
    const row = await this.repo.entryBy(conn, tenantId, where);
    if (!row) throw new AppError('NOT_FOUND', 404, 'No such journal entry');
    return toEntry(row, (await this.repo.linesOf(conn, [row.id])).get(row.id) ?? []);
  }

  /**
   * The only way an entry is written: other modules call this through AccountsFacade with their own transaction.
   * One entry per source document: posting the same source again returns the stored entry. Refused in a closed month.
   */
  async post(tx: Tx, p: PostEntry): Promise<{ publicId: string; created: boolean }> {
    const problem = unbalanced(p.lines);
    if (problem) throw new AppError('ACCOUNTS_UNBALANCED', 400, problem);
    const existing = await this.repo.entryBy(tx, p.tenantId, { source: { legalEntityId: p.legalEntityId, type: p.sourceType, publicId: p.sourcePublicId } });
    if (existing) return { publicId: existing.publicId, created: false };
    try {
      const row = await this.repo.insertEntry(tx, { ...p });
      return { publicId: row.publicId, created: true };
    } catch (err) {
      if (databaseMessage(err)?.startsWith('ACCOUNTS_PERIOD_CLOSED')) throw new AppError('ACCOUNTS_PERIOD_CLOSED', 409, 'That month is closed; nothing can be posted into it');
      if (violatedConstraint(err) === 'journal_entries_source_unique') throw new AppError('ACCOUNTS_DUPLICATE_ENTRY', 409, 'This source document already has an entry');
      throw err;
    }
  }

  /** A correction: a new entry dated today that undoes an earlier one. Once per entry; a reversal is never itself reversed. */
  async reverse(tx: Tx, tenantId: number, entryPublicId: string, by: number | null, reason: string): Promise<{ publicId: string; created: boolean }> {
    const original = await this.repo.entryBy(tx, tenantId, { publicId: entryPublicId });
    if (!original) throw new AppError('NOT_FOUND', 404, 'No such journal entry');
    if (original.sourceType === 'reversal') throw new AppError('ACCOUNTS_CANNOT_REVERSE_REVERSAL', 409, 'A reversing entry cannot be reversed; post a new entry instead');
    const prior = await this.repo.entryBy(tx, tenantId, { source: { legalEntityId: original.legalEntityId, type: 'reversal', publicId: original.publicId } });
    if (prior) return { publicId: prior.publicId, created: false };
    const lines = (await this.repo.linesOf(tx, [original.id])).get(original.id) ?? [];
    const done = await this.repo.insertEntry(tx, { tenantId, legalEntityId: original.legalEntityId, sourceType: 'reversal', sourcePublicId: original.publicId,
      entryDate: todayIst(), description: `Reversal: ${reason}`, reversesEntryId: original.id, createdBy: by, lines: reverseLines(lines) });
    return { publicId: done.publicId, created: true };
  }

  /** POST /journal-entries/:publicId/reverse — checker only. Asking again answers the existing reversal. */
  async reverseEntry(ctx: RequestContext, publicId: string, req: ReverseEntryRequest): Promise<{ entry: JournalEntry; created: boolean }> {
    await this.require(ctx, null, 'checker');
    const result = await this.atomic(async (tx) => {
      const r = await this.reverse(tx, ctx.tenantId, publicId, ctx.personId, req.reason);
      if (r.created) {
        const e = await this.repo.entryBy(tx, ctx.tenantId, { publicId });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.entry_reversed', entity: 'journal_entry',
          entityPublicId: publicId, legalEntityId: e?.legalEntityId, summary: 'Reversed a journal entry', details: { reason: req.reason } });
      }
      return r;
    });
    return { entry: await this.oneEntry(ctx.tenantId, { publicId: result.publicId }), created: result.created };
  }

  // ---- Tally ledger map ----

  /** Stored mappings, plus the ledger keys that are used (by a posting rule or an entry) and have none yet. */
  async ledgerMap(ctx: RequestContext, q: LedgerMapQuery): Promise<LedgerMapEntry[]> {
    const c = await this.company(ctx, q.company);
    await this.require(ctx, c.id, 'view');
    const stored = await this.repo.ledgerMap(c.id);
    const out: LedgerMapEntry[] = stored.map((m) => ({
      publicId: m.publicId, company: c.code, ledgerKey: m.ledgerKey, tallyCompany: m.tallyCompany, tallyLedgerName: m.tallyLedgerName, state: m.state as 'draft' | 'approved',
      draftedBy: person(m.makerPublicId, m.makerName), approvedBy: person(m.checkerPublicId, m.checkerName), approvedAt: m.approvedAt?.toISOString() ?? null,
    }));
    const rules = await this.postingRules(ctx, { company: c.code });
    const wanted = new Set<string>([...(await this.repo.usedLedgerKeys(c.id))]);
    for (const r of rules) for (const k of [r.debitLedgerKey, r.creditLedgerKey]) if (isFixedKey(k)) wanted.add(k);
    const have = new Set(out.map((m) => m.ledgerKey));
    const missing: LedgerMapEntry[] = [...wanted].filter((k) => !have.has(k)).sort().map((ledgerKey) => ({
      publicId: null, company: c.code, ledgerKey, tallyCompany: null, tallyLedgerName: null, state: 'unmapped', draftedBy: null, approvedBy: null, approvedAt: null }));
    return [...missing, ...out];
  }

  /** The maker drafts a mapping. Changing an approved one withdraws its approval until the checker approves again. */
  async draftLedgerMap(ctx: RequestContext, req: DraftLedgerMapRequest): Promise<{ entry: LedgerMapEntry; created: boolean }> {
    const c = await this.company(ctx, req.company);
    await this.require(ctx, c.id, 'maker');
    if (req.publicId) {
      const found = await this.repo.mapTenantOf(req.publicId);
      if (found && found.tenantId !== ctx.tenantId) throw new AppError('ACCOUNTS_DUPLICATE_ID', 409, 'This publicId is already used');
      if (found) return { entry: await this.mapEntry(ctx, c.code, req.ledgerKey), created: false };
    }
    const created = await this.atomic(async (tx) => {
      const existing = await this.repo.lockMapByKey(tx, c.id, req.ledgerKey);
      if (!existing) {
        await this.repo.insertMap(tx, { tenantId: ctx.tenantId, publicId: req.publicId ?? randomUUID(), legalEntityId: c.id, ledgerKey: req.ledgerKey,
          tallyCompany: req.tallyCompany, tallyLedgerName: req.tallyLedgerName, draftedBy: ctx.personId });
        return true;
      }
      if (existing.tallyCompany === req.tallyCompany && existing.tallyLedgerName === req.tallyLedgerName) return false;
      await this.repo.updateMap(tx, existing.id, { tallyCompany: req.tallyCompany, tallyLedgerName: req.tallyLedgerName, state: 'draft',
        draftedBy: ctx.personId, draftedAt: new Date(), approvedBy: null, approvedAt: null });
      return false;
    });
    return { entry: await this.mapEntry(ctx, c.code, req.ledgerKey), created };
  }

  /** The checker approves a draft someone else made. Approving an approved mapping changes nothing. */
  async approveLedgerMap(ctx: RequestContext, publicId: string): Promise<LedgerMapEntry> {
    const found = await this.repo.mapTenantOf(publicId);
    if (!found || found.tenantId !== ctx.tenantId) throw new AppError('NOT_FOUND', 404, 'No such mapping');
    await this.require(ctx, found.legalEntityId, 'checker');
    const key = await this.atomic(async (tx) => {
      const m = await this.repo.lockMapByPublicId(tx, ctx.tenantId, publicId);
      if (!m) throw new AppError('NOT_FOUND', 404, 'No such mapping');
      if (m.state === 'approved') return m;
      if (m.draftedBy === ctx.personId) throw new AppError('ACCOUNTS_SELF_APPROVAL', 403, 'Someone else must approve what you drafted');
      await this.repo.updateMap(tx, m.id, { state: 'approved', approvedBy: ctx.personId, approvedAt: new Date() });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'accounts.ledger_map_approved', entity: 'tally_ledger_map',
        entityPublicId: publicId, legalEntityId: m.legalEntityId, summary: `Approved the Tally ledger for ${m.ledgerKey}` });
      return m;
    });
    return this.mapEntry(ctx, (await this.repo.companyCodeOf(ctx.tenantId, key.legalEntityId))!, key.ledgerKey);
  }

  private async mapEntry(ctx: RequestContext, company: string, ledgerKey: string): Promise<LedgerMapEntry> {
    return (await this.ledgerMap(ctx, { company })).find((m) => m.ledgerKey === ledgerKey)!;
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (year: number, month: number) => `${MONTHS[month - 1]} ${year}`;

function toEntry(r: EntryRow, lines: Line[]): JournalEntry {
  return {
    publicId: r.publicId, company: r.company, sourceType: r.sourceType as JournalEntry['sourceType'], sourcePublicId: r.sourcePublicId, entryDate: r.entryDate,
    currency: r.currency, description: r.description, reversesPublicId: r.reversesPublicId, reversedByPublicId: r.reversedByPublicId, lines,
    totalDebitMinor: lines.reduce((s, l) => s + l.debitMinor, 0), totalCreditMinor: lines.reduce((s, l) => s + l.creditMinor, 0),
    createdBy: person(r.createdByPublicId, r.createdByName), createdAt: r.createdAt.toISOString(),
  };
}
