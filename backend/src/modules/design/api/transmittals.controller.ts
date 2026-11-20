import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { ClientResponseRequest, IssueTransmittalRequest, Revision, Transmittal, TransmittalListItem, TransmittalsQuery } from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { TransmittalsService } from '../application/transmittals.service';
import { Created, FileReply, MANAGES, PublicIdParam, SEES, sendFile } from './files';

/** Transmittals and the client's responses. Only: validate input, check who is signed in, call one use case. */
@Controller('design')
export class TransmittalsController {
  constructor(@Inject(TransmittalsService) private readonly service: TransmittalsService) {}

  @Doc({ summary: 'Issue QC-approved revisions of a job to the client (TR-0001 per company); supersedes each drawing\'s earlier issued revision',
    response: Transmittal, resend: true,
    description: `${MANAGES} Only QC-approved revisions (DESIGN_NOT_QC_APPROVED), one per drawing; for construction: construction revisions only.` })
  @SignedIn() @Post('jobs/:publicId/transmittals')
  async issue(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(IssueTransmittalRequest)) body: IssueTransmittalRequest, @Res({ passthrough: true }) res: Created) {
    const { transmittal, created } = await this.service.issue(ctx, publicId, body);
    if (!created) res.status(200);
    return transmittal;
  }

  @Doc({ summary: 'Transmittals you may see, newest first', response: z.array(TransmittalListItem), description: SEES })
  @SignedIn() @Get('transmittals')
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(TransmittalsQuery)) q: TransmittalsQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'One transmittal with the revisions it issued', response: Transmittal, description: SEES })
  @SignedIn() @Get('transmittals/:publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Doc({ summary: 'The transmittal\'s cover sheet (PDF): exactly the revisions it issued', file: true, description: SEES })
  @SignedIn() @Get('transmittals/:publicId/cover-sheet')
  async cover(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    const { name, data } = await this.service.coverPdf(ctx, publicId);
    sendFile(res, { name, contentType: 'application/pdf', data });
  }

  @Doc({ summary: 'The cover sheet and every issued drawing PDF in one zip', file: true, description: SEES })
  @SignedIn() @Get('transmittals/:publicId/zip')
  async zip(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    const { name, data } = await this.service.zip(ctx, publicId);
    sendFile(res, { name, contentType: 'application/zip', data });
  }

  @Doc({ summary: 'Record the client\'s response to an issued revision: accepted, or returned with comments (a next revision is needed)', response: Revision,
    resend: true, description: `${MANAGES} Once per revision; the same response again changes nothing.` })
  @SignedIn() @Post('revisions/:publicId/response')
  async respond(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ClientResponseRequest)) body: ClientResponseRequest, @Res({ passthrough: true }) res: Created) {
    const { revision, created } = await this.service.respond(ctx, publicId, body);
    if (!created) res.status(200);
    return revision;
  }
}
