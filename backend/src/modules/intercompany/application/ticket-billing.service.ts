import { Inject, Injectable } from '@nestjs/common';
import { LinkTicketToWorkRequest, SetBillableRequest, TicketBilling } from '@ageless/shared';
import { DB, Db, Tx, violatedConstraint } from '../../../platform/db/db.module';
import { AppError } from '../../../platform/http/app-error';
import { RequestContext } from '../../../platform/http/request-context';
import { CoreFacade } from '../../core/core.facade';
import { IntercompanyRepository } from '../infrastructure/intercompany.repository';
import { monthLabel } from '../domain/agreements';
import { billingAfterLink, billingChanged, TicketBillingState } from '../domain/ticket-billing';
import { INTERCOMPANY } from '../domain/permissions';

type Ticket = NonNullable<Awaited<ReturnType<IntercompanyRepository['findTicket']>>>;

/**
 * Tickets billable to another company of the group. A ticket linked to the other company's project or design request
 * is billable to that company by default; the provider's department head (the head of the ticket's department) or the
 * CEO (intercompany.manage, scope all) links it and may set it not billable, with a reason. Audited. Once a month with
 * time on the ticket is billed, its billing no longer changes.
 */
@Injectable()
export class TicketBillingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(IntercompanyRepository) private readonly repo: IntercompanyRepository,
    @Inject(CoreFacade) private readonly core: CoreFacade,
  ) {}

  /** The ticket's billing: its department head, or view / manage with scope all (the CEO). */
  async view(ctx: RequestContext, ticketPublicId: string): Promise<TicketBilling> {
    const t = await this.ticket(ctx, ticketPublicId);
    const seesAll = ctx.permissions[INTERCOMPANY.view] === 'all' || ctx.permissions[INTERCOMPANY.manage] === 'all';
    if (!seesAll && t.departmentHeadPersonId !== ctx.personId) throw notHead();
    return this.answer(t);
  }

  /** Link the ticket to another company's project or design request: billable to that company by default. */
  async link(ctx: RequestContext, ticketPublicId: string, req: LinkTicketToWorkRequest): Promise<TicketBilling> {
    const t = await this.ticket(ctx, ticketPublicId);
    this.requireHead(ctx, t);
    const company = await this.repo.findCompany(ctx.tenantId, req.company);
    if (!company) throw new AppError('IC_UNKNOWN_COMPANY', 400, `Unknown company ${req.company}`);
    try {
      await this.db.transaction(async (tx) => {
        const current = await this.repo.ticketBilling(tx, t.id, true);
        if (current && current.linkKind === req.kind && current.linkPublicId === req.publicId && current.billableToCompanyId === company.id
          && current.serviceType === req.serviceType) return; // sent again
        const before = current ? state(current) : null;
        const after = billingAfterLink(before, t.legalEntityId, company.id, req.serviceType);
        if (after === 'SAME_COMPANY') throw new AppError('IC_SAME_COMPANY', 400, `The ticket is ${t.company}'s own work: only work for another company is billed`);
        if (billingChanged(before, after)) await this.requireUnbilled(tx, t, [before?.billableToCompanyId, after.billableToCompanyId]);
        const values = { billableToLegalEntityId: after.billableToCompanyId, linkKind: req.kind, linkPublicId: req.publicId, serviceType: req.serviceType,
          billable: after.billable, notBillableReason: after.notBillableReason, changedBy: ctx.personId, changedAt: new Date() };
        if (current) await this.repo.updateTicketBilling(tx, current.id, values);
        else await this.repo.insertTicketBilling(tx, { tenantId: ctx.tenantId, ticketId: t.id, legalEntityId: t.legalEntityId, ...values });
        await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId, action: 'intercompany.ticket_linked', entity: 'ticket',
          entityPublicId: t.publicId, legalEntityId: t.legalEntityId,
          summary: `Ticket ${t.number} linked to ${company.code}'s ${req.kind.replace('_', ' ')}: ${after.billable ? 'billable' : 'not billable'} to ${company.code}`,
          details: { kind: req.kind, linkPublicId: req.publicId, billableTo: company.code, serviceType: req.serviceType, billable: after.billable,
            before: before ? { billableTo: current!.billableTo, billable: before.billable, serviceType: before.serviceType } : null } });
      });
    } catch (err) {
      if (violatedConstraint(err) === 'ic_ticket_billing_ticket_id_unique') return this.link(ctx, ticketPublicId, req); // linked twice at once
      throw err;
    }
    return this.answer(t);
  }

  /** Billable or not billable (with a reason). Only a linked ticket; the same answer again changes nothing. */
  async setBillable(ctx: RequestContext, ticketPublicId: string, req: SetBillableRequest): Promise<TicketBilling> {
    const t = await this.ticket(ctx, ticketPublicId);
    this.requireHead(ctx, t);
    await this.db.transaction(async (tx) => {
      const current = await this.repo.ticketBilling(tx, t.id, true);
      if (!current) throw new AppError('IC_TICKET_NOT_LINKED', 409, 'Link the ticket to the other company\'s project or design request first');
      const reason = req.billable ? null : req.reason!;
      if (current.billable === req.billable && current.notBillableReason === reason) return;
      const before = state(current);
      const after: TicketBillingState = { ...before, billable: req.billable, notBillableReason: reason };
      if (billingChanged(before, after)) await this.requireUnbilled(tx, t, [current.billableToCompanyId]);
      await this.repo.updateTicketBilling(tx, current.id, { billable: req.billable, notBillableReason: reason, changedBy: ctx.personId, changedAt: new Date() });
      await this.core.audit(tx, { tenantId: ctx.tenantId, actorPersonId: ctx.personId,
        action: req.billable ? 'intercompany.ticket_billable' : 'intercompany.ticket_not_billable', entity: 'ticket',
        entityPublicId: t.publicId, legalEntityId: t.legalEntityId,
        summary: req.billable ? `Ticket ${t.number} is billable to ${current.billableTo} again` : `Ticket ${t.number} not billable to ${current.billableTo}: ${reason}`,
        details: { billableTo: current.billableTo, billable: req.billable, reason, before: { billable: current.billable, reason: current.notBillableReason } } });
    });
    return this.answer(t);
  }

  private async ticket(ctx: RequestContext, publicId: string): Promise<Ticket> {
    const t = await this.repo.findTicket(ctx.tenantId, publicId);
    if (!t) throw new AppError('IC_TICKET_NOT_FOUND', 404, 'Ticket not found');
    return t;
  }

  /** The provider's department head (head of the ticket's department) or the CEO (manage, scope all). */
  private requireHead(ctx: RequestContext, t: Ticket): void {
    if (ctx.permissions[INTERCOMPANY.manage] !== 'all' && t.departmentHeadPersonId !== ctx.personId) throw notHead();
  }

  /** Refuses when the ticket has time in a month already billed to one of these companies. */
  private async requireUnbilled(tx: Tx, t: Ticket, receivers: (number | undefined)[]): Promise<void> {
    const billed = await this.repo.billedMonthWithTicketTime(tx, t, receivers.filter((r): r is number => r !== undefined));
    if (billed) throw new AppError('IC_MONTH_BILLED', 409, `${monthLabel(billed)} is billed with time on this ticket: its billing no longer changes`);
  }

  private async answer(t: Ticket): Promise<TicketBilling> {
    const b = await this.repo.ticketBilling(this.db, t.id);
    const ticket = { publicId: t.publicId, number: t.number, title: t.title, company: t.company };
    if (!b) return { ticket, link: null, billableTo: null, serviceType: null, billable: false, notBillableReason: null, changedBy: null, changedAt: null };
    const people = await this.repo.persons(this.db, [b.changedBy]);
    return {
      ticket, link: { kind: b.linkKind as 'project' | 'design_request', publicId: b.linkPublicId }, billableTo: b.billableTo,
      serviceType: b.serviceType as TicketBilling['serviceType'],
      billable: b.billable, notBillableReason: b.notBillableReason, changedBy: people.get(b.changedBy)!, changedAt: b.changedAt.toISOString(),
    };
  }
}

const notHead = () => new AppError('IC_NOT_DEPARTMENT_HEAD', 403, 'Only the head of the ticket\'s department (or the CEO) decides its billing');
const state = (b: { billableToCompanyId: number; billable: boolean; notBillableReason: string | null; serviceType: string | null }): TicketBillingState =>
  ({ billableToCompanyId: b.billableToCompanyId, billable: b.billable, notBillableReason: b.notBillableReason, serviceType: b.serviceType });
