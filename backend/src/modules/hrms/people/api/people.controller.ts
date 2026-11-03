import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AddContactRequest, AddEmploymentRequest, CreatePersonRequest, ListPeopleQuery, UpdatePersonRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, Public, RequestContext } from '../../../../platform/http/request-context';
import { PEOPLE } from '../domain/permissions';
import { PeopleService } from '../application/people.service';

export const PublicIdParam = new ZodValidationPipe(z.string().uuid());

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/people')
export class PeopleController {
  constructor(@Inject(PeopleService) private readonly service: PeopleService) {}
  @Public() @Get('health') health() { return this.service.health(); }

  @Permission(PEOPLE.create) @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreatePersonRequest)) body: CreatePersonRequest) {
    return this.service.create(ctx, body);
  }

  @Permission(PEOPLE.view) @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ListPeopleQuery)) query: ListPeopleQuery) {
    return this.service.list(ctx, query);
  }

  @Permission(PEOPLE.view) @Get(':publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Permission(PEOPLE.update) @Patch(':publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(UpdatePersonRequest)) body: UpdatePersonRequest) {
    return this.service.update(ctx, publicId, body);
  }

  @Permission(PEOPLE.manageContacts) @Post(':publicId/contacts')
  addContact(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddContactRequest)) body: AddContactRequest) {
    return this.service.addContact(ctx, publicId, body);
  }

  @Permission(PEOPLE.manageEmployments) @Post(':publicId/employments')
  addEmployment(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AddEmploymentRequest)) body: AddEmploymentRequest) {
    return this.service.addEmployment(ctx, publicId, body);
  }
}
