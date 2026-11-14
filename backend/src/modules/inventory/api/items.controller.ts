import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  Conversion, ConvertQuery, CopyItemRequest, CreateItemRequest, ImportCsvRequest, ImportResult, Item, ItemList, ItemsQuery, UpdateItemRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { ItemsService } from '../application/items.service';
import { ItemImportService } from '../application/item-import.service';
import { CsvUpload, MAX_CSV_BYTES } from '../application/csv-upload';
import { INVENTORY, INVENTORY_READ } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
const COMPANIES = 'Only companies the caller works in (scope all: every company); another company\'s items are unknown (404).';
const RULES = 'Category, units and default location must be the item\'s own company\'s and active. A non-stocked item has no tracking, reorder values or '
  + 'default location; serial items use a unit with 0 decimals; the default location is a store, rack, bin, work area or testing space '
  + '(400 INVENTORY_ITEM_INVALID, every problem in details).';

/** Only: validate input, check permission, call one use case. Fixed paths (import, copy) come before /:publicId. */
@Controller('inventory/items')
export class ItemsController {
  constructor(
    @Inject(ItemsService) private readonly service: ItemsService,
    @Inject(ItemImportService) private readonly importer: ItemImportService,
  ) {}

  @Doc({ summary: 'Items of the companies you reach, a page at a time; filter by company, category, status, tracking, stocked; search code or name',
    response: ItemList, description: COMPANIES })
  @Permission(...INVENTORY_READ) @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ItemsQuery)) q: ItemsQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'Import a company\'s items from a CSV file (duplicates by code skipped)', response: ImportResult, multipart: 'file',
    description: 'Columns (header row, any case): code, name, description, category (name or code prefix), unit, tracking, hsn_code, is_stocked, '
      + 'reorder_level, reorder_qty, default_location (code), purchase_unit, purchase_factor. Rows whose code the company already uses, or an earlier row '
      + 'used, are skipped (without a code: the same name). Any other problem refuses the whole file: 400 INVENTORY_IMPORT_INVALID with details '
      + `[{ row, field, message }] (spreadsheet rows; the header is row 1). dryRun=true checks and shows the codes without saving. ${RULES}` })
  @Permission(INVENTORY.items) @Post('import') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }))
  import(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ImportCsvRequest)) body: ImportCsvRequest, @UploadedFile() file: CsvUpload | undefined) {
    return this.importer.import(ctx, body, file);
  }

  @Doc({ summary: 'Copy another company\'s item into a company as a new, separate item (description only)', response: Item, resend: true,
    description: 'Name, description, HSN/SAC code, tracking and stocked travel; category, base unit (default: the unit with the same code), code, '
      + 'reorder values, location and conversions are the new company\'s own. The two items are not linked. Needs read access to the source item and '
      + `inventory.items.manage in the target company. ${RULES}` })
  @Permission(INVENTORY.items) @Post('copy')
  async copy(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CopyItemRequest)) body: CopyItemRequest, @Res({ passthrough: true }) res: Created) {
    const { item, created } = await this.service.copy(ctx, body);
    if (!created) res.status(200);
    return item;
  }

  @Doc({ summary: 'One item, with its unit conversions', response: Item, description: COMPANIES })
  @Permission(...INVENTORY_READ) @Get(':publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Doc({ summary: 'A quantity in one of the item\'s units, in its base unit', response: Conversion,
    description: 'quantity × factor, rounded half up to the base unit\'s decimals (3 boxes of 100 → 300 pcs). 400 INVENTORY_NO_CONVERSION: the item has '
      + `no conversion for that unit; 400 INVENTORY_QUANTITY_DECIMALS: more decimals than the unit allows. ${COMPANIES}` })
  @Permission(...INVENTORY_READ) @Get(':publicId/convert')
  convert(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Query(new ZodValidationPipe(ConvertQuery)) q: ConvertQuery) {
    return this.service.convert(ctx, publicId, q);
  }

  @Doc({ summary: 'Add an item to a company', response: Item, resend: true,
    description: `Code and name (ignoring case) are unique per company; without a code the item gets the next code of its category (EC-0001 …). ${RULES}` })
  @Permission(INVENTORY.items) @Post()
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateItemRequest)) body: CreateItemRequest, @Res({ passthrough: true }) res: Created) {
    const { item, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return item;
  }

  @Doc({ summary: 'Change an item, its conversions or its status', response: Item,
    description: 'Send only what changes; null clears an optional field. The code never changes. conversions replaces the list (changed ones are ended '
      + `and added again); a new base unit needs the conversions sent with it (400 INVENTORY_CONVERSIONS_NEEDED). ${RULES}` })
  @Permission(INVENTORY.items) @Patch(':publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(UpdateItemRequest)) body: UpdateItemRequest) {
    return this.service.update(ctx, publicId, body);
  }
}
