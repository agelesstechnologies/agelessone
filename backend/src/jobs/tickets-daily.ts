import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TicketTimeService } from '../modules/tickets/application/ticket-time.service';

/**
 * The once-a-day tickets job: run it after hrms:daily (Windows Task Scheduler or cron), e.g. every morning at 06:00 IST:
 *   pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend tickets:daily
 * It closes ticket timers whose daily punch-in became a missed punch (open longer than the open-punch limit) as
 * unfinished. Missing daily updates of yesterday are listed for heads at GET /api/tickets/daily-updates/missing.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const closed = await app.get(TicketTimeService, { strict: false }).closeForgotten();
    console.log(`tickets:daily — forgotten ticket timers closed as unfinished: ${closed}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('tickets:daily failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
