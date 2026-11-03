import { Body, Controller, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ExitEmploymentRequest, UpdateEmploymentRequest } from '@ageless/core-contracts';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, RequestContext } from '../../../../platform/http/request-context';
import { PeopleService } from '../application/people.service';
import { PublicIdParam } from './people.controller';

/** Only: validate input, check permission, call one use case. Each answer is the updated person. */
@Controller('hrms/employments')
export class EmploymentsController {
  constructor(@Inject(PeopleService) private readonly service: PeopleService) {}

  @Patch(':publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UpdateEmploymentRequest)) body: UpdateEmploymentRequest) {
    return this.service.updateEmployment(ctx, publicId, body);
  }

  @Post(':publicId/exit') @HttpCode(200)
  exit(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ExitEmploymentRequest)) body: ExitEmploymentRequest) {
    return this.service.exitEmployment(ctx, publicId, body);
  }
}
