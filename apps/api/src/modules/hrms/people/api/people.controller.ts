import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AddEmploymentRequest, CreatePersonRequest, ListPeopleQuery } from '@ageless/core-contracts';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Public, RequestContext } from '../../../../platform/http/request-context';
import { PeopleService } from '../application/people.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/people')
export class PeopleController {
  constructor(@Inject(PeopleService) private readonly service: PeopleService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreatePersonRequest)) body: CreatePersonRequest) {
    return this.service.create(ctx, body);
  }

  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ListPeopleQuery)) query: ListPeopleQuery) {
    return this.service.list(ctx, query);
  }

  @Get(':publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Post(':publicId/employments')
  addEmployment(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddEmploymentRequest)) body: AddEmploymentRequest) {
    return this.service.addEmployment(ctx, publicId, body);
  }
}
