import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import {
  AddRevisionFileRequest, CreateDrawingRequest, CreateRevisionRequest, Drawing, QcChecklist, QcChecklistQuery, QcReviewRequest, Revision, UpdateDrawingRequest,
  UpdateRevisionRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { DrawingsService } from '../application/drawings.service';
import { QcService } from '../application/qc.service';
import { MAX_UPLOAD_BYTES, Upload } from '../application/files.service';
import { Created, DRAWS, FileReply, PublicIdParam, SEES, sendFile } from './files';

const QC = 'Design QC (design.qc), never the revision\'s author (drew, created or submitted it) nor an assignee of the job\'s tickets (DESIGN_QC_NOT_INDEPENDENT; the database refuses it too). Audited.';

/** Drawings, revisions, their files and QC. Only: validate input, check who is signed in, call one use case. */
@Controller('design')
export class DrawingsController {
  constructor(@Inject(DrawingsService) private readonly drawings: DrawingsService, @Inject(QcService) private readonly qc: QcService) {}

  @Doc({ summary: 'Add a drawing to a job: <job>-<discipline>-<seq> (DJ-025-MEC-001); disciplines from policy design.disciplines', response: Drawing, resend: true, description: DRAWS })
  @SignedIn() @Post('jobs/:publicId/drawings')
  async createDrawing(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(CreateDrawingRequest)) body: CreateDrawingRequest, @Res({ passthrough: true }) res: Created) {
    const { drawing, created } = await this.drawings.createDrawing(ctx, publicId, body);
    if (!created) res.status(200);
    return drawing;
  }

  @Doc({ summary: 'One drawing with every revision (oldest first; the last is current)', response: Drawing, description: SEES })
  @SignedIn() @Get('drawings/:publicId')
  drawing(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.drawings.drawing(ctx, publicId);
  }

  @Doc({ summary: 'Rename a drawing (until a revision is submitted)', response: Drawing, description: DRAWS })
  @SignedIn() @Patch('drawings/:publicId')
  updateDrawing(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(UpdateDrawingRequest)) body: UpdateDrawingRequest) {
    return this.drawings.updateDrawing(ctx, publicId, body);
  }

  @Doc({ summary: 'Start the next revision (preliminary: A, B, C …; construction: 0, 1, 2 …) as a draft', response: Revision, resend: true,
    description: `${DRAWS} Refused while another revision of the drawing is a draft or submitted (DESIGN_REVISION_OPEN).` })
  @SignedIn() @Post('drawings/:publicId/revisions')
  async createRevision(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(CreateRevisionRequest)) body: CreateRevisionRequest, @Res({ passthrough: true }) res: Created) {
    const { revision, created } = await this.drawings.createRevision(ctx, publicId, body);
    if (!created) res.status(200);
    return revision;
  }

  @Doc({ summary: 'One revision: title block, files, QC decision, transmittal, client response', response: Revision, description: SEES })
  @SignedIn() @Get('revisions/:publicId')
  revision(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.drawings.revision(ctx, publicId);
  }

  @Doc({ summary: 'Change a draft revision (a submitted revision never changes: DESIGN_REVISION_LOCKED)', response: Revision, description: DRAWS })
  @SignedIn() @Patch('revisions/:publicId')
  updateRevision(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(UpdateRevisionRequest)) body: UpdateRevisionRequest) {
    return this.drawings.updateRevision(ctx, publicId, body);
  }

  /** multipart/form-data: the AddRevisionFileRequest fields plus the file field `file`. 201 new, 200 resend. */
  @Doc({ summary: 'Attach a file to a draft revision: its PDF (a new one replaces the old), source (CAD) files, the bill of materials', response: Revision,
    resend: true, multipart: 'file', description: `${DRAWS} Types told from the bytes; size: policy design.max_file_mb.` })
  @SignedIn() @Post('revisions/:publicId/files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async addFile(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddRevisionFileRequest)) body: AddRevisionFileRequest, @UploadedFile() file: Upload | undefined, @Res({ passthrough: true }) res: Created) {
    const { revision, created } = await this.drawings.addFile(ctx, publicId, body, file);
    if (!created) res.status(200);
    return revision;
  }

  @Doc({ summary: 'Take a file off a draft revision (kept as history)', response: Revision, description: DRAWS })
  @SignedIn() @Post('revision-files/:publicId/remove') @HttpCode(200)
  removeFile(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.drawings.removeFile(ctx, publicId);
  }

  @Doc({ summary: 'Download a revision\'s file', file: true, description: SEES })
  @SignedIn() @Get('revision-files/:publicId/file')
  async file(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    sendFile(res, await this.drawings.fileDownload(ctx, publicId));
  }

  @Doc({ summary: 'Submit a draft revision for QC (its PDF attached); from then on it never changes', response: Revision,
    description: `${DRAWS} Sent again: nothing changes.` })
  @SignedIn() @Post('revisions/:publicId/submit') @HttpCode(200)
  submit(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.drawings.submit(ctx, publicId);
  }

  @Doc({ summary: 'The QC checklist in force today (policy design.qc_checklist)', response: QcChecklist, description: 'Anyone who sees the company\'s design work.' })
  @SignedIn() @Get('qc/checklist')
  checklist(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(QcChecklistQuery)) q: QcChecklistQuery) {
    return this.qc.checklist(ctx, q);
  }

  /** multipart/form-data (mark-ups in the file field `files`, up to 5; checklist as a JSON array) or JSON. 201 new, 200 resend. */
  @Doc({ summary: 'Decide QC of a submitted revision: approved (every checklist item passed) or changes needed (comments, mark-ups)', response: Revision,
    resend: true, multipart: 'files', description: QC })
  @SignedIn() @Post('revisions/:publicId/qc')
  @UseInterceptors(FilesInterceptor('files', 5, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 5 } }))
  async review(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(QcReviewRequest)) body: QcReviewRequest,
    @UploadedFiles() files: Upload[] | undefined, @Res({ passthrough: true }) res: Created) {
    const { revision, created } = await this.qc.review(ctx, publicId, body, files ?? []);
    if (!created) res.status(200);
    return revision;
  }

  @Doc({ summary: 'Download a QC mark-up file', file: true, description: SEES })
  @SignedIn() @Get('qc-files/:publicId/file')
  async markup(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    sendFile(res, await this.qc.markupFile(ctx, publicId));
  }
}
