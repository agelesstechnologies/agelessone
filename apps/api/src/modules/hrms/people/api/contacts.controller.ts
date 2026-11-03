import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { SharedContactsQuery } from '@ageless/core-contracts';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, RequestContext } from '../../../../platform/http/request-context';
import { PeopleService } from '../application/people.service';
import { PublicIdParam } from './people.controller';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/contacts')
export class ContactsController {
  constructor(@Inject(PeopleService) private readonly service: PeopleService) {}

  @Get('shared')
  shared(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(SharedContactsQuery)) q: SharedContactsQuery) {
    return this.service.sharedContacts(ctx, q.value);
  }

  @Post(':id/end') @HttpCode(204)
  end(@Ctx() ctx: RequestContext, @Param('id', PublicIdParam) id: string) {
    return this.service.endContact(ctx, id);
  }
}
