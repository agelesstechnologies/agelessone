import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  ApprovePartRequest, CancelPartRequest, CreateGrantRequest, CreatePartRequest, Grant, GrantsQuery, PartRequest, PartRequestList, PartRequestsQuery,
  RejectPartRequest, RequestItem, RequestItemsQuery, TicketParts,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { RequestsService } from '../application/requests.service';
import { GrantsService } from '../application/grants.service';
import { INVENTORY } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
const WHO = 'Signed in: a Parts requester assigned to the ticket, on a ticket type that uses parts (policy inventory.parts.ticket_types), or a person with a '
  + 'cross-company grant for the ticket (403 INVENTORY_CANNOT_REQUEST otherwise). Requesters never see values.';
const SEES = 'Your own requests; the store (inventory.view or inventory.requests.approve) its companies\' requests; a department head (inventory.department.view) '
  + 'the requests of tickets of departments they head; requesters of a ticket its requests. Values only for the store, Accounts, CEO and the head; null for others.';

/** Only: validate input, check permission, call one use case. Fixed paths come before /:publicId. */
@Controller('inventory')
export class RequestsController {
  constructor(
    @Inject(RequestsService) private readonly requests: RequestsService,
    @Inject(GrantsService) private readonly grants: GrantsService,
  ) {}

  @Doc({ summary: 'What can be requested for a ticket: active stocked items, in stock or not (no quantities, no values)', response: z.array(RequestItem), description: WHO })
  @SignedIn() @Get('requests/items')
  items(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(RequestItemsQuery)) q: RequestItemsQuery) {
    return this.requests.items(ctx, q);
  }

  @Doc({ summary: 'Request parts for a ticket', response: PartRequest, resend: true,
    description: `${WHO} The estimate (quantity × average) decides whether the department head approves too (policy inventory.requests.head_approval_above_paise, default ₹10,000).` })
  @SignedIn() @Post('requests')
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreatePartRequest)) body: CreatePartRequest, @Res({ passthrough: true }) res: Created) {
    const { request, created } = await this.requests.create(ctx, body);
    if (!created) res.status(200);
    return request;
  }

  @Doc({ summary: 'Part requests you may see', response: PartRequestList, description: SEES })
  @SignedIn() @Get('requests')
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PartRequestsQuery)) q: PartRequestsQuery) {
    return this.requests.list(ctx, q);
  }

  @Doc({ summary: 'One part request with its lines and reservations', response: PartRequest, description: SEES })
  @SignedIn() @Get('requests/:publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.requests.get(ctx, publicId);
  }

  @Doc({ summary: 'Approve a part request (as store in-charge and/or department head); once fully approved its stock is reserved', response: PartRequest,
    description: 'Store in-charge (inventory.requests.approve in the company): may choose where each line is reserved from (else the item\'s default location, then the one with '
      + 'most free). Department head (head of the ticket\'s department with inventory.department.view, or that permission with scope all): when the estimate is above the limit. '
      + 'Never your own request (403 INVENTORY_OWN_REQUEST). Reserved until reserveUntil (default today + policy inventory.requests.reserve_days). 409 INVENTORY_NOT_ENOUGH_AVAILABLE.' })
  @Permission(INVENTORY.requestsApprove, INVENTORY.departmentView) @Post('requests/:publicId/approve') @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(ApprovePartRequest)) body: ApprovePartRequest) {
    return this.requests.approve(ctx, publicId, body);
  }

  @Doc({ summary: 'Reject a pending part request', response: PartRequest, description: 'The store in-charge, or the department head when the request needs them. Never your own.' })
  @Permission(INVENTORY.requestsApprove, INVENTORY.departmentView) @Post('requests/:publicId/reject') @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(RejectPartRequest)) body: RejectPartRequest) {
    return this.requests.reject(ctx, publicId, body);
  }

  @Doc({ summary: 'Cancel a pending or approved part request (its reserved stock is released)', response: PartRequest,
    description: 'The requester or the store in-charge.' })
  @SignedIn() @Post('requests/:publicId/cancel') @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(CancelPartRequest)) body: CancelPartRequest) {
    return this.requests.cancel(ctx, publicId, body);
  }

  @Doc({ summary: 'A ticket\'s parts: its requests, and the parts issued and returned on it', response: TicketParts,
    description: 'For the ticket\'s requesters (no values), the store, Accounts, CEO and the ticket\'s department head (with values).' })
  @SignedIn() @Get('tickets/:publicId/parts')
  ticketParts(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.requests.ticketParts(ctx, publicId);
  }

  // ---- cross-company grants ----

  @Doc({ summary: 'Let a person from another company request parts for one ticket until a date', response: Grant, resend: true,
    description: 'The store in-charge of the company that owns the stock (inventory.requests.approve). The person must work in another company; they request only (no values, no approvals). Audited.' })
  @Permission(INVENTORY.requestsApprove) @Post('grants')
  async grant(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateGrantRequest)) body: CreateGrantRequest, @Res({ passthrough: true }) res: Created) {
    const { grant, created } = await this.grants.create(ctx, body);
    if (!created) res.status(200);
    return grant;
  }

  @Doc({ summary: 'Cross-company grants of the companies you approve requests for', response: z.array(Grant) })
  @Permission(INVENTORY.requestsApprove) @Get('grants')
  listGrants(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(GrantsQuery)) q: GrantsQuery) {
    return this.grants.list(ctx, q);
  }

  @Doc({ summary: 'Your own cross-company grants: the tickets of other companies you may request parts for', response: z.array(Grant) })
  @SignedIn() @Get('grants/mine')
  myGrants(@Ctx() ctx: RequestContext) {
    return this.grants.mine(ctx);
  }

  @Doc({ summary: 'End a cross-company grant', response: Grant, description: 'Audited. Requests already made stay as they are.' })
  @Permission(INVENTORY.requestsApprove) @Post('grants/:publicId/end') @HttpCode(200)
  endGrant(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.grants.end(ctx, publicId);
  }
}
