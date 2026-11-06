import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApprovalsInbox, Dashboard, DashboardQuery } from '@ageless/shared';
import { ZodValidationPipe } from '../../../../platform/http/zod-validation.pipe';
import { Ctx, MANAGEMENT, Permission, RequestContext, SignedIn } from '../../../../platform/http/request-context';
import { Doc } from '../../../../platform/http/doc';
import { DASHBOARD } from '../domain/permissions';
import { ApprovalsInboxService } from '../application/approvals-inbox.service';
import { DashboardService } from '../application/dashboard.service';

/** Only: validate input, check permission, call one use case. */
@Controller('hrms')
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly dashboards: DashboardService,
    @Inject(ApprovalsInboxService) private readonly inbox: ApprovalsInboxService,
  ) {}

  @Doc({ summary: 'Everything waiting for my decision (leave, expenses, corrections, overtime), oldest first, with counts per type', response: ApprovalsInbox })
  @SignedIn() @Get('approvals/mine')
  mine(@Ctx() ctx: RequestContext) {
    return this.inbox.mine(ctx);
  }

  @Doc({ summary: 'HRMS dashboard for a month: your team (supervisor) or everyone (HR, Management); one company or all you may see', response: Dashboard })
  @Permission(DASHBOARD.view, MANAGEMENT) @Get('dashboard')
  dashboard(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DashboardQuery)) q: DashboardQuery) {
    return this.dashboards.dashboard(ctx, q);
  }
}
