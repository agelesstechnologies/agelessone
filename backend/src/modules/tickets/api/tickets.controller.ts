import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import {
  AddExternalStaffRequest, ApproveReassignRequest, AssignTicketRequest, AttachmentRequest, EndExternalStaffRequest, ExternalAttendance, ExternalAttendanceQuery,
  ExternalStaff, ChecklistResultRequest, CreateTicketRequest, LinkTicketRequest, MyTicketsQuery, NumberSeries, NumberSeriesRequest, ReasonRequest,
  ReassignmentRequest, ReassignRequestsQuery, RecordExternalAttendanceRequest, SignoffRequest, TicketDetail, TicketsQuery, TicketSummary, UpdateTicketRequest,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { TicketsService } from '../application/tickets.service';
import { MAX_TICKET_FILE_BYTES, TicketUpload, TicketWorkService } from '../application/ticket-work.service';
import { TicketFullReportService } from '../application/ticket-full-report.service';
import { TICKETS } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
const CompanyParam = new ZodValidationPipe(z.string().trim().min(1).max(12));
type Created = { status(code: number): void };
type FileReply = { setHeader(k: string, v: string): void; send(b: Buffer): void };
const SEE = [TICKETS.view, TICKETS.work, TICKETS.manage] as [string, ...string[]];
const WORK = [TICKETS.work, TICKETS.manage] as [string, ...string[]];
const UPLOAD = { limits: { fileSize: MAX_TICKET_FILE_BYTES, files: 1 } };
const MANAGE = 'Admin user and Management: any ticket. A department head (or the ticket\'s supervisor): their tickets.';
const WORKERS = 'Its assignees (tickets.work), the department head / supervisor, admin user and Management.';

/** Only: validate input, check permission, call one use case. Static paths come before /:publicId. */
@Controller('tickets')
export class TicketsController {
  constructor(
    @Inject(TicketsService) private readonly service: TicketsService,
    @Inject(TicketWorkService) private readonly work: TicketWorkService,
    @Inject(TicketFullReportService) private readonly report: TicketFullReportService,
  ) {}

  @Doc({ summary: 'My tickets: the ones I am currently assigned to', response: z.array(TicketSummary) })
  @Permission(...SEE) @Get('mine')
  mine(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(MyTicketsQuery)) q: MyTicketsQuery) {
    return this.service.mine(ctx, q);
  }

  @Doc({ summary: 'Each company\'s ticket number prefix and next number', response: z.array(NumberSeries) })
  @Permission(TICKETS.numbering) @Get('number-series')
  numberSeries(@Ctx() ctx: RequestContext) {
    return this.service.numberSeries(ctx);
  }

  @Doc({ summary: 'Set a company\'s number prefix and next number (imported Froid tickets keep theirs)', response: NumberSeries })
  @Permission(TICKETS.numbering) @Put('number-series/:company')
  setNumberSeries(@Ctx() ctx: RequestContext, @Param('company', CompanyParam) company: string,
    @Body(new ZodValidationPipe(NumberSeriesRequest)) body: NumberSeriesRequest) {
    return this.service.setNumberSeries(ctx, company, body);
  }

  @Doc({ summary: 'Reassignment requests I decide (Management: all)', response: z.array(ReassignmentRequest) })
  @SignedIn() @Get('reassign-requests')
  reassignRequests(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ReassignRequestsQuery)) q: ReassignRequestsQuery) {
    return this.work.reassignRequests(ctx, q);
  }

  @Doc({ summary: 'Approve a reassignment and pick who takes over', response: TicketDetail,
    description: 'The named approver or Management; never the person who asked. Nobody but Management picks themselves.' })
  @SignedIn() @Post('reassign-requests/:publicId/approve') @HttpCode(200)
  approveReassign(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ApproveReassignRequest)) body: ApproveReassignRequest) {
    return this.work.approveReassign(ctx, publicId, body);
  }

  @Doc({ summary: 'Reject a reassignment (reason required)', response: TicketDetail })
  @SignedIn() @Post('reassign-requests/:publicId/reject') @HttpCode(200)
  rejectReassign(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(ReasonRequest)) body: ReasonRequest) {
    return this.work.rejectReassign(ctx, publicId, body.reason);
  }

  @Doc({ summary: 'Tickets I may see, with filters', response: z.array(TicketSummary),
    description: 'HR, admin user and Management: every ticket. Heads: their departments\' and supervised tickets. Staff: tickets they are assigned to.' })
  @Permission(...SEE) @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(TicketsQuery)) q: TicketsQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'Create a ticket (optionally with its assignees)', response: TicketDetail, resend: true, description: 'A supervisor (tickets.create): any department of a company they work in. A department head: their departments. Management (CEO) and Admin user do not create tickets.' })
  @Permission(TICKETS.create, TICKETS.manage) @Post()
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateTicketRequest)) body: CreateTicketRequest, @Res({ passthrough: true }) res: Created) {
    const { ticket, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return ticket;
  }

  @Doc({ summary: 'One ticket: details, assignees, checklist, attachments, sign-off, links, timeline', response: TicketDetail })
  @Permission(...SEE) @Get(':publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Doc({ summary: 'Change details (not after completion or cancellation)', response: TicketDetail, description: MANAGE })
  @Permission(TICKETS.manage, TICKETS.site) @Patch(':publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(UpdateTicketRequest)) body: UpdateTicketRequest) {
    return this.service.update(ctx, publicId, body);
  }

  @Doc({ summary: 'Set the assignees (whole list, exactly one primary)', response: TicketDetail, description: MANAGE })
  @Permission(TICKETS.manage) @Put(':publicId/assignees')
  assign(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(AssignTicketRequest)) body: AssignTicketRequest) {
    return this.service.assign(ctx, publicId, body.assignees);
  }

  @Doc({ summary: 'Start work: assigned → in progress (the first ticket punch-in does the same)', response: TicketDetail, description: WORKERS })
  @Permission(...WORK) @Post(':publicId/start') @HttpCode(200)
  start(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.start(ctx, publicId);
  }

  @Doc({ summary: 'Put on hold (reason required)', response: TicketDetail, description: MANAGE })
  @Permission(TICKETS.manage, TICKETS.site) @Post(':publicId/hold') @HttpCode(200)
  hold(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(ReasonRequest)) body: ReasonRequest) {
    return this.service.hold(ctx, publicId, body.reason);
  }

  @Doc({ summary: 'Resume a ticket on hold', response: TicketDetail, description: MANAGE })
  @Permission(TICKETS.manage, TICKETS.site) @Post(':publicId/resume') @HttpCode(200)
  resume(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.resume(ctx, publicId);
  }

  @Doc({ summary: 'Complete (checks the type version\'s completion rules)', response: TicketDetail,
    description: `The primary assignee, the department head / supervisor, admin user or Management. ${'Missing items: 409 TICKETS_COMPLETION_INCOMPLETE with details.missing.'}` })
  @Permission(...WORK) @Post(':publicId/complete') @HttpCode(200)
  complete(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.complete(ctx, publicId);
  }

  @Doc({ summary: 'Cancel (reason required)', response: TicketDetail, description: MANAGE })
  @Permission(TICKETS.manage) @Post(':publicId/cancel') @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(ReasonRequest)) body: ReasonRequest) {
    return this.service.cancel(ctx, publicId, body.reason);
  }

  @Doc({ summary: 'Reopen a completed ticket (reason required)', response: TicketDetail, description: MANAGE })
  @Permission(TICKETS.manage) @Post(':publicId/reopen') @HttpCode(200)
  reopen(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(ReasonRequest)) body: ReasonRequest) {
    return this.service.reopen(ctx, publicId, body.reason);
  }

  @Doc({ summary: 'Answer a checklist item (pass, fail or na)', response: TicketDetail, description: WORKERS })
  @Permission(...WORK) @Post(':publicId/checklist') @HttpCode(200)
  checklist(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ChecklistResultRequest)) body: ChecklistResultRequest) {
    return this.work.checklist(ctx, publicId, body);
  }

  @Doc({ summary: 'Upload a photo (JPEG, PNG) or file (also PDF), up to 10 MB', response: TicketDetail, multipart: 'file', description: WORKERS })
  @Permission(...WORK) @Post(':publicId/attachments')
  @UseInterceptors(FileInterceptor('file', UPLOAD))
  attach(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(AttachmentRequest)) body: AttachmentRequest,
    @UploadedFile() file: TicketUpload | undefined) {
    return this.work.attach(ctx, publicId, body.kind, file);
  }

  @Doc({ summary: "The ticket's external staff (outside workers), earliest first", response: z.array(ExternalStaff) })
  @Permission(...SEE) @Get(':publicId/external-staff')
  externalStaff(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.work.externalStaff(ctx, publicId);
  }

  @Doc({ summary: 'Add an outside worker (name, phone, agency, trade, days on site) with an optional photo (JPEG, PNG)', response: z.array(ExternalStaff),
    multipart: 'photo', resend: true, description: "The ticket's on-site supervisor (tickets.site), a manager or the department head." })
  @Permission(TICKETS.manage, TICKETS.site) @Post(':publicId/external-staff')
  @UseInterceptors(FileInterceptor('photo', UPLOAD))
  addExternalStaff(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddExternalStaffRequest)) body: AddExternalStaffRequest, @UploadedFile() photo: TicketUpload | undefined) {
    return this.work.addExternalStaff(ctx, publicId, body, photo);
  }

  @Doc({ summary: "An outside worker's last day on site", response: z.array(ExternalStaff) })
  @Permission(TICKETS.manage, TICKETS.site) @Post(':publicId/external-staff/:staffId/end') @HttpCode(200)
  endExternalStaff(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Param('staffId', PublicIdParam) staffId: string,
    @Body(new ZodValidationPipe(EndExternalStaffRequest)) body: EndExternalStaffRequest) {
    return this.work.endExternalStaff(ctx, publicId, staffId, body);
  }

  @Doc({ summary: "The outside workers' daily attendance on this ticket (default the last 31 days; at most 92)", response: z.array(ExternalAttendance),
    description: 'Anyone who may see the ticket. Newest day first, then by name. Range too long or reversed: 400 TICKETS_EXTERNAL_ATTENDANCE_RANGE.' })
  @Permission(...SEE) @Get(':publicId/external-staff/attendance')
  externalAttendance(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Query(new ZodValidationPipe(ExternalAttendanceQuery)) q: ExternalAttendanceQuery) {
    return this.work.externalAttendance(ctx, publicId, q);
  }

  @Doc({ summary: "Record or correct an outside worker's attendance for one work day (present, half day, absent; optional times and note)",
    response: ExternalAttendance,
    description: 'The person who added the worker, while they still run this ticket\'s site work, or the ticket\'s managers (department head, Manager, '
      + 'admin user, Management); anyone else 403 TICKETS_FORBIDDEN. One record per worker and day: sending a recorded day again corrects it; the same '
      + 'values sent again (a resend) change nothing. Days: within the worker\'s days on site, not after today (IST), at most '
      + 'tickets.external_attendance.backdate_days back (policy, default 7); not on a cancelled ticket. Errors: 400 TICKETS_EXTERNAL_ATTENDANCE_FUTURE, '
      + '_BEFORE_START, _AFTER_END, _TOO_OLD; 409 TICKETS_EXTERNAL_ATTENDANCE_TICKET_CANCELLED; 409 TICKETS_DUPLICATE_ID.' })
  @Permission(TICKETS.manage, TICKETS.site) @Put(':publicId/external-staff/:staffId/attendance')
  recordExternalAttendance(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Param('staffId', PublicIdParam) staffId: string,
    @Body(new ZodValidationPipe(RecordExternalAttendanceRequest)) body: RecordExternalAttendanceRequest) {
    return this.work.recordExternalAttendance(ctx, publicId, staffId, body);
  }

  @Doc({ summary: "An outside worker's photo", file: true })
  @Permission(...SEE) @Get(':publicId/external-staff/:staffId/photo')
  async externalStaffPhoto(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Param('staffId', PublicIdParam) staffId: string, @Res() res: FileReply) {
    const f = await this.work.externalStaffPhoto(ctx, publicId, staffId);
    res.setHeader('Content-Type', f.type);
    res.setHeader('Content-Disposition', `inline; filename="${f.name}"`);
    res.send(f.data);
  }

  @Doc({ summary: 'The full report of one ticket as a PDF: everything in it, photos included', file: true,
    description: 'tickets.report: the department head, the Manager who created or supervises the ticket, or Management (any ticket). Anyone else who '
      + 'sees the ticket: 403 TICKETS_FORBIDDEN; unknown or not visible: 404 TICKETS_NOT_FOUND. A file named <number>-report.pdf; each download is '
      + 'logged in the ticket history (report_downloaded).' })
  @Permission(TICKETS.report) @Get(':publicId/report.pdf')
  async fullReport(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    const f = await this.report.pdf(ctx, publicId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
    res.send(f.data);
  }

  @Doc({ summary: 'Download an attachment', file: true })
  @Permission(...SEE) @Get(':publicId/attachments/:attachmentId')
  async download(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Param('attachmentId', PublicIdParam) attachmentId: string, @Res() res: FileReply) {
    const f = await this.work.download(ctx, publicId, attachmentId);
    res.setHeader('Content-Type', f.type);
    res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
    res.send(f.data);
  }

  @Doc({ summary: 'Record the customer\'s sign-off: signer and a photo of the signed sheet', response: TicketDetail, multipart: 'photo', description: WORKERS })
  @Permission(...WORK) @Post(':publicId/signoffs')
  @UseInterceptors(FileInterceptor('photo', UPLOAD))
  signoff(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(SignoffRequest)) body: SignoffRequest,
    @UploadedFile() photo: TicketUpload | undefined) {
    return this.work.signoff(ctx, publicId, body, photo);
  }

  @Doc({ summary: 'Head approval (department head, supervisor or Management; never an assignee)', response: TicketDetail })
  @Permission(TICKETS.manage) @Post(':publicId/head-approval') @HttpCode(200)
  headApprove(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.work.headApprove(ctx, publicId);
  }

  @Doc({ summary: 'Link to another ticket of the same company (follows: same project; or rework_of)', response: TicketDetail, description: MANAGE })
  @Permission(TICKETS.manage) @Post(':publicId/links')
  link(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(LinkTicketRequest)) body: LinkTicketRequest) {
    return this.work.link(ctx, publicId, body);
  }

  @Doc({ summary: 'Ask to be reassigned (assignees; reason required)', response: TicketDetail })
  @Permission(TICKETS.work) @Post(':publicId/reassign-requests')
  requestReassign(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(ReasonRequest)) body: ReasonRequest) {
    return this.work.requestReassign(ctx, publicId, body.reason);
  }
}
