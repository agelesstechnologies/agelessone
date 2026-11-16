import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  CreateIssueRequest, CreateReceiptRequest, CreateReturnRequest, CreateTransferRequest, ReverseDocumentRequest, StockBatch, StockBatchesQuery, StockDocument,
  StockDocumentList, StockDocumentsQuery, StockList, StockQuery,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { ChallanUpload, MAX_CHALLAN_BYTES, StockDocumentsService } from '../application/stock-documents.service';
import { STOCK_READ, StockQueriesService } from '../application/stock-queries.service';
import { INVENTORY } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
type FileReply = { setHeader(k: string, v: string): void; send(body: Buffer): void };
const POSTING = 'Needs inventory.stock.post in the company; with scope own, only for the locations you look after (403 INVENTORY_NOT_YOUR_LOCATION). '
  + 'Items, locations and tickets must be the company\'s own. The date (default today, IST) is never in the future. Posting writes the stock moves and '
  + 'updates balances and the moving average in one transaction; a resend with the same publicId answers the stored document.';
const NOT_ENOUGH = '409 INVENTORY_NOT_ENOUGH_STOCK when a location would go below zero.';
const READ = 'Store roles, Accounts and the CEO; with scope own only documents and stock of the locations you look after. Values included.';

/** Only: validate input, check permission, call one use case. */
@Controller('inventory')
export class StockController {
  constructor(
    @Inject(StockDocumentsService) private readonly documents: StockDocumentsService,
    @Inject(StockQueriesService) private readonly queries: StockQueriesService,
  ) {}

