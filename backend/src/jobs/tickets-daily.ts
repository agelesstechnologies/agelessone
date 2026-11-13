import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TicketTimeService } from '../modules/tickets/application/ticket-time.service';
import { TicketOverdueService } from '../modules/tickets/application/ticket-overdue.service';

/**
 * The once-a-day tickets job: run it after hrms:daily (Windows Task Scheduler or cron), e.g. every morning at 06:00 IST:
 *   pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend tickets:daily
 * It closes ticket timers whose daily punch-in became a missed punch (open longer than the open-punch limit) as
 * unfinished. Missing daily updates of yesterday are listed for heads at GET /api/tickets/daily-updates/missing.
 * It escalates overdue tickets, the way approvals escalate: the department head is alerted the day after the due date,
 * and the CEO after policy tickets.overdue.ceo_after_days days overdue (3 for now); see GET /api/tickets/overdue-alerts.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const closed = await app.get(TicketTimeService, { strict: false }).closeForgotten();
    console.log(`tickets:daily — forgotten ticket timers closed as unfinished: ${closed}`);
    const overdue = await app.get(TicketOverdueService, { strict: false }).escalateOverdue();
    console.log(`tickets:daily — overdue tickets: heads alerted ${overdue.alerted}; sent to the CEO ${overdue.sentToCeo}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('tickets:daily failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
