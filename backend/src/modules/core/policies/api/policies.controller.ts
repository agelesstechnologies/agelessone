import { Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import { CreatePolicyRequest, PoliciesQuery, Policy, PolicyInForce, PolicyInForceQuery } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { MANAGE_POLICIES, PolicyService } from '../application/policy.service';

/** Only: validate input, check permission, call one use case. HR and System admin (scope all). */
@Controller('core/policies')
export class PoliciesController {
  constructor(@Inject(PolicyService) private readonly service: PolicyService) {}

  @Doc({ summary: 'Stored policy versions, newest first', response: z.array(Policy) })
  @Permission(MANAGE_POLICIES) @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PoliciesQuery)) q: PoliciesQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'The value of a policy in force on a date (company first, then group, then default)', response: PolicyInForce })
  @Permission(MANAGE_POLICIES) @Get('in-force')
  inForce(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PolicyInForceQuery)) q: PolicyInForceQuery) {
    return this.service.inForce(ctx, q);
  }

  /** A new version. 201 new; 200 with the stored version when the same publicId is sent again. */
  @Doc({ summary: 'Add a new version of a policy (versions are never changed)', response: Policy, resend: true })
  @Permission(MANAGE_POLICIES) @Post()
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreatePolicyRequest)) body: CreatePolicyRequest,
    @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { policy, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return policy;
  }
}
