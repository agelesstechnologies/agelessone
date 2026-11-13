import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  AddPassedCostRequest, AddRateCardRequest, AgreementsQuery, CreateAgreementRequest, IcAgreement, IcAgreementDetail, IcPassedCost, IcPassedCostList,
  IcRateCard, MarkMonthBilledRequest, PassedCostsQuery, RateCardsQuery, UpdateAgreementRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, Public, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { AgreementsService, BillUpload } from '../application/agreements.service';
import { INTERCOMPANY } from '../domain/permissions';
import { MAX_BILL_BYTES } from '../domain/agreements';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
type FileReply = { setHeader(k: string, v: string): void; send(b: Buffer): void };
const SEES = 'The two companies\' heads named on the agreement (job still held) and the CEO (intercompany.view or manage, scope all); for anyone else it does not exist (404).';
const MANAGES = 'The CEO only (intercompany.manage, scope all). Audited.';
const COSTS = 'The provider\'s head named on the agreement, or the CEO (intercompany.manage, scope all). Audited. Nothing in a billed month changes (IC_MONTH_BILLED).';

/** Only: validate input, check permission, call one use case. */
@Controller('intercompany')
export class AgreementsController {
  constructor(@Inject(AgreementsService) private readonly service: AgreementsService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  @Doc({ summary: 'Intercompany agreements you may see, newest first', response: z.array(IcAgreement), description: SEES })
  @SignedIn() @Get('agreements')
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(AgreementsQuery)) q: AgreementsQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'Draft an agreement: provider and receiver (head and approver each), services, pricing, days, start date',
    response: IcAgreementDetail, resend: true, description: MANAGES })
  @Permission(INTERCOMPANY.manage) @Post('agreements')
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateAgreementRequest)) body: CreateAgreementRequest, @Res({ passthrough: true }) res: Created) {
    const { agreement, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return agreement;
  }

  @Doc({ summary: 'One agreement with its rates and billed months', response: IcAgreementDetail, description: SEES })
  @SignedIn() @Get('agreements/:publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Doc({ summary: 'Change terms, heads, approvers, days or status (draft → active → ended)', response: IcAgreementDetail,
    description: `${MANAGES} An ended agreement never changes; once a month is billed the pricing terms stay.` })
  @Permission(INTERCOMPANY.manage) @Patch('agreements/:publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UpdateAgreementRequest)) body: UpdateAgreementRequest) {
    return this.service.update(ctx, publicId, body);
  }

  @Doc({ summary: 'Rates: every row newest first, or with `on` the rate in force that day per service type and grade', response: z.array(IcRateCard), description: SEES })
  @SignedIn() @Get('agreements/:publicId/rate-cards')
  rateCards(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Query(new ZodValidationPipe(RateCardsQuery)) q: RateCardsQuery) {
    return this.service.rateCards(ctx, publicId, q);
  }

  @Doc({ summary: 'Add an hourly rate for a service type or grade from a date (a new rate is a new row)', response: IcRateCard, resend: true,
    description: `${MANAGES} Never reaches back into a billed month.` })
  @Permission(INTERCOMPANY.manage) @Post('agreements/:publicId/rate-cards')
  async addRateCard(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddRateCardRequest)) body: AddRateCardRequest, @Res({ passthrough: true }) res: Created) {
    const { rateCard, created } = await this.service.addRateCard(ctx, publicId, body);
    if (!created) res.status(200);
    return rateCard;
  }

  @Doc({ summary: 'Mark a finished month billed: nothing in it changes again', response: IcAgreementDetail,
    description: `${MANAGES} The same month again answers 200 and changes nothing.` })
  @Permission(INTERCOMPANY.manage) @Post('agreements/:publicId/billed-months')
  async markBilled(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(MarkMonthBilledRequest)) body: MarkMonthBilledRequest, @Res({ passthrough: true }) res: Created) {
    const { agreement, created } = await this.service.markBilled(ctx, publicId, body);
    if (!created) res.status(200);
    return agreement;
  }

  @Doc({ summary: 'Costs passed on (a month, or all): counted with a bill, waiting without one', response: IcPassedCostList, description: SEES })
  @SignedIn() @Get('agreements/:publicId/passed-costs')
  passedCosts(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Query(new ZodValidationPipe(PassedCostsQuery)) q: PassedCostsQuery) {
    return this.service.passedCosts(ctx, publicId, q);
  }

  /** multipart/form-data: the AddPassedCostRequest fields plus an optional file field `bill`. 201 new, 200 resend. */
  @Doc({ summary: 'Record a cost passed on, with its bill (JPEG, PNG or PDF) now or later; it counts once the bill is attached',
    response: IcPassedCost, resend: true, multipart: 'bill', description: COSTS })
  @SignedIn() @Post('agreements/:publicId/passed-costs')
  @UseInterceptors(FileInterceptor('bill', { limits: { fileSize: MAX_BILL_BYTES, files: 1 } }))
  async addPassedCost(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddPassedCostRequest)) body: AddPassedCostRequest, @UploadedFile() bill: BillUpload | undefined, @Res({ passthrough: true }) res: Created) {
    const { cost, created } = await this.service.addPassedCost(ctx, publicId, body, bill);
    if (!created) res.status(200);
    return cost;
  }

  @Doc({ summary: 'Attach (or replace) the bill of a passed-on cost: then it counts', response: IcPassedCost, multipart: 'bill', description: COSTS })
  @SignedIn() @Post('passed-costs/:publicId/bill') @HttpCode(200)
  @UseInterceptors(FileInterceptor('bill', { limits: { fileSize: MAX_BILL_BYTES, files: 1 } }))
  attachBill(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @UploadedFile() bill: BillUpload | undefined) {
    return this.service.attachBill(ctx, publicId, bill);
  }

  @Doc({ summary: 'The bill file of a passed-on cost', file: true, description: SEES })
  @SignedIn() @Get('passed-costs/:publicId/bill')
  async billFile(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    const { name, contentType, data } = await this.service.billFile(ctx, publicId);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(data);
  }
}
