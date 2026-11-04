import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { AddCertificateRequest, AddPersonSkillRequest, Certificate, CreateSkillRequest, ExpiringCertificates, ExpiringCertificatesQuery, PersonSkill, Skill, SkillsMatrix, SkillsMatrixQuery, SkillsQuery } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, Public, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { SkillsService } from '../application/skills.service';
import { SKILLS } from '../domain/permissions';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
const MAX_FILE_BYTES = 5 * 1024 * 1024;
type FileResponse = { type(t: string): { send(b: Buffer): void } };

/** Only: validate input, check permission, call one use case. */
@Controller('hrms')
export class SkillsController {
  constructor(@Inject(SkillsService) private readonly service: SkillsService) {}
  @Public() @Get('skills/health') health() { return this.service.health(); }

  @Doc({ summary: 'Skills list of a company, by department', response: z.array(Skill) })
  @SignedIn() @Get('skills')
  skills(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(SkillsQuery)) q: SkillsQuery) {
    return this.service.skills(ctx, q);
  }

  @Doc({ summary: 'Add a skill to the list', response: Skill })
  @Permission(SKILLS.manage) @Post('skills')
  createSkill(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateSkillRequest)) body: CreateSkillRequest) {
    return this.service.createSkill(ctx, body);
  }

  @Doc({ summary: 'Skills matrix: people with skills and certificates (own, team or all)', response: SkillsMatrix })
  @Permission(SKILLS.view) @Get('skills/matrix')
  matrix(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(SkillsMatrixQuery)) q: SkillsMatrixQuery) {
    return this.service.matrix(ctx, q);
  }

  @Doc({ summary: 'Add a person\'s skill or change its level (needs verifying again)', response: PersonSkill })
  @Permission(SKILLS.add) @Post('people/:publicId/skills')
  addPersonSkill(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddPersonSkillRequest)) body: AddPersonSkillRequest) {
    return this.service.addPersonSkill(ctx, publicId, body);
  }

  @Doc({ summary: 'Verify a skill (never your own)', response: PersonSkill })
  @Permission(SKILLS.verify) @Post('person-skills/:publicId/verify') @HttpCode(200)
  verifyPersonSkill(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.verifyPersonSkill(ctx, publicId);
  }

  /** multipart/form-data: the AddCertificateRequest fields plus an optional file field `file`. */
  @Doc({ summary: 'Add a certificate with an optional file (PDF, JPEG or PNG)', response: Certificate, multipart: 'file' })
  @Permission(SKILLS.add) @Post('people/:publicId/certificates')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1 } }))
  addCertificate(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddCertificateRequest)) body: AddCertificateRequest, @UploadedFile() file: { buffer: Buffer } | undefined) {
    return this.service.addCertificate(ctx, publicId, body, file);
  }

  @Doc({ summary: 'Verify a certificate (never your own; not when expired)', response: Certificate })
  @Permission(SKILLS.verify) @Post('certificates/:publicId/verify') @HttpCode(200)
  verifyCertificate(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.verifyCertificate(ctx, publicId);
  }

  @Doc({ summary: 'Certificates expiring within the next days (HR)', response: ExpiringCertificates })
  @Permission(SKILLS.manage) @Get('certificates/expiring')
  expiring(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ExpiringCertificatesQuery)) q: ExpiringCertificatesQuery) {
    return this.service.expiring(ctx, q);
  }

  /** The file itself: the person, whoever may verify their certificates, or HR (checked by the service). */
  @Doc({ summary: 'Download a certificate file (the person, their manager or HR)', file: true })
  @SignedIn() @Get('certificates/:publicId/file')
  async file(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Res() res: FileResponse) {
    const { data, contentType } = await this.service.certificateFile(ctx, publicId);
    res.type(contentType).send(data);
  }
}
