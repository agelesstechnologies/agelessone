import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { CategoriesQuery, Category, CreateCategoryRequest, UpdateCategoryRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { CategoriesService } from '../application/categories.service';
import { INVENTORY, INVENTORY_READ } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
const COMPANIES = 'Only companies the caller works in (scope all: every company); another company\'s categories are unknown (404).';

/** Only: validate input, check permission, call one use case. */
@Controller('inventory/categories')
export class CategoriesController {
  constructor(@Inject(CategoriesService) private readonly service: CategoriesService) {}

  @Doc({ summary: 'Item categories of the companies you reach, with how many items each has', response: z.array(Category), description: COMPANIES })
  @Permission(...INVENTORY_READ) @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(CategoriesQuery)) q: CategoriesQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'One item category', response: Category, description: COMPANIES })
  @Permission(...INVENTORY_READ) @Get(':publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Doc({ summary: 'Add an item category to a company', response: Category, resend: true,
    description: `Name (ignoring case) and code prefix are unique per company. The prefix starts the item codes made for it (EC → EC-0001) and never changes. ${COMPANIES}` })
  @Permission(INVENTORY.items) @Post()
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateCategoryRequest)) body: CreateCategoryRequest, @Res({ passthrough: true }) res: Created) {
    const { category, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return category;
  }

  @Doc({ summary: 'Rename an item category or change its status', response: Category,
    description: 'Inactive categories take no new items; their items keep them.' })
  @Permission(INVENTORY.items) @Patch(':publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UpdateCategoryRequest)) body: UpdateCategoryRequest) {
    return this.service.update(ctx, publicId, body);
  }
}
