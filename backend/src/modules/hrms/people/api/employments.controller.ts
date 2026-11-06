import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ExitEmploymentRequest, PersonDetail, UpdateEmploymentRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { PEOPLE } from '../domain/permissions';
import { PeopleService } from '../application/people.service';
import { PublicIdParam } from './people.controller';

/** Offer letters up to 5 MB. */
const MAX_OFFER_LETTER_BYTES = 5 * 1024 * 1024;

/** Only: validate input, check permission, call one use case. Each answer is the updated person. */
@Controller('hrms/employments')
export class EmploymentsController {
  constructor(@Inject(PeopleService) private readonly service: PeopleService) {}

  @Doc({ summary: 'Change manager, department (code stays), designation, or make primary', response: PersonDetail })
  @Permission(PEOPLE.updateEmployments) @Patch(':publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UpdateEmploymentRequest)) body: UpdateEmploymentRequest) {
    return this.service.updateEmployment(ctx, publicId, body);
  }

  @Doc({ summary: 'Exit a job; with no active job left the person becomes inactive', response: PersonDetail })
  @Permission(PEOPLE.manageEmployments) @Post(':publicId/exit') @HttpCode(200)
  exit(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ExitEmploymentRequest)) body: ExitEmploymentRequest) {
    return this.service.exitEmployment(ctx, publicId, body);
  }

  /** joining → active (the person has started). */
  @Doc({ summary: 'A joining employment becomes active', response: PersonDetail })
  @Permission(PEOPLE.manageEmployments) @Post(':publicId/activate') @HttpCode(200)
  activate(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.activate(ctx, publicId);
  }

  /** multipart/form-data with the file field `file` (PDF, JPEG or PNG). */
  @Doc({ summary: 'Upload the offer letter (PDF, JPEG or PNG)', response: PersonDetail, multipart: 'file' })
  @Permission(PEOPLE.manageEmployments) @Post(':publicId/offer-letter') @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_OFFER_LETTER_BYTES, files: 1 } }))
  uploadOfferLetter(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @UploadedFile() file: { buffer: Buffer } | undefined) {
    return this.service.uploadOfferLetter(ctx, publicId, file);
  }

  /** The file itself; the person or whoever may manage their employments (checked by the service). */
  @Doc({ summary: 'Download the offer letter (the person, or who may manage their jobs)', file: true })
  @SignedIn() @Get(':publicId/offer-letter')
  async offerLetter(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Res() res: { type(t: string): { send(b: Buffer): void } }) {
    const { data, contentType } = await this.service.offerLetter(ctx, publicId);
    res.type(contentType).send(data);
  }
}
