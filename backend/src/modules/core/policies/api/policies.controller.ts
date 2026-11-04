import { Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import { CreatePolicyRequest, PoliciesQuery, PolicyInForceQuery } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../../platform/http/request-context';
import { MANAGE_POLICIES, PolicyService } from '../application/policy.service';

/** Only: validate input, check permission, call one use case. HR and System admin (scope all). */
@Controller('core/policies')
export class PoliciesController {
  constructor(@Inject(PolicyService) private readonly service: PolicyService) {}

  @Permission(MANAGE_POLICIES) @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PoliciesQuery)) q: PoliciesQuery) {
    return this.service.list(ctx, q);
  }

  @Permission(MANAGE_POLICIES) @Get('in-force')
  inForce(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(PolicyInForceQuery)) q: PolicyInForceQuery) {
    return this.service.inForce(ctx, q);
  }

  /** A new version. 201 new; 200 with the stored version when the same publicId is sent again. */
  @Permission(MANAGE_POLICIES) @Post()
  async create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreatePolicyRequest)) body: CreatePolicyRequest,
    @Res({ passthrough: true }) res: { status(code: number): void }) {
    const { policy, created } = await this.service.create(ctx, body);
    if (!created) res.status(200);
    return policy;
  }
}
