import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TicketTimeService } from '../modules/tickets/application/ticket-time.service';
import { TicketOverdueService } from '../modules/tickets/application/ticket-overdue.service';
import { TicketsService } from '../modules/tickets/application/tickets.service';

/**
 * The once-a-day tickets job: run it after hrms:daily (Windows Task Scheduler or cron), e.g. every morning at 06:00 IST:
 *   pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend tickets:daily
 * It closes ticket timers whose daily punch-in became a missed punch (open longer than the open-punch limit) as
 * unfinished. Missing daily updates of yesterday are listed for heads at GET /api/tickets/daily-updates/missing.
 * It escalates overdue tickets, the way approvals escalate: the department head is alerted the day after the due date,
 * and the CEO after policy tickets.overdue.ceo_after_days days overdue (3 for now); see GET /api/tickets/overdue-alerts.
 * It also alerts the head (and supervisor) of an in-progress ticket whose type needs head approval when that approval is
 * the only thing still missing.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const closed = await app.get(TicketTimeService, { strict: false }).closeForgotten();
    console.log(`tickets:daily — forgotten ticket timers closed as unfinished: ${closed}`);
    const overdue = await app.get(TicketOverdueService, { strict: false }).escalateOverdue();
    console.log(`tickets:daily — overdue tickets: heads alerted ${overdue.alerted}; sent to the CEO ${overdue.sentToCeo}`);
    const waiting = await app.get(TicketsService, { strict: false }).alertAwaitingHeadApproval();
    console.log(`tickets:daily — heads alerted that a ticket waits only for their approval: ${waiting}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('tickets:daily failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
