import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SkillsService } from '../modules/hrms/skills/application/skills.service';
import { ApprovalsInboxService } from '../modules/hrms/reports/application/approvals-inbox.service';
import { LeaveService } from '../modules/hrms/leave/application/leave.service';

/**
 * The once-a-day HRMS job: run it from Windows Task Scheduler or cron, e.g. every morning at 06:00 IST:
 *   pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend hrms:daily
 * It stores certificates past their date as expired and counts those expiring within 30 days
 * (HR sees that list at GET /api/hrms/certificates/expiring). Notifications come later. It adds each month's leave
 * entitlement (1 sick + 1 earned by default) and, in a new year, lapses unused sick leave.
 * It also sends leave, expense, correction and overtime requests with no decision after the company's
 * escalate_after_days (policy hrms.approvals.escalate_after_days, 5 for now) to the CEO; the approver may still decide them.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(SkillsService, { strict: false }).runDaily();
    console.log(`hrms:daily — certificates marked expired: ${result.markedExpired}; expiring within 30 days: ${result.expiringWithin30Days}`);
    const sent = await app.get(ApprovalsInboxService, { strict: false }).escalateWaiting();
    console.log(`hrms:daily — requests sent to the CEO after waiting too long: ${sent}`);
    const leave = await app.get(LeaveService, { strict: false }).runMonthlyLeave();
    console.log(`hrms:daily — leave entitlement rows added: ${leave.granted}; year-end lapses: ${leave.lapsed}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('hrms:daily failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
