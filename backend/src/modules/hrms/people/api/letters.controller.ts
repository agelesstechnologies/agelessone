import { Body, Controller, Get, Inject, Param, Post, Put, Res } from '@nestjs/common';
import { z } from 'zod';
import { IssuedLetter, IssueLetterRequest, LetterCompanyParam, LetterDraft, LetterTemplate, SaveLetterTemplateRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, MANAGEMENT, Permission, RequestContext } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { LettersService } from '../application/letters.service';
import { LETTERS } from '../domain/permissions';
import { PublicIdParam } from './people.controller';

type Created = { status(code: number): void };
type FileReply = { setHeader(k: string, v: string): void; send(b: Buffer | string): void };
const WHO = 'HR and Management (hrms.letters.manage, scope all). Others: 403.';
const CompanyPipe = new ZodValidationPipe(LetterCompanyParam);

/** Joining letters. Only: validate input, check permission, call one use case. */
@Controller('hrms')
export class LettersController {
  constructor(@Inject(LettersService) private readonly service: LettersService) {}

  @Doc({ summary: "A company's joining letter template (the built-in one until HR saves its own)", response: LetterTemplate, description: WHO })
  @Permission(LETTERS.manage, MANAGEMENT) @Get('letter-templates/:company/joining')
  template(@Ctx() ctx: RequestContext, @Param('company', CompanyPipe) company: string) {
    return this.service.template(ctx, company);
  }

  @Doc({ summary: "Save a company's joining letter template ({{name}}-style fill-ins; unknown ones are refused)", response: LetterTemplate, description: WHO })
  @Permission(LETTERS.manage, MANAGEMENT) @Put('letter-templates/:company/joining')
  saveTemplate(@Ctx() ctx: RequestContext, @Param('company', CompanyPipe) company: string,
    @Body(new ZodValidationPipe(SaveLetterTemplateRequest)) body: SaveLetterTemplateRequest) {
    return this.service.saveTemplate(ctx, company, body);
  }

  @Doc({ summary: "The joining letter for one job: the company's template filled with the job's details, to adjust before issuing", response: LetterDraft, description: WHO })
  @Permission(LETTERS.manage, MANAGEMENT) @Get('employments/:publicId/joining-letter')
  draft(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.draft(ctx, publicId);
  }

  @Doc({ summary: 'Issue a joining letter: keep this exact text (never changed) for the job', response: IssuedLetter, resend: true, description: WHO })
  @Permission(LETTERS.manage, MANAGEMENT) @Post('employments/:publicId/joining-letters')
  async issue(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(IssueLetterRequest)) body: IssueLetterRequest, @Res({ passthrough: true }) res: Created) {
    const { letter, created } = await this.service.issue(ctx, publicId, body);
    if (!created) res.status(200);
    return letter;
  }

  @Doc({ summary: 'Joining letters issued for one job, newest first', response: z.array(IssuedLetter), description: WHO })
  @Permission(LETTERS.manage, MANAGEMENT) @Get('employments/:publicId/joining-letters')
  issued(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.issuedForJob(ctx, publicId);
  }

  @Doc({ summary: 'An issued joining letter as a PDF', file: true, description: WHO })
  @Permission(LETTERS.manage, MANAGEMENT) @Get('letters/:publicId/pdf')
  async pdf(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileReply) {
    const { name, data } = await this.service.pdf(ctx, publicId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(data);
  }
}