  @Doc({ summary: 'Receive goods from a supplier', response: StockDocument, resend: true,
    description: `A direct purchase needs a reason (purchase orders come later). Quantity in the base unit or a conversion unit; cost per that unit in minor units. The location defaults to the item's default location. The item's average cost is recalculated. ${POSTING}` })
  @Permission(INVENTORY.stockPost) @Post('receipts')
  async receipt(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateReceiptRequest)) body: CreateReceiptRequest, @Res({ passthrough: true }) res: Created) {
    return created(res, await this.documents.receipt(ctx, body));
  }

  @Doc({ summary: 'Issue parts to a ticket', response: StockDocument, resend: true,
    description: 'Against an approved part request (requestPublicId + requestLines) it takes the reserved stock; a direct issue (ticketPublicId + lines) only stock that is not reserved '
      + '(409 INVENTORY_NOT_ENOUGH_AVAILABLE). Batch items without a batch take the earliest expiry first; serial items are one unit per line with its serial number. '
      + `Each line takes the item's average cost at that moment; it is recorded on the line and never changes. The ticket is open, assigned, in progress or on hold. ${NOT_ENOUGH} ${POSTING}` })
  @Permission(INVENTORY.stockPost) @Post('issues')
  async issue(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateIssueRequest)) body: CreateIssueRequest, @Res({ passthrough: true }) res: Created) {
    return created(res, await this.documents.issue(ctx, body));
  }

  @Doc({ summary: 'Return parts from an issue', response: StockDocument, resend: true,
    description: `At the cost they were issued at, never more than was issued less what came back (409 INVENTORY_RETURN_TOO_MUCH). Condition decides the location: usable to a store, rack, bin, work area or testing space (default: where it was issued from); repair to quarantine; scrap to scrap (default: the company's only one). ${POSTING}` })
  @Permission(INVENTORY.stockPost) @Post('returns')
  async return(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateReturnRequest)) body: CreateReturnRequest, @Res({ passthrough: true }) res: Created) {
    return created(res, await this.documents.return(ctx, body));
  }

  @Doc({ summary: 'Send stock to another location of the company (through transit)', response: StockDocument, resend: true,
    description: `The stock leaves now and waits in the transit location (default: the company's only one) until POST /inventory/transfers/:id/receive. Scope own: the from-locations must be yours. ${NOT_ENOUGH} ${POSTING}` })
  @Permission(INVENTORY.stockPost) @Post('transfers')
  async transfer(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateTransferRequest)) body: CreateTransferRequest, @Res({ passthrough: true }) res: Created) {
    return created(res, await this.documents.transfer(ctx, body));
  }

  @Doc({ summary: 'Receive a transfer at its destinations', response: StockDocument,
    description: 'The receiving side confirms: the stock leaves transit with the value it left with. Scope own: the to-locations must be yours. 409 INVENTORY_NOT_IN_TRANSIT when already received or reversed.' })
  @Permission(INVENTORY.stockPost) @Post('transfers/:publicId/receive') @HttpCode(200)
  receive(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.documents.receive(ctx, publicId);
  }

  @Doc({ summary: 'Stock documents of the companies you reach', response: StockDocumentList, description: READ })
  @Permission(...STOCK_READ) @Get('documents')
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(StockDocumentsQuery)) q: StockDocumentsQuery) {
    return this.queries.list(ctx, q);
  }

  @Doc({ summary: 'One stock document with its lines', response: StockDocument, description: READ })
  @Permission(...STOCK_READ) @Get('documents/:publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.queries.get(ctx, publicId);
  }

  @Doc({ summary: 'Reverse a posted document (a reversal document undoes every move of it)', response: StockDocument, resend: true,
    description: 'Answers the reversal document. Quantity and value come back. An issue with returns needs those reversed first (409 INVENTORY_REVERSE_RETURNS_FIRST); refused when the stock has moved on since '
      + `(409 INVENTORY_NOT_ENOUGH_STOCK or INVENTORY_REVERSAL_NOT_POSSIBLE). A reversal is never reversed. ${POSTING}` })
  @Permission(INVENTORY.stockPost) @Post('documents/:publicId/reverse')
  async reverse(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ReverseDocumentRequest)) body: ReverseDocumentRequest, @Res({ passthrough: true }) res: Created) {
    return created(res, await this.documents.reverse(ctx, publicId, body));
  }

  @Doc({ summary: 'Attach the delivery challan of a receipt (JPEG, PNG or PDF)', response: StockDocument, multipart: 'file',
    description: 'Once per receipt (409 INVENTORY_CHALLAN_EXISTS); the type is told by the file\'s bytes. Scope own: the receipt\'s locations must be yours.' })
  @Permission(INVENTORY.stockPost) @Post('documents/:publicId/challan') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CHALLAN_BYTES, files: 1 } }))
  attach(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @UploadedFile() file: ChallanUpload | undefined) {
    return this.documents.attachChallan(ctx, publicId, file);
  }

  @Doc({ summary: 'Download the delivery challan of a receipt', file: true, description: READ })
  @Permission(...STOCK_READ) @Get('documents/:publicId/challan')
  async challan(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    const f = await this.queries.challan(ctx, publicId);
    res.setHeader('Content-Type', f.type);
    res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
    res.send(f.data);
  }

  @Doc({ summary: 'The batches of an item with stock, earliest expiry first (what to issue first)', response: z.array(StockBatch), description: READ })
  @Permission(...STOCK_READ) @Get('stock/batches')
  batches(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(StockBatchesQuery)) q: StockBatchesQuery) {
    return this.queries.batches(ctx, q);
  }

  @Doc({ summary: 'Stock on hand by item and location, with the company-wide average cost and value', response: StockList,
    description: `available = on hand - reserved. value = on hand × the item's moving average in its company. Empty rows are left out unless includeEmpty=true. ${READ}` })
  @Permission(...STOCK_READ) @Get('stock')
  stock(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(StockQuery)) q: StockQuery) {
    return this.queries.stockOnHand(ctx, q);
  }
}

function created(res: Created, r: { document: StockDocument; created: boolean }): StockDocument {
  if (!r.created) res.status(200);
  return r.document;
}
