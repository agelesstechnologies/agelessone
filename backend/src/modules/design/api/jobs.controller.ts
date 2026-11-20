import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  AddJobAttachmentRequest, CreateDesignJobRequest, DesignAccessInfo, DesignJob, DesignJobDetail, DesignJobsQuery, DesignJobStatusRequest, LinkJobTicketRequest,
  UpdateDesignJobRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Public, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { DesignJobsService } from '../application/jobs.service';
import { MAX_UPLOAD_BYTES, Upload } from '../application/files.service';
import { Created, FileReply, MANAGES, PublicIdParam, SEES, sendFile } from './files';

/** Design jobs. Only: validate input, check who is signed in, call one use case (the service checks who may). */
@Controller('design')
export class DesignJobsController {
  constructor(@Inject(DesignJobsService) private readonly service: DesignJobsService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  @Doc({ summary: 'What you may do in Design, per company, and how many jobs you work on through tickets (for the menu and buttons)',
    response: DesignAccessInfo, description: 'Anyone signed in.' })
  @SignedIn() @Get('access')
  access(@Ctx() ctx: RequestContext) {
    return this.service.myAccess(ctx);
  }

  @Doc({ summary: 'Design jobs you may see, newest first', response: z.array(DesignJob),
    description: 'Every job of the companies where you see design work (Designing head, Admin user, Design QC, design.view), plus the jobs whose tickets you work on.' })
  @SignedIn() @Get('jobs')
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DesignJobsQuery)) q: DesignJobsQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'Receive a design job from a client (numbered DJ-025 per company)', response: DesignJobDetail, resend: true,
    description: `${MANAGES} The company needs its Designing department (policy design.department_prefix): DESIGN_NOT_ENABLED otherwise.` })
  @SignedIn() @Post('jobs')
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateDesignJobRequest)) body: CreateDesignJobRequest, @Res({ passthrough: true }) res: Created) {
    const { job, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return job;
  }

  @Doc({ summary: 'One design job: attachments, tickets, drawings with their current revision, transmittals', response: DesignJobDetail, description: SEES })
  @SignedIn() @Get('jobs/:publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Doc({ summary: 'Change a design job\'s details while it is open (the client never changes)', response: DesignJobDetail, description: MANAGES })
  @SignedIn() @Patch('jobs/:publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(UpdateDesignJobRequest)) body: UpdateDesignJobRequest) {
    return this.service.update(ctx, publicId, body);
  }

  @Doc({ summary: 'Move a design job on: accepted, in design, closed; on hold or cancelled with a reason', response: DesignJobDetail,
    description: `${MANAGES} The same status again changes nothing.` })
  @SignedIn() @Post('jobs/:publicId/status') @HttpCode(200)
  status(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(DesignJobStatusRequest)) body: DesignJobStatusRequest) {
    return this.service.setStatus(ctx, publicId, body);
  }

  /** multipart/form-data: the AddJobAttachmentRequest fields plus the file field `file`. 201 new, 200 resend. */
  @Doc({ summary: 'Attach a file the client sent (PDF, picture, document, CAD; size: policy design.max_file_mb)', response: DesignJobDetail, resend: true,
    multipart: 'file', description: MANAGES })
  @SignedIn() @Post('jobs/:publicId/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async addAttachment(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddJobAttachmentRequest)) body: AddJobAttachmentRequest, @UploadedFile() file: Upload | undefined, @Res({ passthrough: true }) res: Created) {
    const { job, created } = await this.service.addAttachment(ctx, publicId, body, file);
    if (!created) res.status(200);
    return job;
  }

  @Doc({ summary: 'Download a design job\'s attachment', file: true, description: SEES })
  @SignedIn() @Get('job-attachments/:publicId/file')
  async attachment(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    sendFile(res, await this.service.attachmentFile(ctx, publicId));
  }

  @Doc({ summary: 'A ticket works on this job; when the client is another group company (AE) it becomes billable to it (Intercompany)', response: DesignJobDetail,
    description: `${MANAGES} A ticket of the job's company, once (never moved to another job); the same ticket again changes nothing.` })
  @SignedIn() @Post('jobs/:publicId/tickets') @HttpCode(200)
  linkTicket(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(LinkJobTicketRequest)) body: LinkJobTicketRequest) {
    return this.service.linkTicket(ctx, publicId, body);
  }
}
