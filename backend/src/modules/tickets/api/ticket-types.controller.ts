import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { CreateTicketTypeRequest, TicketType, TicketTypeDetail, TicketTypesQuery, UpdateTicketTypeRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { TicketTypesService } from '../application/ticket-types.service';
import { TICKET_TYPES } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
const READ = [TICKET_TYPES.view, TICKET_TYPES.manage] as [string, ...string[]];
const MANAGE = 'Scope all (admin user, Management): any type, standard ones too. Otherwise the head of the owning department, for non-standard types only.';

/** Only: validate input, check permission, call one use case. */
@Controller('tickets/types')
export class TicketTypesController {
  constructor(@Inject(TicketTypesService) private readonly service: TicketTypesService) {}

  @Doc({ summary: 'Ticket types (current versions); filter by active, department, company', response: z.array(TicketType) })
  @Permission(...READ) @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(TicketTypesQuery)) q: TicketTypesQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'One ticket type with every saved version, newest first', response: TicketTypeDetail })
  @Permission(...READ) @Get(':publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Doc({ summary: 'Create a ticket type', response: TicketTypeDetail, resend: true,
    description: `${MANAGE} A head creates only for a department they head. Name and code are unique per company (name ignoring case).` })
  @Permission(TICKET_TYPES.manage) @Post()
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateTicketTypeRequest)) body: CreateTicketTypeRequest,
    @Res({ passthrough: true }) res: Created) {
    const { type, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return type;
  }

  @Doc({ summary: 'Change a ticket type: saves a new version and keeps the old ones', response: TicketTypeDetail,
    description: `${MANAGE} Send only what changes; sending what is already stored saves nothing. The code never changes.` })
  @Permission(TICKET_TYPES.manage) @Patch(':publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UpdateTicketTypeRequest)) body: UpdateTicketTypeRequest) {
    return this.service.update(ctx, publicId, body);
  }

  @Doc({ summary: 'Deactivate a ticket type (no new tickets; old tickets keep it)', response: TicketTypeDetail, description: MANAGE })
  @Permission(TICKET_TYPES.manage) @Post(':publicId/deactivate') @HttpCode(200)
  deactivate(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.deactivate(ctx, publicId);
  }

  @Doc({ summary: 'Reactivate a ticket type', response: TicketTypeDetail, description: MANAGE })
  @Permission(TICKET_TYPES.manage) @Post(':publicId/reactivate') @HttpCode(200)
  reactivate(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.reactivate(ctx, publicId);
  }
}
