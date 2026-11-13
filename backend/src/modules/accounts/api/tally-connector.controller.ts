import { Body, Controller, Get, Inject, Post, Res } from '@nestjs/common';
import { Outbox, TallyMappingAck, TallyMappingReport, TallyResultAck, TallyResultReport } from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, Permission, RequestContext } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { TallyConnectorService } from '../application/tally-connector.service';
import { ACCOUNTS } from '../domain/permissions';

type Created = { status(code: number): void };
const WHO = 'The Tally connector only (a machine credential with accounts.tally.connector, signed in at POST /api/auth/machine-token). People get 403.';

/** The connector's three routes. Only: validate input, check permission, call one use case. The connector only ever calls out. */
@Controller('accounts/tally')
export class TallyConnectorController {
  constructor(@Inject(TallyConnectorService) private readonly service: TallyConnectorService) {}

  @Doc({ summary: 'Approved Tally batches waiting to be posted (not imported, not on hold), with the ledger names Tally must have', response: Outbox, description: WHO })
  @Permission(ACCOUNTS.tallyConnector) @Get('outbox')
  outbox(@Ctx() ctx: RequestContext) { return this.service.outbox(ctx); }

  @Doc({ summary: 'Report what happened to a batch: Tally\'s answer, or that nothing reached Tally, or that the answer is in doubt', response: TallyResultAck, description: `${WHO} Safe to send again. A result that does not say which entries failed puts the batch on hold for a person (onHold, message).` })
  @Permission(ACCOUNTS.tallyConnector) @Post('results')
  results(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(TallyResultReport)) body: TallyResultReport, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.results(ctx, body);
  }

  @Doc({ summary: 'Report the ledger and cost centre names the ledger map expects that Tally does not have exactly', response: TallyMappingAck, description: WHO })
  @Permission(ACCOUNTS.tallyConnector) @Post('mapping-report')
  mappingReport(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(TallyMappingReport)) body: TallyMappingReport, @Res({ passthrough: true }) res: Created) {
    res.status(200);
    return this.service.mappingReport(ctx, body);
  }
}
