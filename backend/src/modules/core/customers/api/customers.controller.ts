import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { CreateCustomerRequest, Customer, CustomersQuery, UpdateCustomerRequest } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { CustomersService, MANAGE_CUSTOMERS } from '../application/customers.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
const MANAGES = 'core.customers.manage with scope all (Admin user, System admin, Management). Audited.';

/** Only: validate input, check permission, call one use case. */
@Controller('core/customers')
export class CustomersController {
  constructor(@Inject(CustomersService) private readonly service: CustomersService) {}

  @Doc({ summary: 'The customer list (code and name; group companies show their company code)', response: z.array(Customer),
    description: 'Anyone signed in. q matches the code or the name.' })
  @SignedIn() @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(CustomersQuery)) q: CustomersQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'Add a customer (company: the group company it is, e.g. AE)', response: Customer, resend: true, description: MANAGES })
  @Permission(MANAGE_CUSTOMERS) @Post()
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateCustomerRequest)) body: CreateCustomerRequest,
    @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { customer, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return customer;
  }

  @Doc({ summary: 'Change a customer\'s name, or make it inactive / active (the code and company never change)', response: Customer, description: MANAGES })
  @Permission(MANAGE_CUSTOMERS) @Patch(':publicId')
  update(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string, @Body(new ZodValidationPipe(UpdateCustomerRequest)) body: UpdateCustomerRequest) {
    return this.service.update(ctx, publicId, body);
  }
}
