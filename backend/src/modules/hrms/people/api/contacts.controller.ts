import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { SharedContacts, SharedContactsQuery } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { PEOPLE } from '../domain/permissions';
import { PeopleService } from '../application/people.service';
import { PublicIdParam } from './people.controller';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms/contacts')
export class ContactsController {
  constructor(@Inject(PeopleService) private readonly service: PeopleService) {}

  @Doc({ summary: 'Everyone currently using a phone or email (HR review; people are never merged)', response: SharedContacts })
  @Permission(PEOPLE.reviewContacts) @Get('shared')
  shared(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(SharedContactsQuery)) q: SharedContactsQuery) {
    return this.service.sharedContacts(ctx, q.value);
  }

  @Doc({ summary: 'End a contact (kept as history)' })
  @Permission(PEOPLE.manageContacts) @Post(':id/end') @HttpCode(204)
  end(@Ctx() ctx: RequestContext, @Param('id', PublicIdParam) id: string) {
    return this.service.endContact(ctx, id);
  }
}
