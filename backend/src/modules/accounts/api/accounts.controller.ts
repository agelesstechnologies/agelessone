import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  AccountsAccess, DraftLedgerMapRequest, JournalEntriesQuery, JournalEntry, JournalEntryPage, JournalSourceType, LedgerMapEntry, LedgerMapQuery,
  NewPostingRuleRequest, Period, PeriodRequest, PeriodsQuery, PostingRule, PostingRulesQuery, ReopenRequest, ReverseEntryRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Public, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { AccountsService } from '../application/accounts.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
const WHO = 'Accounts roles only (maker, checker, or HR/CEO while the interim policy accounts.interim_roles applies); others get 403.';
const CHECKER = 'Accounts checker only (the CEO while the interim policy applies); others get 403.';

/** Only: validate input, check permission, call one use case. */
@Controller('accounts')
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly service: AccountsService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  @Doc({ summary: 'What the caller may do in Accounts (maker, checker, CEO, view)', response: AccountsAccess,
    description: 'Use it to decide which Accounts screens and buttons to show. company is optional: the interim policy can differ per company.' })
  @SignedIn() @Get('access')
  access(@Ctx() ctx: RequestContext, @Query('company') company?: string) { return this.service.myAccess(ctx, company || undefined); }

  // ---- periods ----

  @Doc({ summary: 'The twelve months of a year with their state (a month nobody touched is open)', response: z.array(Period), description: WHO })
  @SignedIn() @Get('periods')
  periods(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PeriodsQuery)) q: PeriodsQuery) { return this.service.periods(ctx, q); }

  @Doc({ summary: 'Soft-close a month (entries are still accepted)', response: Period, description: CHECKER })
  @SignedIn() @Post('periods/soft-close')
  softClose(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(PeriodRequest)) body: PeriodRequest, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.softClose(ctx, body);
  }

  @Doc({ summary: 'Close a month: nothing more can be posted into it (ACCOUNTS_PERIOD_CLOSED)', response: Period, description: CHECKER })
  @SignedIn() @Post('periods/close')
  close(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(PeriodRequest)) body: PeriodRequest, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.close(ctx, body);
  }

  @Doc({ summary: 'Ask to reopen a closed month, with a reason', response: Period,
    description: 'Accounts maker or checker. The CEO then approves with periods/reopen-approve; nobody approves their own request.' })
  @SignedIn() @Post('periods/reopen-request')
  reopenRequest(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ReopenRequest)) body: ReopenRequest, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.requestReopen(ctx, body);
  }

  @Doc({ summary: 'Reopen a closed month once it has been asked for (CEO, not the person who asked)', response: Period, description: 'The CEO (Management) only; others get 403.' })
  @SignedIn() @Post('periods/reopen-approve')
  reopenApprove(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(PeriodRequest)) body: PeriodRequest, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.approveReopen(ctx, body);
  }

  // ---- posting rules ----

  @Doc({ summary: 'The posting rule in force today for every event (stored version or built-in default)', response: z.array(PostingRule), description: WHO })
  @SignedIn() @Get('posting-rules')
  postingRules(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PostingRulesQuery)) q: PostingRulesQuery) { return this.service.postingRules(ctx, q); }

  @Doc({ summary: 'A new version of a posting rule (never an edit)', response: PostingRule, resend: true, description: CHECKER })
  @SignedIn() @Post('posting-rules')
  async addPostingRule(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(NewPostingRuleRequest)) body: NewPostingRuleRequest, @Res({ passthrough: true }) res: Created) {
    const { rule, created } = await this.service.addPostingRule(ctx, body);
    if (!created) res.status(200);
    return rule;
  }

  // ---- journal entries ----

  @Doc({ summary: 'Journal entries, newest first, with their lines and totals', response: JournalEntryPage, description: WHO })
  @SignedIn() @Get('journal-entries')
  entries(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(JournalEntriesQuery)) q: JournalEntriesQuery) { return this.service.entries(ctx, q); }

  @Doc({ summary: 'The entry written for a source document (an expense, a payroll run ...)', response: JournalEntry, description: WHO })
  @SignedIn() @Get('journal-entries/by-source/:sourceType/:sourcePublicId')
  bySource(@Ctx() ctx: RequestContext, @Param('sourceType', new ZodValidationPipe(JournalSourceType)) sourceType: string,
    @Param('sourcePublicId', PublicIdParam) sourcePublicId: string) {
    return this.service.entryBySource(ctx, sourceType, sourcePublicId);
  }

  @Doc({ summary: 'One journal entry', response: JournalEntry, description: WHO })
  @SignedIn() @Get('journal-entries/:publicId')
  entry(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) { return this.service.entry(ctx, publicId); }

  @Doc({ summary: 'Correct an entry by posting its reversal (once per entry; a reversal is never reversed)', response: JournalEntry, description: CHECKER,
    resend: true })
  @SignedIn() @Post('journal-entries/:publicId/reverse')
  async reverse(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ReverseEntryRequest)) body: ReverseEntryRequest, @Res({ passthrough: true }) res: Created) {
    const { entry, created } = await this.service.reverseEntry(ctx, publicId, body);
    if (!created) res.status(200);
    return entry;
  }

  // ---- Tally ledger map ----

  @Doc({ summary: 'Ledger keys with their Tally ledger; keys in use with no mapping come first as unmapped', response: z.array(LedgerMapEntry), description: WHO })
  @SignedIn() @Get('ledger-map')
  ledgerMap(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(LedgerMapQuery)) q: LedgerMapQuery) { return this.service.ledgerMap(ctx, q); }

  @Doc({ summary: 'Draft (or change) the Tally ledger of a key', response: LedgerMapEntry, resend: true,
    description: 'Accounts maker only. Changing an approved mapping makes it a draft again until the checker approves.' })
  @SignedIn() @Post('ledger-map')
  async draftLedgerMap(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(DraftLedgerMapRequest)) body: DraftLedgerMapRequest, @Res({ passthrough: true }) res: Created) {
    const { entry, created } = await this.service.draftLedgerMap(ctx, body);
    if (!created) res.status(200);
    return entry;
  }

  @Doc({ summary: 'Approve a drafted mapping (not your own draft: ACCOUNTS_SELF_APPROVAL)', response: LedgerMapEntry, description: CHECKER })
  @SignedIn() @Post('ledger-map/:publicId/approve')
  approveLedgerMap(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.approveLedgerMap(ctx, publicId);
  }
}
