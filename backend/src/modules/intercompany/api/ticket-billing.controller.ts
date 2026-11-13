import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { LinkTicketToWorkRequest, SetBillableRequest, TicketBilling } from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { TicketBillingService } from '../application/ticket-billing.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
const HEAD = 'The head of the ticket\'s department (the provider\'s department head) or the CEO (intercompany.manage, scope all); others get 403. Audited. '
  + 'Once a month with time on the ticket is billed, its billing no longer changes (IC_MONTH_BILLED).';

/** Only: validate input, check permission, call one use case. */
@Controller('intercompany/tickets')
export class TicketBillingController {
  constructor(@Inject(TicketBillingService) private readonly service: TicketBillingService) {}

  @Doc({ summary: 'A ticket\'s billing to another company: link, billable to, billable or not (with the reason)', response: TicketBilling,
    description: 'The head of the ticket\'s department, or the CEO (intercompany.view or manage, scope all); others get 403.' })
  @SignedIn() @Get(':ticketPublicId/billing')
  view(@Ctx() ctx: RequestContext, @Param('ticketPublicId', PublicIdParam) ticketPublicId: string) {
    return this.service.view(ctx, ticketPublicId);
  }

  @Doc({ summary: 'Link the ticket to another company\'s project or design request: billable to that company by default', response: TicketBilling,
    description: `${HEAD} Linking again to the same company keeps the billable decision; the same link again changes nothing.` })
  @SignedIn() @Put(':ticketPublicId/link')
  link(@Ctx() ctx: RequestContext, @Param('ticketPublicId', PublicIdParam) ticketPublicId: string,
    @Body(new ZodValidationPipe(LinkTicketToWorkRequest)) body: LinkTicketToWorkRequest) {
    return this.service.link(ctx, ticketPublicId, body);
  }

  @Doc({ summary: 'Set a linked ticket billable, or not billable with a reason', response: TicketBilling, description: HEAD })
  @SignedIn() @Post(':ticketPublicId/billable') @HttpCode(200)
  setBillable(@Ctx() ctx: RequestContext, @Param('ticketPublicId', PublicIdParam) ticketPublicId: string,
    @Body(new ZodValidationPipe(SetBillableRequest)) body: SetBillableRequest) {
    return this.service.setBillable(ctx, ticketPublicId, body);
  }
}
