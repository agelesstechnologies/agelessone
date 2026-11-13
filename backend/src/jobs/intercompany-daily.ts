import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { StatementsService } from '../modules/intercompany/application/statements.service';

/**
 * The once-a-day intercompany job (Windows Task Scheduler or cron), e.g. every morning at 06:00 IST:
 *   pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend intercompany:daily
 * A statement sent to the receiver and not answered by the end of its review day (sent date + the agreement's review
 * days) is accepted automatically; the audit log records it with no actor.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const accepted = await app.get(StatementsService, { strict: false }).acceptOverdue();
    console.log(`intercompany:daily — statements accepted automatically (no answer within the review days): ${accepted}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('intercompany:daily failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
