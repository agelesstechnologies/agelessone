import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  CreatedTallyBatch, ImportResultRequest, MarkImportedRequest, NewTallyBatchRequest, TallyBatch, TallyBatchDetail, TallyBatchesQuery, TallyQueue, TallyQueueQuery,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { TallySyncService } from '../application/tally-sync.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Reply = { status(code: number): void; setHeader(k: string, v: string): void; send(b: string): void };
type Created = { status(code: number): void };
const WHO = 'Accounts roles only (maker, checker, or HR/CEO while the interim policy accounts.interim_roles applies); others get 403.';
const MAKER = 'Accounts maker only (the accountant); others get 403.';
const CHECKER = 'Accounts checker only; others get 403. Never your own batch (ACCOUNTS_SELF_APPROVAL).';

/** Only: validate input, check permission, call one use case. There is no connection to Tally: a batch is a file. */
@Controller('accounts/tally')
export class TallySyncController {
  constructor(@Inject(TallySyncService) private readonly service: TallySyncService) {}

  @Doc({ summary: 'Journal entries waiting to go to Tally in a date range: ready, blocked by an unmapped ledger, or returned with Tally\'s error', response: TallyQueue, description: WHO })
  @SignedIn() @Get('queue')
  queue(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(TallyQueueQuery)) q: TallyQueueQuery) { return this.service.queue(ctx, q); }

  @Doc({ summary: 'Tally batches of a company, newest first', response: z.array(TallyBatch), description: WHO })
  @SignedIn() @Get('batches')
  batches(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(TallyBatchesQuery)) q: TallyBatchesQuery) { return this.service.batches(ctx, q); }

  @Doc({ summary: 'Build one batch (one XML file) from the ready entries in the range', response: CreatedTallyBatch, resend: true,
    description: `${MAKER} Entries with an unmapped ledger stay in the queue (skippedBlocked). Needs an approved Tally company.` })
  @SignedIn() @Post('batches')
  async createBatch(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(NewTallyBatchRequest)) body: NewTallyBatchRequest, @Res({ passthrough: true }) res: Created) {
    const { batch, created } = await this.service.createBatch(ctx, body);
    if (!created) res.status(200);
    return batch;
  }

  @Doc({ summary: 'One batch with its entries and what happened to each', response: TallyBatchDetail, description: WHO })
  @SignedIn() @Get('batches/:publicId')
  batch(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) { return this.service.batch(ctx, publicId); }

  @Doc({ summary: 'Approve a batch so it can be downloaded', response: TallyBatchDetail, description: CHECKER })
  @SignedIn() @Post('batches/:publicId/approve')
  approve(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.approve(ctx, publicId);
  }

  @Doc({ summary: 'Download the XML file of an approved batch', file: true, description: 'Accounts maker or checker. 409 ACCOUNTS_TALLY_NOT_APPROVED until the checker approves.' })
  @SignedIn() @Get('batches/:publicId/download')
  async download(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: Reply) {
    const file = await this.service.download(ctx, publicId);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
    res.send(file.body);
  }

  @Doc({ summary: 'Record that the file was imported in Tally; name the entries that failed (they return to the queue with the error)', response: TallyBatchDetail,
    description: `${MAKER} Needs the batch approved and downloaded.` })
  @SignedIn() @Post('batches/:publicId/mark-imported')
  markImported(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(MarkImportedRequest)) body: MarkImportedRequest,
    @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.markImported(ctx, publicId, body);
  }

  @Doc({ summary: 'Upload Tally\'s import result; entries its errors name return to the queue', response: TallyBatchDetail,
    description: `${MAKER} 409 ACCOUNTS_TALLY_RESULT_UNCLEAR when the text does not say which entries failed (details.reasons); use mark-imported then.` })
  @SignedIn() @Post('batches/:publicId/import-result')
  importResult(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(ImportResultRequest)) body: ImportResultRequest,
    @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.importResult(ctx, publicId, body);
  }

  @Doc({ summary: 'Cancel a batch that is not imported yet; its entries return to the queue', response: TallyBatchDetail, description: 'Accounts maker or checker.' })
  @SignedIn() @Post('batches/:publicId/cancel')
  cancel(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.cancel(ctx, publicId);
  }
}
