import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CreateMachineCredentialRequest, CreatedMachineCredential, MachineCredential } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { MachineCredentialsService } from '../application/machine-credentials.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
const MANAGE = 'core.users.manage';

/** Only: validate input, check permission, call one use case. */
@Controller('core/machine-credentials')
export class MachineCredentialsController {
  constructor(@Inject(MachineCredentialsService) private readonly service: MachineCredentialsService) {}

  @Doc({ summary: 'Make a machine credential (for the Tally connector). The secret is in this answer only', response: CreatedMachineCredential, description: 'core.users.manage (scope all).' })
  @Permission(MANAGE) @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateMachineCredentialRequest)) body: CreateMachineCredentialRequest) { return this.service.create(ctx, body); }

  @Doc({ summary: 'Machine credentials of the tenant (never their secrets)', response: z.array(MachineCredential), description: 'core.users.manage (scope all).' })
  @Permission(MANAGE) @Get()
  list(@Ctx() ctx: RequestContext) { return this.service.list(ctx); }

  @Doc({ summary: 'Revoke a machine credential; its tokens stop working at once', response: MachineCredential, description: 'core.users.manage (scope all).' })
  @Permission(MANAGE) @Post(':publicId/revoke') @HttpCode(200)
  revoke(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) { return this.service.revoke(ctx, publicId); }
}
