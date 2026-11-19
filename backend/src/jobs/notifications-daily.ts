import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { NotificationEmailService } from '../modules/core/notifications/application/notification-email.service';

/**
 * The morning alert emails: run it from Windows Task Scheduler or cron every day at 08:00 IST:
 *   pnpm --filter @ageless/backend build && pnpm --filter @ageless/backend notifications:daily
 * It sends each person one summary of the unread alerts no email has covered yet, and first sends any urgent alert
 * emails still waiting (the API process normally sends those within seconds). It never prints an address.
 * Run it after hrms:daily, tickets:daily and inventory:daily, so their alerts are in the summary.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const email = app.get(NotificationEmailService, { strict: false });
    const urgent = await email.sendPending();
    console.log(`notifications:daily — urgent emails sent: ${urgent.sent}; failed: ${urgent.failed}; will retry: ${urgent.retrying}; turned off: ${urgent.skipped}; held for quiet hours: ${urgent.held}`);
    const digest = await email.sendDigests();
    console.log(`notifications:daily — summary emails sent: ${digest.people} (${digest.alerts} alerts); failed, tried again tomorrow: ${digest.failed}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('notifications:daily failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
