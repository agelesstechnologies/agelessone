import { Body, Controller, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { PrivateDetails, UpdatePrivateRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { PRIVATE } from '../domain/permissions';
import { PrivateService } from '../application/private.service';
import { PublicIdParam } from './people.controller';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/people')
export class PrivateController {
  constructor(@Inject(PrivateService) private readonly service: PrivateService) {}

  @Doc({ summary: 'HR: set or clear Aadhaar / PAN (answers masked; audited without the values)', response: PrivateDetails })
  @Permission(PRIVATE.manage) @Put(':publicId/private')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UpdatePrivateRequest)) body: UpdatePrivateRequest) {
    return this.service.update(ctx, publicId, body);
  }

  @Doc({ summary: 'Management: Aadhaar, PAN and bank accounts in full; every reveal is written to the audit log', response: PrivateDetails })
  @Permission(PRIVATE.reveal) @Post(':publicId/private/reveal') @HttpCode(200)
  reveal(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.reveal(ctx, publicId);
  }
}
