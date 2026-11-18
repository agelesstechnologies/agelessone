import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { CreateUnitRequest, Unit, UnitsQuery, UpdateUnitRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { UnitsService } from '../application/units.service';
import { INVENTORY, INVENTORY_READ } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
const COMPANIES = 'Only companies the caller works in (scope all: every company); another company\'s units are unknown (404).';

/** Only: validate input, check permission, call one use case. */
@Controller('inventory/units')
export class UnitsController {
  constructor(@Inject(UnitsService) private readonly service: UnitsService) {}

  @Doc({ summary: 'Units (pcs, m, kg …) of the companies you reach; filter by company and status', response: z.array(Unit), description: COMPANIES })
  @Permission(...INVENTORY_READ) @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(UnitsQuery)) q: UnitsQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'One unit', response: Unit, description: COMPANIES })
  @Permission(...INVENTORY_READ) @Get(':publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Doc({ summary: 'Add a unit to a company', response: Unit, resend: true,
    description: `The code is unique per company and never changes. decimals: how many decimals a quantity may have (pieces 0, metres 2, kilograms 3; at most 4). ${COMPANIES}` })
  @Permission(INVENTORY.items) @Post()
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateUnitRequest)) body: CreateUnitRequest, @Res({ passthrough: true }) res: Created) {
    const { unit, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return unit;
  }

  @Doc({ summary: 'Rename a unit, change its decimals (only while no item uses it), or its status', response: Unit,
    description: 'Inactive units take no new items; their items keep them. 409 INVENTORY_UNIT_IN_USE: decimals of a unit items already use.' })
  @Permission(INVENTORY.items) @Patch(':publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(UpdateUnitRequest)) body: UpdateUnitRequest) {
    return this.service.update(ctx, publicId, body);
  }
}
