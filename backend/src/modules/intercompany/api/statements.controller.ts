import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  AnswerStatementRequest, BuildStatementRequest, CloseStatementRequest, CorrectLineRequest, ExplainLineRequest, IcAccess, IcStatement, IcStatementDetail,
  InvoiceStatementRequest, StatementsQuery,
} from '@ageless/shared';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe';
import { Ctx, RequestContext, SignedIn } from '../../../platform/http/request-context';
import { Doc } from '../../../platform/http/doc';
import { StatementsService } from '../application/statements.service';

const PublicIdParam = new ZodValidationPipe(z.string().uuid());
type Created = { status(code: number): void };
const SEES = 'The agreement\'s two heads and two approvers, the heads of departments with time on the statement, and the CEO (scope all); '
  + 'for anyone else it does not exist (404). Costs from payroll are shown to the CEO only. Every step is audited.';
const PREPARER = 'The provider\'s head named on the agreement, or the CEO (intercompany.manage, scope all); others 403 IC_NOT_PREPARER. Audited.';

/** Only: validate input, check permission, call one use case. Monthly statements of intercompany agreements. */
@Controller('intercompany')
export class StatementsController {
  constructor(@Inject(StatementsService) private readonly service: StatementsService) {}

  @Doc({ summary: 'What you see of Intercompany (for the menu): agreements you see, whether you see statements, CEO or not', response: IcAccess })
  @SignedIn() @Get('access')
  access(@Ctx() ctx: RequestContext) {
    return this.service.access(ctx);
  }

  @Doc({ summary: 'Statements you may see, newest month first', response: z.array(IcStatement), description: SEES })
  @SignedIn() @Get('statements')
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(StatementsQuery)) q: StatementsQuery) {
    return this.service.list(ctx, q);
  }

  @Doc({ summary: 'Build a month\'s statement (only once the provider\'s attendance month is locked: IC_MONTH_NOT_LOCKED)', response: IcStatementDetail,
    description: `${PREPARER} Asking again for the same month answers the stored statement with 200.` })
  @SignedIn() @Post('agreements/:publicId/statements')
  async build(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(BuildStatementRequest)) body: BuildStatementRequest, @Res({ passthrough: true }) res: Created) {
    const { statement, created } = await this.service.build(ctx, publicId, body);
    if (!created) res.status(200);
    return statement;
  }

  @Doc({ summary: 'One statement with its lines, each with its tickets', response: IcStatementDetail, description: SEES })
  @SignedIn() @Get('statements/:publicId')
  get(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.get(ctx, publicId);
  }

  @Doc({ summary: 'Rebuild a draft from today\'s time, rates, costs and credits (you become its preparer)', response: IcStatementDetail, description: PREPARER })
  @SignedIn() @Post('statements/:publicId/rebuild') @HttpCode(200)
  rebuild(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.rebuild(ctx, publicId);
  }

  @Doc({ summary: 'Provider approval: a department head with time on it or the CEO, never its preparer; the month is then billed', response: IcStatementDetail,
    description: 'IC_NOT_APPROVER / IC_SELF_APPROVAL (403). Audited.' })
  @SignedIn() @Post('statements/:publicId/approve') @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.approve(ctx, publicId);
  }

  @Doc({ summary: 'Send to the receiver (again after disputes are corrected or explained); the review window starts', response: IcStatementDetail, description: PREPARER })
  @SignedIn() @Post('statements/:publicId/send') @HttpCode(200)
  send(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string) {
    return this.service.send(ctx, publicId);
  }

  @Doc({ summary: 'The receiver\'s answer within the review days: dispute lines with a reason; every other line waiting is accepted', response: IcStatementDetail,
    description: 'The receiver\'s head or approver named on the agreement (IC_NOT_RECEIVER). After the review day: IC_REVIEW_OVER (accepted automatically). Audited.' })
  @SignedIn() @Post('statements/:publicId/answer') @HttpCode(200)
  answer(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(AnswerStatementRequest)) body: AnswerStatementRequest) {
    return this.service.answer(ctx, publicId, body);
  }

  @Doc({ summary: 'Record the invoice of an accepted statement', response: IcStatementDetail, description: PREPARER })
  @SignedIn() @Post('statements/:publicId/invoice') @HttpCode(200)
  invoice(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(InvoiceStatementRequest)) body: InvoiceStatementRequest) {
    return this.service.invoice(ctx, publicId, body);
  }

  @Doc({ summary: 'Record the payment of an invoiced statement and close it', response: IcStatementDetail, description: PREPARER })
  @SignedIn() @Post('statements/:publicId/close') @HttpCode(200)
  close(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(CloseStatementRequest)) body: CloseStatementRequest) {
    return this.service.close(ctx, publicId, body);
  }

  @Doc({ summary: 'Correct a line (reduce or remove, reason required): a disputed line changes; after invoicing it becomes a credit on the next statement',
    response: IcStatementDetail, description: PREPARER })
  @SignedIn() @Post('statement-lines/:publicId/correct') @HttpCode(200)
  correct(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(CorrectLineRequest)) body: CorrectLineRequest) {
    return this.service.correct(ctx, publicId, body);
  }

  @Doc({ summary: 'Keep a disputed line as it is, explaining why', response: IcStatementDetail, description: PREPARER })
  @SignedIn() @Post('statement-lines/:publicId/explain') @HttpCode(200)
  explain(@Ctx() ctx: RequestContext, @Param('publicId', PublicIdParam) publicId: string,
    @Body(new ZodValidationPipe(ExplainLineRequest)) body: ExplainLineRequest) {
    return this.service.explain(ctx, publicId, body);
  }
}
